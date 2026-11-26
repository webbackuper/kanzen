import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setup, migrate, createUser, client, PASSWORD } from './helpers.js';

let app, prisma;
beforeAll(() => migrate());
afterAll(async () => { await app?.close(); await prisma?.$disconnect(); });

async function fresh(opts) {
  if (app) { await app.close(); await prisma.$disconnect(); }
  ({ app, prisma } = await setup(opts));
}

describe('authentification locale', () => {
  beforeEach(() => fresh());

  it('connecte, puis /me, puis déconnecte', async () => {
    await createUser(prisma, 'alice');
    const c = client(app);
    const r = await c.login('alice');
    expect(r.statusCode).toBe(200);
    const cookie = r.cookies[0];
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Strict');
    expect((await c.get('/api/auth/me')).json().user.username).toBe('alice');
    await c.post('/api/auth/logout');
    expect((await c.get('/api/auth/me')).statusCode).toBe(401);
  });

  it('message identique pour compte inconnu et mauvais mot de passe', async () => {
    await createUser(prisma, 'alice');
    const a = await client(app).login('alice', 'mauvais');
    const b = await client(app).login('inconnu', 'mauvais');
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(a.json().error).toBe(b.json().error);
  });

  it('verrouille après N échecs', async () => {
    await createUser(prisma, 'alice');
    for (let i = 0; i < 5; i++) await client(app).login('alice', 'mauvais');
    const r = await client(app).login('alice');
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toMatch(/verrouillé/);
  });

  it('refuse un compte désactivé', async () => {
    await createUser(prisma, 'alice', { disabled: true });
    expect((await client(app).login('alice')).statusCode).toBe(401);
  });

  it('accepte DOMAINE\\user et user@domaine', async () => {
    await createUser(prisma, 'alice');
    expect((await client(app).login('CORP\\Alice')).statusCode).toBe(200);
    expect((await client(app).login('alice@corp.local')).statusCode).toBe(200);
  });

  it('refuse les écritures sans en-tête anti-CSRF ou depuis une autre origine', async () => {
    await createUser(prisma, 'alice');
    const c = client(app);
    await c.login('alice');
    expect((await c.raw('POST', '/api/workspaces', { name: 'x' }, { 'x-requested-with': '' })).statusCode).toBe(403);
    expect((await c.raw('POST', '/api/workspaces', { name: 'x' }, { origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await c.post('/api/workspaces', { name: 'x' })).statusCode).toBe(201);
  });

  it('impose le changement de mot de passe initial', async () => {
    await createUser(prisma, 'admin', { role: 'ADMIN' });
    const admin = client(app);
    await admin.login('admin');
    const weak = await admin.post('/api/users', { username: 'carol', displayName: 'Carol', password: 'faible' });
    expect(weak.statusCode).toBe(400);
    const r = await admin.post('/api/users', { username: 'carol', displayName: 'Carol', password: 'Temp-Password-99' });
    expect(r.statusCode).toBe(201);

    const carol = client(app);
    await carol.login('carol', 'Temp-Password-99');
    expect((await carol.get('/api/workspaces')).statusCode).toBe(403);
    expect((await carol.post('/api/auth/password', { currentPassword: 'Temp-Password-99', newPassword: 'Nouveau-Secret-2026' })).statusCode).toBe(200);
    expect((await carol.get('/api/workspaces')).statusCode).toBe(200);
  });

  it('réserve l\'administration aux admins', async () => {
    await createUser(prisma, 'alice');
    const c = client(app);
    await c.login('alice');
    expect((await c.get('/api/users')).statusCode).toBe(403);
    expect((await c.get('/api/admin/audit')).statusCode).toBe(403);
  });
});

describe('authentification AD (annuaire simulé)', () => {
  const directory = {
    jdupont: { password: 'AD-Password-1', isAdmin: false, inGroup: true, guid: '11111111-1111-1111-1111-111111111111' },
    chef: { password: 'AD-Password-2', isAdmin: true, inGroup: true, guid: '22222222-2222-2222-2222-222222222222' },
    externe: { password: 'AD-Password-3', isAdmin: false, inGroup: false, guid: '33333333-3333-3333-3333-333333333333' },
    alice: { password: 'AD-Password-4', isAdmin: false, inGroup: true, guid: '44444444-4444-4444-4444-444444444444' },
  };
  const ldap = {
    async authenticate(username, password) {
      const u = directory[username];
      if (!u) return { ok: false, reason: 'not_found' };
      if (!u.inGroup) return { ok: false, reason: 'not_in_group' };
      if (u.password !== password) return { ok: false, reason: 'invalid_credentials' };
      return { ok: true, profile: { username, displayName: username.toUpperCase(), email: `${username}@corp.local`, externalId: u.guid, isAdmin: u.isAdmin } };
    },
    // Recherche, résolution par GUID et liste complète : seuls les comptes du groupe d'accès sont visibles
    profile: (username) => ({ username, displayName: username.toUpperCase(), email: `${username}@corp.local`, externalId: directory[username].guid, isAdmin: directory[username].isAdmin }),
    async searchUsers(q) { return Object.keys(directory).filter((n) => directory[n].inGroup && n.includes(q)).map((n) => ldap.profile(n)); },
    async findByGuid(guid) { const n = Object.keys(directory).find((k) => directory[k].guid === guid && directory[k].inGroup); return n ? ldap.profile(n) : null; },
    async listAuthorized() {
      if (ldap.down) throw new Error('injoignable');
      return new Map(Object.keys(directory).filter((n) => directory[n].inGroup).map((n) => [directory[n].guid, ldap.profile(n)]));
    },
  };
  beforeEach(() => fresh({ ldap, env: { auth: { localEnabled: true, ldapEnabled: true }, ldap: { urls: ['ldaps://dc.test'], bindDn: 'x', bindPassword: 'x', baseDn: 'x', groupUsers: 'x', userFilter: '(u={{username}})' } } }));

  it('provisionne le compte au premier login et mappe le rôle depuis le groupe', async () => {
    expect((await client(app).login('jdupont', 'AD-Password-1')).json().user).toMatchObject({ authSource: 'LDAP', role: 'USER' });
    expect((await client(app).login('chef', 'AD-Password-2')).json().user.role).toBe('ADMIN');
    expect(await prisma.user.count({ where: { authSource: 'LDAP' } })).toBe(2);
  });

  it('refuse un utilisateur hors du groupe d\'accès', async () => {
    expect((await client(app).login('externe', 'AD-Password-3')).statusCode).toBe(401);
    expect(await prisma.user.count()).toBe(0);
  });

  it('un compte local garde la priorité et n\'est pas usurpable via l\'AD', async () => {
    await createUser(prisma, 'alice');
    expect((await client(app).login('alice', 'AD-Password-4')).statusCode).toBe(401);
    expect((await client(app).login('alice', PASSWORD)).json().user.authSource).toBe('LOCAL');
  });

  it('trouve un agent AD jamais connecté et le provisionne à l\'ajout dans un espace', async () => {
    await createUser(prisma, 'owner');
    const o = client(app); await o.login('owner');
    const ws = (await o.post('/api/workspaces', { name: 'Projet' })).json().workspace;
    const look = (await o.get('/api/users/lookup?q=dupont')).json();
    expect(look.users).toEqual([expect.objectContaining({ id: null, username: 'jdupont', source: 'LDAP', externalId: directory.jdupont.guid })]);
    expect((await o.get('/api/users/lookup?q=externe')).json().users).toEqual([]); // hors groupe : invisible
    const prov = await o.post('/api/users/provision', { externalId: directory.jdupont.guid });
    expect(prov.statusCode).toBe(201);
    expect((await o.put(`/api/workspaces/${ws.id}/members/${prov.json().user.id}`, { role: 'EDITOR' })).statusCode).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: 'user.provision' } })).toBe(1);
    // Déjà connu : plus proposé comme compte d'annuaire ; GUID hors groupe : 404
    expect((await o.get('/api/users/lookup?q=dupont')).json().users[0].id).toBe(prov.json().user.id);
    expect((await o.post('/api/users/provision', { externalId: directory.externe.guid })).statusCode).toBe(404);
    // Un simple utilisateur (propriétaire d'aucun espace) ne peut pas provisionner
    const j = client(app); await j.login('jdupont', 'AD-Password-1');
    expect((await j.post('/api/users/provision', { externalId: directory.alice.guid })).statusCode).toBe(403);
  });

  it('synchronisation AD : départ du groupe = compte désactivé et sessions révoquées, retour = réactivé', async () => {
    const { syncDirectory } = await import('../src/server/lib/adsync.js');
    const log = { info() {}, warn() {}, error() {} };
    const j = client(app);
    await j.login('jdupont', 'AD-Password-1');
    await client(app).login('chef', 'AD-Password-2');
    expect((await j.get('/api/auth/me')).statusCode).toBe(200);
    directory.jdupont.inGroup = false;
    try {
      const r = await syncDirectory({ prisma, ldap, audit: app.audit, log });
      expect(r.disabled).toEqual(['jdupont']);
      expect((await j.get('/api/auth/me')).statusCode).toBe(401); // session révoquée immédiatement
      expect((await prisma.user.findUnique({ where: { username: 'jdupont' } })).disabledReason).toBe('AD_SYNC');
      expect((await client(app).get('/api/users/lookup?q=jdu')).statusCode).toBe(401);
    } finally { directory.jdupont.inGroup = true; }
    const back = await syncDirectory({ prisma, ldap, audit: app.audit, log });
    expect(back.reenabled).toEqual(['jdupont']);
    expect((await client(app).login('jdupont', 'AD-Password-1')).statusCode).toBe(200);
    // Désactivation décidée par un administrateur : jamais levée par la synchronisation
    await prisma.user.update({ where: { username: 'jdupont' }, data: { disabled: true, disabledReason: null } });
    expect((await syncDirectory({ prisma, ldap, audit: app.audit, log })).reenabled).toEqual([]);
    expect((await client(app).login('jdupont', 'AD-Password-1')).statusCode).toBe(401);
  });

  it('synchronisation AD : garde-fous (annuaire injoignable ou vide)', async () => {
    const { syncDirectory } = await import('../src/server/lib/adsync.js');
    const log = { info() {}, warn() {}, error() {} };
    await client(app).login('jdupont', 'AD-Password-1');
    ldap.down = true;
    try { expect((await syncDirectory({ prisma, ldap, audit: app.audit, log })).aborted).toMatch(/injoignable/); } finally { ldap.down = false; }
    const saved = Object.fromEntries(Object.entries(directory).map(([k, v]) => [k, v.inGroup]));
    for (const v of Object.values(directory)) v.inGroup = false;
    try {
      const r = await syncDirectory({ prisma, ldap, audit: app.audit, log });
      expect(r.aborted).toMatch(/garde-fou/);
      expect(await prisma.user.count({ where: { disabled: true } })).toBe(0);
    } finally { for (const [k, v] of Object.entries(saved)) directory[k].inGroup = v; }
  });

  it('les comptes locaux et AD coexistent', async () => {
    await createUser(prisma, 'secours', { role: 'ADMIN' });
    expect((await client(app).login('secours')).statusCode).toBe(200);
    expect((await client(app).login('jdupont', 'AD-Password-1')).statusCode).toBe(200);
  });
});

describe('contrôle d\'accès aux objets', () => {
  let owner, editor, viewer, outsider, board, otherBoard;
  beforeEach(async () => {
    await fresh();
    for (const n of ['owner', 'editor', 'viewer', 'outsider']) await createUser(prisma, n);
    owner = client(app); editor = client(app); viewer = client(app); outsider = client(app);
    await owner.login('owner'); await editor.login('editor'); await viewer.login('viewer'); await outsider.login('outsider');
    const ws = (await owner.post('/api/workspaces', { name: 'Projet A' })).json().workspace;
    const users = Object.fromEntries((await prisma.user.findMany()).map((u) => [u.username, u.id]));
    await owner.put(`/api/workspaces/${ws.id}/members/${users.editor}`, { role: 'EDITOR' });
    await owner.put(`/api/workspaces/${ws.id}/members/${users.viewer}`, { role: 'VIEWER' });
    board = (await owner.post(`/api/workspaces/${ws.id}/boards`, { title: 'Tableau' })).json().board;
    const ws2 = (await outsider.post('/api/workspaces', { name: 'Projet B' })).json().workspace;
    otherBoard = (await outsider.post(`/api/workspaces/${ws2.id}/boards`, { title: 'Autre' })).json().board;
  });

  const firstColumn = async (c, b) => (await c.get(`/api/boards/${b.id}`)).json().board.columns[0];

  it('un non-membre reçoit 404, même pour lire', async () => {
    expect((await outsider.get(`/api/boards/${board.id}`)).statusCode).toBe(404);
  });

  it('un lecteur lit mais ne modifie pas', async () => {
    const col = await firstColumn(viewer, board);
    expect(col.title).toBe('À faire');
    expect((await viewer.post(`/api/columns/${col.id}/tasks`, { title: 'x' })).statusCode).toBe(403);
  });

  it('un éditeur crée, déplace et commente', async () => {
    const b = (await editor.get(`/api/boards/${board.id}`)).json().board;
    const t = (await editor.post(`/api/columns/${b.columns[0].id}/tasks`, { title: 'Tâche 1' })).json().task;
    const mv = await editor.post(`/api/tasks/${t.id}/move`, { columnId: b.columns[1].id });
    expect(mv.statusCode).toBe(200);
    expect(await prisma.taskEvent.count({ where: { taskId: t.id } })).toBe(2);
    expect((await editor.post(`/api/tasks/${t.id}/comments`, { content: 'ok' })).statusCode).toBe(201);
  });

  it('refuse le déplacement d\'une tâche vers un tableau d\'un autre espace (IDOR v2)', async () => {
    const b = (await editor.get(`/api/boards/${board.id}`)).json().board;
    const t = (await editor.post(`/api/columns/${b.columns[0].id}/tasks`, { title: 'T' })).json().task;
    const foreignCol = await firstColumn(outsider, otherBoard);
    expect((await editor.post(`/api/tasks/${t.id}/move`, { columnId: foreignCol.id })).statusCode).toBe(400);
    expect((await outsider.post(`/api/tasks/${t.id}/move`, { columnId: foreignCol.id })).statusCode).toBe(404);
  });

  it('garde un ordre stable après 60 insertions au même endroit (renumérotation)', async () => {
    const b = (await editor.get(`/api/boards/${board.id}`)).json().board;
    const col = b.columns[1].id;
    const mk = async (title) => (await editor.post(`/api/columns/${b.columns[0].id}/tasks`, { title })).json().task;
    const top = await mk('haut');
    const bottom = await mk('bas');
    await editor.post(`/api/tasks/${top.id}/move`, { columnId: col });
    await editor.post(`/api/tasks/${bottom.id}/move`, { columnId: col, afterId: top.id });
    // Chaque nouvelle carte est glissée juste au-dessus de « bas » : l'écart est divisé par deux à chaque fois
    const expected = [top.id];
    for (let i = 0; i < 60; i++) {
      const t = await mk(`c${i}`);
      const r = await editor.post(`/api/tasks/${t.id}/move`, { columnId: col, beforeId: bottom.id });
      expect(r.statusCode).toBe(200);
      expected.push(t.id);
    }
    expected.push(bottom.id);
    const cards = await prisma.task.findMany({ where: { columnId: col }, orderBy: { position: 'asc' } });
    expect(cards.map((c) => c.id)).toEqual(expected);
    expect(new Set(cards.map((c) => c.position)).size).toBe(cards.length); // aucune position en double
  });

  it('sérialise deux déplacements simultanés dans la même colonne', async () => {
    const b = (await editor.get(`/api/boards/${board.id}`)).json().board;
    const col = b.columns[2].id;
    const ids = [];
    for (const title of ['a', 'b', 'c']) ids.push((await editor.post(`/api/columns/${b.columns[0].id}/tasks`, { title })).json().task.id);
    await editor.post(`/api/tasks/${ids[0]}/move`, { columnId: col });
    const [r1, r2] = await Promise.all([
      editor.post(`/api/tasks/${ids[1]}/move`, { columnId: col, afterId: ids[0] }),
      editor.post(`/api/tasks/${ids[2]}/move`, { columnId: col, afterId: ids[0] }),
    ]);
    expect([r1.statusCode, r2.statusCode]).toEqual([200, 200]);
    const cards = await prisma.task.findMany({ where: { columnId: col } });
    expect(new Set(cards.map((c) => c.position)).size).toBe(3);
  });

  it('transmet l\'origine (X-Socket-Id) dans l\'événement temps réel', async () => {
    const b = (await editor.get(`/api/boards/${board.id}`)).json().board;
    const t = (await editor.post(`/api/columns/${b.columns[0].id}/tasks`, { title: 'echo' })).json().task;
    const seen = [];
    const io = app.realtime.io;
    const orig = io.to.bind(io);
    io.to = (room) => ({ emit: (ev, payload) => { seen.push(payload); return orig(room).emit(ev, payload); } });
    try {
      await editor.raw('POST', `/api/tasks/${t.id}/move`, { columnId: b.columns[1].id }, { 'x-socket-id': 'abc-123' });
      await editor.raw('POST', `/api/tasks/${t.id}/move`, { columnId: b.columns[0].id }, { 'x-socket-id': 'bad id!' });
    } finally { io.to = orig; }
    expect(seen.map((e) => e.origin)).toEqual(['abc-123', null]);
  });

  it('refuse d\'assigner un non-membre', async () => {
    const col = await firstColumn(editor, board);
    const ids = Object.fromEntries((await prisma.user.findMany()).map((u) => [u.username, u.id]));
    expect((await editor.post(`/api/columns/${col.id}/tasks`, { title: 'T', assigneeIds: [ids.editor, ids.outsider] })).statusCode).toBe(400);
    expect(await prisma.task.count()).toBe(0);
  });

  it('affecte une tâche à plusieurs personnes, modifie puis vide la liste', async () => {
    const col = await firstColumn(editor, board);
    const ids = Object.fromEntries((await prisma.user.findMany()).map((u) => [u.username, u.id]));
    const created = await editor.post(`/api/columns/${col.id}/tasks`, { title: 'Équipe', assigneeIds: [ids.editor, ids.viewer, ids.owner] });
    expect(created.statusCode).toBe(201);
    const t = created.json().task;
    expect(t.assignees.map((u) => u.username).sort()).toEqual(['editor', 'owner', 'viewer']);

    const b = (await viewer.get(`/api/boards/${board.id}`)).json().board;
    expect(b.columns[0].tasks[0].assignees).toHaveLength(3);

    const upd = await editor.patch(`/api/tasks/${t.id}`, { assigneeIds: [ids.owner] });
    expect(upd.json().task.assignees.map((u) => u.username)).toEqual(['owner']);
    expect((await editor.patch(`/api/tasks/${t.id}`, { assigneeIds: [ids.owner, ids.owner] })).statusCode).toBe(400); // doublon
    expect((await editor.patch(`/api/tasks/${t.id}`, { assigneeIds: [] })).json().task.assignees).toEqual([]);
  });

  it('un membre retiré de l\'espace n\'est plus assigné', async () => {
    const col = await firstColumn(editor, board);
    const ids = Object.fromEntries((await prisma.user.findMany()).map((u) => [u.username, u.id]));
    const t = (await editor.post(`/api/columns/${col.id}/tasks`, { title: 'T', assigneeIds: [ids.editor, ids.viewer] })).json().task;
    expect((await owner.del(`/api/workspaces/${board.workspaceId}/members/${ids.viewer}`)).statusCode).toBe(200);
    expect((await editor.get(`/api/tasks/${t.id}`)).json().task.assignees.map((u) => u.username)).toEqual(['editor']);
  });

  it('l\'agenda filtre « mes tâches »', async () => {
    const col = await firstColumn(editor, board);
    const ids = Object.fromEntries((await prisma.user.findMany()).map((u) => [u.username, u.id]));
    const due = new Date().toISOString();
    await editor.post(`/api/columns/${col.id}/tasks`, { title: 'À moi', dueDate: due, assigneeIds: [ids.editor, ids.owner] });
    await editor.post(`/api/columns/${col.id}/tasks`, { title: 'Pas à moi', dueDate: due, assigneeIds: [ids.owner] });
    const d = due.slice(0, 10);
    expect((await editor.get(`/api/calendar?from=${d}&to=${d}`)).json().tasks).toHaveLength(2);
    expect((await editor.get(`/api/calendar?from=${d}&to=${d}&mine=true`)).json().tasks.map((t) => t.title)).toEqual(['À moi']);
  });

  it('seul un propriétaire supprime le tableau, et l\'espace garde un propriétaire', async () => {
    expect((await editor.del(`/api/boards/${board.id}`)).statusCode).toBe(403);
    const wsId = board.workspaceId;
    const ownerId = (await prisma.user.findUnique({ where: { username: 'owner' } })).id;
    expect((await owner.del(`/api/workspaces/${wsId}/members/${ownerId}`)).statusCode).toBe(409);
    expect((await owner.del(`/api/boards/${board.id}`)).statusCode).toBe(200);
  });

  it('valide les entrées (UUID, champs inconnus)', async () => {
    expect((await editor.get('/api/boards/pas-un-uuid')).statusCode).toBe(400);
    const col = await firstColumn(editor, board);
    expect((await editor.post(`/api/columns/${col.id}/tasks`, { title: 'T', columnId: 'x' })).statusCode).toBe(400);
  });
});

describe('pièces jointes', () => {
  let c, taskId;
  const multipart = (filename, type, content) => {
    const boundary = '----kz';
    return {
      body: `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n${content}\r\n--${boundary}--\r\n`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    };
  };
  beforeEach(async () => {
    await fresh();
    await createUser(prisma, 'alice');
    c = client(app);
    await c.login('alice');
    const ws = (await c.post('/api/workspaces', { name: 'W' })).json().workspace;
    const board = (await c.post(`/api/workspaces/${ws.id}/boards`, { title: 'B' })).json().board;
    const col = (await c.get(`/api/boards/${board.id}`)).json().board.columns[0];
    taskId = (await c.post(`/api/columns/${col.id}/tasks`, { title: 'T' })).json().task.id;
  });

  it('accepte un type autorisé et le sert en téléchargement forcé', async () => {
    const m = multipart('../../etc/notes.txt', 'text/plain', 'bonjour');
    const r = await c.raw('POST', `/api/tasks/${taskId}/attachments`, m.body, m.headers);
    expect(r.statusCode).toBe(201);
    const a = r.json().attachment;
    expect(a.filename).toBe('notes.txt');
    expect(a.size).toBe(7);
    const d = await c.get(`/api/attachments/${a.id}/download`);
    expect(d.statusCode).toBe(200);
    expect(d.headers['content-disposition']).toMatch(/^attachment/);
    expect(d.headers['content-type']).toBe('application/octet-stream');
    expect(d.body).toBe('bonjour');
    expect((await client(app).get(`/api/attachments/${a.id}/download`)).statusCode).toBe(401);
  });

  it('refuse un HTML (XSS stockée)', async () => {
    const m = multipart('x.html', 'text/html', '<script>alert(1)</script>');
    expect((await c.raw('POST', `/api/tasks/${taskId}/attachments`, m.body, m.headers)).statusCode).toBe(400);
  });

  it('refuse un fichier trop gros', async () => {
    const m = multipart('gros.txt', 'text/plain', 'a'.repeat(1024 * 1024 + 10));
    expect((await c.raw('POST', `/api/tasks/${taskId}/attachments`, m.body, m.headers)).statusCode).toBe(400);
  });
});

describe('journal d\'audit', () => {
  beforeEach(() => fresh());
  it('trace les connexions réussies et échouées', async () => {
    await createUser(prisma, 'admin', { role: 'ADMIN' });
    await client(app).login('admin', 'mauvais');
    const c = client(app);
    await c.login('admin');
    const entries = (await c.get('/api/admin/audit')).json().entries;
    expect(entries.map((e) => `${e.action}:${e.outcome}`)).toEqual(expect.arrayContaining(['auth.login:failure', 'auth.login:success']));
  });
});

describe('arrêt du serveur', () => {
  it('s\'arrête rapidement même avec une websocket connectée', async () => {
    const { io } = await import('socket.io-client');
    const ctx = await setup();
    await createUser(ctx.prisma, 'alice');
    const address = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const login = await fetch(`${address}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'KanZen' }, body: JSON.stringify({ username: 'alice', password: PASSWORD }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const socket = io(address, { extraHeaders: { cookie }, transports: ['websocket'], reconnection: false });
    await new Promise((resolve, reject) => { socket.on('connect', resolve); socket.on('connect_error', reject); });
    const t0 = Date.now();
    await ctx.app.close();
    expect(Date.now() - t0).toBeLessThan(2000);
    socket.close();
    await ctx.prisma.$disconnect();
  });
});

describe('interface web : cache et précompression', () => {
  it('sert les assets précompressés avec un cache immuable, index.html sans cache', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const zlib = await import('node:zlib');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kz-static-'));
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>KanZen</title>');
    const js = 'console.log("kanzen");'.repeat(200);
    fs.writeFileSync(path.join(dir, 'assets', 'index-abc.js'), js);
    fs.writeFileSync(path.join(dir, 'assets', 'index-abc.js.gz'), zlib.gzipSync(js));
    await fresh({ env: { staticDir: dir } });
    const a = await app.inject({ method: 'GET', url: '/assets/index-abc.js', headers: { 'accept-encoding': 'gzip' } });
    expect(a.statusCode).toBe(200);
    expect(a.headers['content-encoding']).toBe('gzip');
    expect(a.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(zlib.gunzipSync(a.rawPayload).toString()).toBe(js);
    const plain = await app.inject({ method: 'GET', url: '/assets/index-abc.js' });
    expect(plain.headers['content-encoding']).toBeUndefined();
    const i = await app.inject({ method: 'GET', url: '/b/123' }); // route de l'application : index.html
    expect(i.statusCode).toBe(200);
    expect(i.headers['cache-control']).toBe('no-cache');
    expect(i.headers['content-security-policy']).toContain("default-src 'self'");
  });
});
