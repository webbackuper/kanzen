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
