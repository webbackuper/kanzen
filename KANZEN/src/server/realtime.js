// Temps réel : Socket.io authentifié par le cookie de session, un salon par tableau et un par wiki d'espace.
import { Server } from 'socket.io';

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((c) => c.trim().split('=')).filter((p) => p.length === 2)
    .map(([k, v]) => [k, decodeURIComponent(v)]));
}

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

  return {
    io,
    boardChanged: (boardId, reason) => io.to(`board:${boardId}`).emit('board:updated', { boardId, reason }),
    wikiChanged: (workspaceId, event) => io.to(`wiki:${workspaceId}`).emit('wiki:changed', { workspaceId, ...event }),
  };
}
