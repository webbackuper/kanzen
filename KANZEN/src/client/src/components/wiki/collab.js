// Co-édition : document Yjs partagé avec les autres éditeurs de la page, via Socket.io (même origine, cookie de session).
import { io } from 'socket.io-client';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';

import { colorOf } from './colors';

// Extensions TipTap de co-édition : chargées avec ce module, uniquement quand on passe en édition
export { Collaboration } from '@tiptap/extension-collaboration';
export { CollaborationCaret } from '@tiptap/extension-collaboration-caret';

const asBytes = (v) => (v instanceof Uint8Array ? v : new Uint8Array(v));

/**
 * Ouvre une session de co-édition sur une page.
 * Résout { ydoc, provider, seed, meta, peers(), close() } ; rejette si l'accès est refusé.
 * onPeers(list) : présence des autres éditeurs ; onReset() : la page a été remplacée (restauration, corbeille).
 */
export function openCollab(pageId, user, { onPeers, onReset } = {}) {
  return new Promise((resolve, reject) => {
    const socket = io({ path: '/socket.io', withCredentials: true, transports: ['websocket', 'polling'] });
    const ydoc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(ydoc);
    awareness.setLocalStateField('user', { name: user.displayName, color: colorOf(user.id), id: user.id });
    let joined = false;
    let closed = false;

    const peers = () => [...awareness.getStates().entries()]
      .filter(([id, s]) => id !== ydoc.clientID && s.user)
      .map(([id, s]) => ({ clientId: id, ...s.user }));

    ydoc.on('update', (update, origin) => {
      if (origin !== 'remote' && joined) socket.emit('wiki-collab:update', { pageId, update });
    });
    awareness.on('update', ({ added, updated, removed }, origin) => {
      if (origin !== 'remote' && joined) {
        socket.emit('wiki-collab:awareness', { pageId, update: awarenessProtocol.encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]) });
      }
      onPeers?.(peers());
    });
    socket.on('wiki-collab:update', (m) => { if (m.pageId === pageId) Y.applyUpdate(ydoc, asBytes(m.update), 'remote'); });
    socket.on('wiki-collab:awareness', (m) => { if (m.pageId === pageId) awarenessProtocol.applyAwarenessUpdate(awareness, asBytes(m.update), 'remote'); });
    socket.on('wiki-collab:reset', (m) => { if (m.pageId === pageId) onReset?.(); });

    const join = () => socket.emit('wiki-collab:join', { pageId }, (ack) => {
      if (closed) return;
      if (!ack?.ok) { if (!joined) { cleanup(); reject(new Error('Co-édition indisponible pour cette page')); } return; }
      if (ack.state) Y.applyUpdate(ydoc, asBytes(ack.state), 'remote');
      if (ack.awareness) awarenessProtocol.applyAwarenessUpdate(awareness, asBytes(ack.awareness), 'remote');
      const first = !joined;
      joined = true;
      // Présence locale annoncée aux autres
      socket.emit('wiki-collab:awareness', { pageId, update: awarenessProtocol.encodeAwarenessUpdate(awareness, [ydoc.clientID]) });
      if (first) {
        resolve({
          ydoc,
          provider: { awareness },
          seed: ack.seed,
          meta: ydoc.getMap('meta'),
          peers,
          // discard : abandon explicite (« Annuler ») ; sinon, le serveur enregistre ce qui n'a pas été enregistré
          close: ({ discard = false } = {}) => { closed = true; cleanup({ discard }); },
        });
      } else {
        // Reconnexion : on republie notre état complet (fusionné sans perte par Yjs, ou nouvelle initialisation)
        socket.emit('wiki-collab:update', { pageId, update: Y.encodeStateAsUpdate(ydoc) });
      }
    });
    // Déconnexion par le serveur (revalidation des droits, révocation) : une seule tentative de reconnexion ;
    // elle échoue si la session n'est plus valide, et le salon n'est pas rejoint si l'accès a été retiré.
    socket.on('disconnect', (reason) => { if (reason === 'io server disconnect') setTimeout(() => { if (!closed) socket.connect(); }, 3000); });
    socket.on('connect', join);
    socket.on('connect_error', () => { if (!joined) { cleanup(); reject(new Error('Connexion temps réel impossible')); } });

    function cleanup({ discard = false } = {}) {
      try {
        awarenessProtocol.removeAwarenessStates(awareness, [ydoc.clientID], 'local'); // diffusé par l'écouteur « update »
        if (socket.connected) socket.emit('wiki-collab:leave', { pageId, discard });
      } catch { /* fermeture */ }
      socket.disconnect();
      awareness.destroy();
      ydoc.destroy();
    }
  });
}
