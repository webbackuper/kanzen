// Temps réel : Socket.io authentifié par le cookie de session, un salon par tableau et un par wiki d'espace.
import { Server } from 'socket.io';
import { createWikiAccess } from './lib/wikiAccess.js';

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((c) => c.trim().split('=')).filter((p) => p.length === 2)
    .map(([k, v]) => [k, decodeURIComponent(v)]));
}

const originOf = (req) => {
  const v = req?.headers?.['x-socket-id'];
  return typeof v === 'string' && /^[\w-]{1,64}$/.test(v) ? v : null;
};

export function attachRealtime(fastify, { sessions, authz, cfg }) {
  const io = new Server(fastify.server, {
    path: '/socket.io',
    serveClient: false,
    cors: { origin: false }, // même origine uniquement
    allowRequest: (req, cb) => {
      // Refus des connexions cross-origin (CSWSH)
      const origin = req.headers.origin;
      cb(null, !origin || !cfg.publicUrl || origin === new URL(cfg.publicUrl).origin);
    },
  });

  io.use(async (socket, next) => {
    try {
      const token = parseCookies(socket.handshake.headers.cookie)[cfg.session.cookieName];
      const s = await sessions.resolve(token);
      if (!s) return next(new Error('unauthorized'));
      socket.data.user = s.user;
      socket.data.token = token;
      next();
    } catch (err) {
      next(err);
    }
  });

  io.on('connection', (socket) => {
    socket.on('board:join', async (boardId, ack) => {
      try {
        if (typeof boardId !== 'string') throw new Error('bad');
        await authz.check(socket.data.user, 'board', boardId, 'VIEWER');
        for (const room of socket.rooms) if (room.startsWith('board:')) socket.leave(room);
        socket.join(`board:${boardId}`);
        ack?.({ ok: true });
      } catch {
        ack?.({ ok: false });
      }
    });
    // Wiki : un salon par espace de travail (arborescence et pages ouvertes)
    socket.on('wiki:join', async (workspaceId, ack) => {
      try {
        if (typeof workspaceId !== 'string') throw new Error('bad');
        await authz.check(socket.data.user, 'workspace', workspaceId, 'VIEWER');
        for (const room of socket.rooms) if (room.startsWith('wiki:')) socket.leave(room);
        socket.join(`wiki:${workspaceId}`);
        ack?.({ ok: true });
      } catch {
        ack?.({ ok: false });
      }
    });
  });

  // --- Revalidation des websockets ouvertes ---
  // Une websocket survit à la requête qui l'a ouverte : sans contrôle, un compte désactivé (synchronisation AD,
  // administrateur), une session révoquée ou expirée, ou un membre retiré d'un espace continuerait de recevoir les
  // événements et de pousser des modifications de co-édition. Chaque socket est donc revérifiée périodiquement
  // (session et droits sur chaque salon rejoint) et déconnectée au premier écart.
  const wikiAccess = createWikiAccess(fastify.prisma, authz);
  async function stillAllowed(socket) {
    if (!(await sessions.isValid(socket.data.token))) return false;
    const user = await fastify.prisma.user.findUnique({ where: { id: socket.data.user.id } });
    if (!user || user.disabled) return false;
    socket.data.user = user; // rôle d'instance à jour (groupe admin AD, décision d'un administrateur)
    for (const room of socket.rooms) {
      const [kind, id] = room.split(/:(.*)/s);
      try {
        if (kind === 'board') await authz.check(user, 'board', id, 'VIEWER');
        else if (kind === 'wiki') await authz.check(user, 'workspace', id, 'VIEWER');
        else if (kind === 'wiki-collab') await wikiAccess.checkPage(user, id, 'EDITOR');
      } catch {
        return false;
      }
    }
    return true;
  }
  let sweeping = false;
  const sweep = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      for (const socket of [...io.sockets.sockets.values()]) {
        const ok = await stillAllowed(socket).catch(() => true); // base indisponible : pas de déconnexion en masse
        if (!ok) socket.disconnect(true);
      }
    } finally {
      sweeping = false;
    }
  };
  const sweepTimer = setInterval(() => { sweep().catch((err) => fastify.log.warn({ err }, 'revalidation des websockets')); }, (cfg.realtimeRecheckSeconds ?? 60) * 1000);
  sweepTimer.unref();

  return {
    io,
    sweep,
    stop: () => clearInterval(sweepTimer),
    /** Révocation immédiate : ferme les websockets d'un utilisateur (désactivation, révocation des sessions). */
    disconnectUser: (userId) => {
      for (const socket of io.sockets.sockets.values()) if (socket.data.user?.id === userId) socket.disconnect(true);
    },
    // origin : identifiant de la websocket de l'auteur (en-tête X-Socket-Id), pour qu'il ignore l'écho
    // d'une modification déjà appliquée chez lui (mise à jour optimiste)
    boardChanged: (boardId, reason, req) => io.to(`board:${boardId}`).emit('board:updated', { boardId, reason, origin: originOf(req) }),
    wikiChanged: (workspaceId, event) => io.to(`wiki:${workspaceId}`).emit('wiki:changed', { workspaceId, ...event }),
  };
}
