// Wiki v2 : accès restreint, favoris, accueil, rétroliens, liens avec les tâches, export ZIP, co-édition.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { io as ioClient } from 'socket.io-client';
import * as Y from 'yjs';
import { setup, migrate, createUser, client } from './helpers.js';
import { sanitizeDoc, docToMarkdown } from '../src/server/lib/wikidoc.js';

const doc = (...content) => ({ type: 'doc', content });
const p = (text, marks) => ({ type: 'paragraph', content: [{ type: 'text', text, ...(marks ? { marks } : {}) }] });
const FILE = '/api/wiki/files/123e4567-e89b-12d3-a456-426614174000';

describe('documents du wiki : nouveaux blocs', () => {
  it('accepte encadrés, blocs dépliables, fichiers joints et langage des blocs de code', () => {
    const out = sanitizeDoc(doc(
      { type: 'callout', attrs: { variant: 'danger', onclick: 'x' }, content: [p('Ne pas redémarrer en journée')] },
      { type: 'callout', attrs: { variant: 'rouge' }, content: [p('variante inconnue')] },
      { type: 'details', attrs: { open: true }, content: [{ type: 'detailsSummary', content: [{ type: 'text', text: 'Détails' }] }, { type: 'detailsContent', content: [p('caché')] }] },
      { type: 'fileAttachment', attrs: { src: FILE, filename: 'plan.pdf', size: 1234, mimetype: 'application/pdf' } },
      { type: 'fileAttachment', attrs: { src: 'https://exfiltration.example/x.pdf', filename: 'x.pdf' } },
      { type: 'codeBlock', attrs: { language: 'powershell' }, content: [{ type: 'text', text: 'Get-Service' }] },
      { type: 'codeBlock', attrs: { language: 'x"><script>' }, content: [{ type: 'text', text: 'x' }] },
    ));
    expect(out.content.map((n) => n.type)).toEqual(['callout', 'callout', 'details', 'fileAttachment', 'codeBlock', 'codeBlock']);
    expect(out.content[0].attrs).toEqual({ variant: 'danger' });
    expect(out.content[1].attrs).toBeUndefined();
    expect(out.content[2].attrs).toEqual({ open: true });
    expect(out.content[4].attrs).toEqual({ language: 'powershell' });
    expect(out.content[5].attrs).toBeUndefined();
    const md = docToMarkdown('T', out);
    expect(md).toContain('> **Danger**');
    expect(md).toContain('<summary>Détails</summary>');
    expect(md).toContain(`📎 [plan.pdf](${FILE})`);
    expect(md).toContain('```powershell\nGet-Service\n```');
  });
});

describe('wiki v2 (API)', () => {
  let app, prisma, owner, editor, viewer, outsider, wsId, users;
  beforeAll(() => migrate());
  afterAll(async () => { await app?.close(); await prisma?.$disconnect(); });

  beforeEach(async () => {
    if (app) { await app.close(); await prisma.$disconnect(); }
    ({ app, prisma } = await setup({ env: { upload: { dir: (await import('node:fs')).mkdtempSync('/tmp/kz-wiki2-'), maxMb: 1, allowedMime: ['image/png', 'application/pdf'] } } }));
    for (const n of ['owner', 'editor', 'editor2', 'viewer', 'outsider']) await createUser(prisma, n);
    owner = client(app); editor = client(app); viewer = client(app); outsider = client(app);
    await owner.login('owner'); await editor.login('editor'); await viewer.login('viewer'); await outsider.login('outsider');
    wsId = (await owner.post('/api/workspaces', { name: 'Infra' })).json().workspace.id;
    users = Object.fromEntries((await prisma.user.findMany()).map((u) => [u.username, u.id]));
    await owner.put(`/api/workspaces/${wsId}/members/${users.editor}`, { role: 'EDITOR' });
    await owner.put(`/api/workspaces/${wsId}/members/${users.editor2}`, { role: 'EDITOR' });
    await owner.put(`/api/workspaces/${wsId}/members/${users.viewer}`, { role: 'VIEWER' });
  });

  const create = async (c, body) => (await c.post(`/api/workspaces/${wsId}/wiki`, body)).json().page;

  describe('accès restreint', () => {
    it('masque une section restreinte (et ses sous-pages) partout', async () => {
      const rh = await create(owner, { title: 'RH', content: doc(p('salaires confidentiels')) });
      const sub = await create(owner, { title: 'Paie', parentId: rh.id, content: doc(p('grille de salaires')) });
      const pub = await create(editor, { title: 'Public', content: doc(p('voir [RH]'), p('lien', [{ type: 'link', attrs: { href: `/wiki/${rh.id}` } }])) });
      expect((await editor.put(`/api/wiki/pages/${rh.id}/access`, { restricted: true, userIds: [] })).statusCode).toBe(403);
      expect((await owner.put(`/api/wiki/pages/${rh.id}/access`, { restricted: true, userIds: [users.outsider] })).statusCode).toBe(400);
      expect((await owner.put(`/api/wiki/pages/${rh.id}/access`, { restricted: true, userIds: [users.editor] })).statusCode).toBe(200);

      // Autorisé (editor) : voit tout ; non autorisé (viewer) : 404 sur la section et sa descendance
      expect((await editor.get(`/api/workspaces/${wsId}/wiki`)).json().pages.map((x) => x.title).sort()).toEqual(['Paie', 'Public', 'RH']);
      expect((await viewer.get(`/api/workspaces/${wsId}/wiki`)).json().pages.map((x) => x.title)).toEqual(['Public']);
      for (const id of [rh.id, sub.id]) {
        expect((await viewer.get(`/api/wiki/pages/${id}`)).statusCode).toBe(404);
        expect((await viewer.get(`/api/wiki/pages/${id}/revisions`)).statusCode).toBe(404);
        expect((await viewer.get(`/api/wiki/pages/${id}/export.md`)).statusCode).toBe(404);
      }
      expect((await viewer.get(`/api/wiki/search?q=salaires&workspaceId=${wsId}`)).json().results).toHaveLength(0);
      expect((await editor.get(`/api/wiki/search?q=salaires&workspaceId=${wsId}`)).json().results.map((r) => r.title).sort()).toEqual(['Paie', 'RH']);
      // Révisions et fichiers de la page restreinte : même règle
      const rev = (await editor.get(`/api/wiki/pages/${sub.id}/revisions`)).json().revisions[0];
      expect((await viewer.get(`/api/wiki/revisions/${rev.id}`)).statusCode).toBe(404);
      // Le propriétaire voit tout, et la page publique reste lisible avec son lien vers RH
      expect((await owner.get(`/api/wiki/pages/${sub.id}`)).json().page.restrictedBy.map((x) => x.title)).toEqual(['RH']);
      expect((await viewer.get(`/api/wiki/pages/${pub.id}`)).statusCode).toBe(200);
      // Rétroliens : la page restreinte n'apparaît pas pour le lecteur
      const pubLinked = await create(owner, { title: 'Lien vers public', parentId: rh.id, content: doc(p('voir', [{ type: 'link', attrs: { href: `/wiki/${pub.id}` } }])) });
      expect((await editor.get(`/api/wiki/pages/${pub.id}/backlinks`)).json().pages.map((x) => x.id)).toEqual([pubLinked.id]);
      expect((await viewer.get(`/api/wiki/pages/${pub.id}/backlinks`)).json().pages).toHaveLength(0);
    });

    it('un éditeur ne peut pas sortir une page d\'une zone restreinte', async () => {
      const zone = await create(owner, { title: 'Zone' });
      const page = await create(owner, { title: 'Dedans', parentId: zone.id });
      await owner.put(`/api/wiki/pages/${zone.id}/access`, { restricted: true, userIds: [users.editor] });
      expect((await editor.post(`/api/wiki/pages/${page.id}/move`, { parentId: null })).statusCode).toBe(403);
      // déplacement à l'intérieur de la zone : permis
      const other = await create(editor, { title: 'Autre', parentId: zone.id });
      expect((await editor.post(`/api/wiki/pages/${page.id}/move`, { parentId: other.id })).statusCode).toBe(200);
      expect((await owner.post(`/api/wiki/pages/${page.id}/move`, { parentId: null })).statusCode).toBe(200);
    });

    it('une page restaurée à la racine garde la restriction de son ancienne section', async () => {
      const zone = await create(owner, { title: 'Zone' });
      const page = await create(owner, { title: 'Secret', parentId: zone.id });
      await owner.put(`/api/wiki/pages/${zone.id}/access`, { restricted: true, userIds: [users.editor] });
      await editor.del(`/api/wiki/pages/${page.id}`);
      await editor.del(`/api/wiki/pages/${zone.id}`);
      await editor.post(`/api/wiki/pages/${page.id}/restore`); // parent toujours à la corbeille : retour à la racine
      expect((await viewer.get(`/api/wiki/pages/${page.id}`)).statusCode).toBe(404);
      expect((await editor.get(`/api/wiki/pages/${page.id}`)).json().page.restricted).toBe(true);
    });
  });

  it('favoris, pages récentes et page d\'accueil', async () => {
    const a = await create(editor, { title: 'A' });
    const b = await create(editor, { title: 'B' });
    await viewer.get(`/api/wiki/pages/${a.id}`);
    await viewer.get(`/api/wiki/pages/${b.id}`);
    expect((await viewer.put(`/api/wiki/pages/${a.id}/favorite`)).statusCode).toBe(200);
    expect((await viewer.get(`/api/wiki/pages/${a.id}`)).json().page.favorite).toBe(true);
    let tree = (await viewer.get(`/api/workspaces/${wsId}/wiki`)).json();
    expect(tree.favorites).toEqual([a.id]);
    expect(tree.recent.map((r) => r.pageId)).toEqual([a.id, b.id]);
    await viewer.del(`/api/wiki/pages/${a.id}/favorite`);
    expect((await viewer.put(`/api/workspaces/${wsId}/wiki/home`, { pageId: b.id })).statusCode).toBe(403);
    expect((await owner.put(`/api/workspaces/${wsId}/wiki/home`, { pageId: b.id })).statusCode).toBe(200);
    tree = (await viewer.get(`/api/workspaces/${wsId}/wiki`)).json();
    expect(tree.favorites).toEqual([]);
    expect(tree.homePageId).toBe(b.id);
    expect((await outsider.put(`/api/wiki/pages/${a.id}/favorite`)).statusCode).toBe(404);
  });

  it('lie pages et tâches dans les deux sens, dans le même espace uniquement', async () => {
    const board = (await owner.post(`/api/workspaces/${wsId}/boards`, { title: 'Tableau', template: 'kanban' })).json().board;
    const col = (await owner.get(`/api/boards/${board.id}`)).json().board.columns[0];
    const task = (await editor.post(`/api/columns/${col.id}/tasks`, { title: 'Migrer le DNS' })).json().task;
    const page = await create(editor, { title: 'Procédure DNS' });
    expect((await editor.get(`/api/workspaces/${wsId}/tasks?q=dns`)).json().tasks.map((t) => t.title)).toEqual(['Migrer le DNS']);
    expect((await viewer.post(`/api/wiki/pages/${page.id}/tasks`, { taskId: task.id })).statusCode).toBe(403);
    expect((await editor.post(`/api/wiki/pages/${page.id}/tasks`, { taskId: task.id })).statusCode).toBe(201);
    const linked = (await viewer.get(`/api/wiki/pages/${page.id}/tasks`)).json().tasks;
    expect(linked.map((t) => [t.title, t.board.title])).toEqual([['Migrer le DNS', 'Tableau']]);
    expect((await viewer.get(`/api/tasks/${task.id}/wiki-pages`)).json().pages.map((x) => x.title)).toEqual(['Procédure DNS']);
    // Côté tâche : suppression puis recréation du lien
    expect((await editor.del(`/api/tasks/${task.id}/wiki-pages/${page.id}`)).statusCode).toBe(200);
    expect((await viewer.get(`/api/wiki/pages/${page.id}/tasks`)).json().tasks).toHaveLength(0);
    expect((await editor.post(`/api/tasks/${task.id}/wiki-pages`, { pageId: page.id })).statusCode).toBe(201);
    // Autre espace : refusé
    const ws2 = (await outsider.post('/api/workspaces', { name: 'Autre' })).json().workspace.id;
    const foreign = (await outsider.post(`/api/workspaces/${ws2}/wiki`, { title: 'Étrangère' })).json().page;
    expect((await outsider.post(`/api/wiki/pages/${foreign.id}/tasks`, { taskId: task.id })).statusCode).toBe(404);
    expect((await outsider.get(`/api/tasks/${task.id}/wiki-pages`)).statusCode).toBe(404);
  });

  it('exporte une section en ZIP (Markdown + fichiers, sous-dossiers)', async () => {
    const root = await create(editor, { title: 'Exploitation' });
    const boundary = '----kz';
    const up = await editor.raw('POST', `/api/wiki/pages/${root.id}/files`,
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="plan.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4\r\n--${boundary}--\r\n`,
      { 'content-type': `multipart/form-data; boundary=${boundary}` });
    const file = up.json().file;
    await editor.patch(`/api/wiki/pages/${root.id}`, { version: 1, content: doc({ type: 'fileAttachment', attrs: { src: file.url, filename: 'plan.pdf', size: file.size, mimetype: 'application/pdf' } }) });
    const child = await create(editor, { title: 'Sauvegardes', parentId: root.id, content: doc(p('pg_dump')) });
    await create(editor, { title: 'Hors section' });
    const r = await viewer.get(`/api/wiki/pages/${root.id}/export.zip`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/zip');
    const files = unzipSync(new Uint8Array(r.rawPayload));
    const names = Object.keys(files).sort();
    expect(names).toEqual(['Exploitation.md', 'Exploitation/Sauvegardes.md', expect.stringMatching(/^_fichiers\/[0-9a-f]{8}-plan\.pdf$/)].sort());
    expect(strFromU8(files['Exploitation.md'])).toMatch(/📎 \[plan\.pdf\]\(_fichiers\/[0-9a-f]{8}-plan\.pdf\)/);
    expect(strFromU8(files['Exploitation/Sauvegardes.md'])).toContain('pg\\_dump');
    expect(child).toBeTruthy();
    expect((await outsider.get(`/api/wiki/pages/${root.id}/export.zip`)).statusCode).toBe(404);
  });

  describe('co-édition', () => {
    let port;
    beforeEach(async () => {
      await app.listen({ host: '127.0.0.1', port: 0 });
      port = app.server.address().port;
    });
    const cookieOf = async (username) => {
      const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-requested-with': 'KanZen' }, payload: { username, password: 'Test-Password-2026!' } });
      const c = res.cookies.find((x) => x.name === app.cfg.session.cookieName);
      return `${c.name}=${c.value}`;
    };
    const connect = async (username) => {
      const s = ioClient(`http://127.0.0.1:${port}`, { path: '/socket.io', transports: ['websocket'], extraHeaders: { cookie: await cookieOf(username) }, forceNew: true });
      await new Promise((res, rej) => { s.on('connect', res); s.on('connect_error', rej); });
      return s;
    };
    const join = (s, pageId) => new Promise((res) => s.emit('wiki-collab:join', { pageId }, res));

    it('partage les modifications entre éditeurs et refuse les lecteurs', async () => {
      const page = await create(editor, { title: 'Partagée' });
      const a = await connect('editor');
      const b = await connect('editor2');
      const v = await connect('viewer');
      try {
        expect((await join(v, page.id)).ok).toBe(false);
        const ja = await join(a, page.id);
        expect(ja).toMatchObject({ ok: true, seed: true, state: null });
        // A initialise le document partagé
        const da = new Y.Doc();
        da.getText('t').insert(0, 'bonjour');
        a.emit('wiki-collab:update', { pageId: page.id, update: Y.encodeStateAsUpdate(da) });
        await new Promise((r) => setTimeout(r, 100));
        // B rejoint : reçoit l'état, puis les modifications suivantes de A
        const jb = await join(b, page.id);
        expect(jb.seed).toBe(false);
        const db = new Y.Doc();
        Y.applyUpdate(db, new Uint8Array(jb.state));
        expect(db.getText('t').toString()).toBe('bonjour');
        const received = new Promise((r) => b.on('wiki-collab:update', (m) => r(m)));
        const sv = Y.encodeStateVector(da);
        da.getText('t').insert(7, ' à tous');
        a.emit('wiki-collab:update', { pageId: page.id, update: Y.encodeStateAsUpdate(da, sv) });
        Y.applyUpdate(db, new Uint8Array((await received).update));
        expect(db.getText('t').toString()).toBe('bonjour à tous');
        expect(app.realtime.wikiCollab.editors(page.id)).toBe(2);
        // Un lecteur ne peut pas injecter de modification
        v.emit('wiki-collab:update', { pageId: page.id, update: Y.encodeStateAsUpdate(da) });
        a.disconnect(); b.disconnect();
        await new Promise((r) => setTimeout(r, 150));
        expect(app.realtime.wikiCollab.editors(page.id)).toBe(0);
      } finally {
        a.disconnect(); b.disconnect(); v.disconnect();
      }
    });

    it('enregistre automatiquement quand le dernier éditeur part sans enregistrer, sauf abandon explicite', async () => {
      const page = await create(editor, { title: 'Brouillon', content: doc(p('avant')) });
      const typed = (pageId, sock, text) => {
        const d = new Y.Doc();
        const para = new Y.XmlElement('paragraph');
        para.insert(0, [new Y.XmlText(text)]);
        d.getXmlFragment('default').insert(0, [para]);
        d.getMap('meta').set('title', 'Brouillon');
        sock.emit('wiki-collab:update', { pageId, update: Y.encodeStateAsUpdate(d) });
      };
      const settle = () => new Promise((r) => setTimeout(r, 250));
      // 1. Fermeture de l'onglet (déconnexion) : le travail est enregistré
      const a = await connect('editor');
      try {
        expect((await join(a, page.id)).seed).toBe(true);
        a.emit('wiki-collab:update', { pageId: page.id, update: Y.encodeStateAsUpdate(new Y.Doc()) }); // initialisation
        await settle();
        typed(page.id, a, 'saisie non enregistrée');
        await settle();
      } finally { a.disconnect(); }
      await settle();
      let saved = (await editor.get(`/api/wiki/pages/${page.id}`)).json().page;
      expect(saved.version).toBe(2);
      expect(JSON.stringify(saved.content)).toContain('saisie non enregistrée');
      expect(await prisma.auditLog.count({ where: { action: 'wiki.autosave', target: page.id } })).toBe(1);
      // 2. « Annuler » (leave + discard) : rien n'est enregistré
      const b = await connect('editor');
      try {
        expect((await join(b, page.id)).seed).toBe(true);
        b.emit('wiki-collab:update', { pageId: page.id, update: Y.encodeStateAsUpdate(new Y.Doc()) });
        await settle();
        typed(page.id, b, 'à jeter');
        await settle();
        b.emit('wiki-collab:leave', { pageId: page.id, discard: true });
        await settle();
      } finally { b.disconnect(); }
      await settle();
      saved = (await editor.get(`/api/wiki/pages/${page.id}`)).json().page;
      expect(saved.version).toBe(2);
      expect(JSON.stringify(saved.content)).not.toContain('à jeter');
    });
  });
});
