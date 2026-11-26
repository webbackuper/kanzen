// Co-édition des pages du wiki : un document Yjs par page ouverte en édition, relayé par Socket.io.
// Le serveur garde l'état en mémoire tant qu'au moins un éditeur est connecté ; l'enregistrement reste
// explicite (PATCH /wiki/pages/:id, validé par sanitizeDoc). Quand le dernier éditeur part, le document
// en mémoire est oublié et la session suivante repart du contenu enregistré.
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';

const MAX_UPDATE = 2 * 1024 * 1024;
const room = (pageId) => `wiki-collab:${pageId}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Données binaires reçues de Socket.io (Buffer, ArrayBuffer ou vue) -> Uint8Array, avec contrôle de taille. */
function bytes(v) {
  let u;
  if (v instanceof Uint8Array) u = v;
  else if (v instanceof ArrayBuffer) u = new Uint8Array(v);
  else if (ArrayBuffer.isView(v)) u = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  else return null;
  return u.byteLength > 0 && u.byteLength <= MAX_UPDATE ? u : null;
}

export function attachWikiCollab({ io, prisma, access }) {
  /** pageId -> { doc, awareness, seeded, seeder, sockets: Map<socketId, Set<clientId>> } */
  const rooms = new Map();

  function getRoom(pageId) {
    let r = rooms.get(pageId);
    if (!r) {
      const doc = new Y.Doc();
      const awareness = new awarenessProtocol.Awareness(doc);
      awareness.setLocalState(null); // le serveur n'a pas de présence propre
      r = { doc, awareness, seeded: false, seeder: null, sockets: new Map() };
      rooms.set(pageId, r);
    }
    return r;
  }

  function leave(socket, pageId) {
    const r = rooms.get(pageId);
    if (!r || !r.sockets.has(socket.id)) return;
    const clients = [...r.sockets.get(socket.id)];
    r.sockets.delete(socket.id);
    socket.leave(room(pageId));
    if (clients.length) {
      awarenessProtocol.removeAwarenessStates(r.awareness, clients, 'server');
      io.to(room(pageId)).emit('wiki-collab:awareness', { pageId, update: awarenessProtocol.encodeAwarenessUpdate(r.awareness, clients) });
    }
    if (r.seeder === socket.id && !r.seeded) r.seeder = null;
    if (r.sockets.size === 0) {
      r.awareness.destroy();
      r.doc.destroy();
      rooms.delete(pageId);
    }
  }

  io.on('connection', (socket) => {
    socket.on('wiki-collab:join', async (msg, ack) => {
      try {
        const pageId = msg?.pageId;
        if (typeof pageId !== 'string' || !UUID.test(pageId)) throw new Error('bad');
        await access.checkPage(socket.data.user, pageId, 'EDITOR');
        const page = await prisma.wikiPage.findUnique({ where: { id: pageId }, select: { deletedAt: true } });
        if (page.deletedAt) throw new Error('trash');
        const r = getRoom(pageId);
        if (!r.sockets.has(socket.id)) r.sockets.set(socket.id, new Set());
        socket.join(room(pageId));
        // Le premier arrivé initialise le document partagé à partir du contenu enregistré
        let seed = false;
        if (!r.seeded && !r.seeder) { r.seeder = socket.id; seed = true; }
        const states = [...r.awareness.getStates().keys()];
        ack?.({
          ok: true,
          seed,
          state: r.seeded ? Y.encodeStateAsUpdate(r.doc) : null,
          awareness: states.length ? awarenessProtocol.encodeAwarenessUpdate(r.awareness, states) : null,
        });
      } catch {
        ack?.({ ok: false });
      }
    });

    socket.on('wiki-collab:update', (msg) => {
      const pageId = msg?.pageId;
      const r = typeof pageId === 'string' ? rooms.get(pageId) : null;
      const update = bytes(msg?.update);
      if (!r || !r.sockets.has(socket.id) || !update) return;
      if (!r.seeded && r.seeder !== socket.id) return; // rien avant l'initialisation
      try {
        Y.applyUpdate(r.doc, update, socket.id);
      } catch {
        return; // mise à jour illisible : ignorée
      }
      if (!r.seeded) { r.seeded = true; r.seeder = null; }
      socket.to(room(pageId)).emit('wiki-collab:update', { pageId, update });
    });

    socket.on('wiki-collab:awareness', (msg) => {
      const pageId = msg?.pageId;
      const r = typeof pageId === 'string' ? rooms.get(pageId) : null;
      const update = bytes(msg?.update);
      if (!r || !r.sockets.has(socket.id) || !update) return;
      try {
        // Suivi des identifiants Yjs de ce socket, pour retirer sa présence à la déconnexion
        const before = new Set(r.awareness.getStates().keys());
        awarenessProtocol.applyAwarenessUpdate(r.awareness, update, socket.id);
        const mine = r.sockets.get(socket.id);
        for (const id of r.awareness.getStates().keys()) if (!before.has(id)) mine.add(id);
      } catch {
        return;
      }
      socket.to(room(pageId)).emit('wiki-collab:awareness', { pageId, update });
    });

    socket.on('wiki-collab:leave', (msg) => { if (typeof msg?.pageId === 'string') leave(socket, msg.pageId); });
    socket.on('disconnect', () => { for (const pageId of [...rooms.keys()]) leave(socket, pageId); });
  });

  return {
    /** Le contenu enregistré a changé hors co-édition (restauration, corbeille) : les éditeurs rechargent. */
    reset(pageId) {
      const r = rooms.get(pageId);
      if (!r) return;
      io.to(room(pageId)).emit('wiki-collab:reset', { pageId });
      for (const id of [...r.sockets.keys()]) {
        const s = io.sockets.sockets.get(id);
        if (s) leave(s, pageId);
      }
      if (rooms.get(pageId) === r) { r.awareness.destroy(); r.doc.destroy(); rooms.delete(pageId); }
    },
    /** Nombre d'éditeurs connectés (diagnostic et tests). */
    editors: (pageId) => rooms.get(pageId)?.sockets.size ?? 0,
  };
}
