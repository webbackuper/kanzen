// Lots 2 et 3 « Kanban » : dépendances entre cartes, champs personnalisés, estimation.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setup, migrate, createUser, client } from './helpers.js';
import { checkFieldValue } from '../src/server/routes/tasks.js';

describe('checkFieldValue', () => {
  it('valide chaque type et refuse le reste', () => {
    expect(checkFieldValue({ type: 'NUMBER', name: 'n' }, 3.5)).toBe(3.5);
    expect(checkFieldValue({ type: 'DATE', name: 'd' }, '2026-12-01')).toBe('2026-12-01');
    expect(checkFieldValue({ type: 'SELECT', name: 's', options: ['A', 'B'] }, 'B')).toBe('B');
    expect(checkFieldValue({ type: 'CHECKBOX', name: 'c' }, false)).toBe(false);
    expect(checkFieldValue({ type: 'TEXT', name: 't' }, null)).toBe(null);
    expect(() => checkFieldValue({ type: 'NUMBER', name: 'n' }, '3')).toThrow();
    expect(() => checkFieldValue({ type: 'DATE', name: 'd' }, '01/12/2026')).toThrow();
    expect(() => checkFieldValue({ type: 'SELECT', name: 's', options: ['A'] }, 'Z')).toThrow();
    expect(() => checkFieldValue({ type: 'TEXT', name: 't' }, 'x'.repeat(501))).toThrow();
  });
});

let app, prisma, owner, editor, viewer, outsider, users, wsId;
beforeAll(() => migrate());
afterAll(async () => { await app?.close(); await prisma?.$disconnect(); });

beforeEach(async () => {
  if (app) { await app.close(); await prisma.$disconnect(); }
  ({ app, prisma } = await setup());
  for (const n of ['owner', 'editor', 'viewer', 'outsider']) await createUser(prisma, n);
  owner = client(app); editor = client(app); viewer = client(app); outsider = client(app);
  await owner.login('owner'); await editor.login('editor'); await viewer.login('viewer'); await outsider.login('outsider');
  wsId = (await owner.post('/api/workspaces', { name: 'Infra' })).json().workspace.id;
  users = Object.fromEntries((await prisma.user.findMany()).map((u) => [u.username, u.id]));
  await owner.put(`/api/workspaces/${wsId}/members/${users.editor}`, { role: 'EDITOR' });
  await owner.put(`/api/workspaces/${wsId}/members/${users.viewer}`, { role: 'VIEWER' });
});

async function newBoard(title = 'Run', ws = wsId, who = owner) {
  const b = (await who.post(`/api/workspaces/${ws}/boards`, { title })).json().board;
  return (await who.get(`/api/boards/${b.id}`)).json().board;
}
const newTask = async (board, title, extra = {}, col = 0) =>
  (await editor.post(`/api/columns/${board.columns[col].id}/tasks`, { title, ...extra })).json().task;

describe('Dépendances entre cartes', () => {
  it('bloque, signale la carte bloquée et la libère quand la bloquante est terminée', async () => {
    const board = await newBoard();
    const a = await newTask(board, 'Commander les serveurs');
    const b = await newTask(board, 'Installer les serveurs');
    expect((await viewer.post(`/api/tasks/${b.id}/dependencies`, { blockerId: a.id })).statusCode).toBe(403);
    expect((await outsider.post(`/api/tasks/${b.id}/dependencies`, { blockerId: a.id })).statusCode).toBe(404);
    expect((await editor.post(`/api/tasks/${b.id}/dependencies`, { blockerId: a.id })).statusCode).toBe(201);
    expect((await editor.post(`/api/tasks/${b.id}/dependencies`, { blockerId: a.id })).statusCode).toBe(200);
    expect((await editor.post(`/api/tasks/${b.id}/dependencies`, { blockerId: b.id })).statusCode).toBe(400);

    let loaded = (await viewer.get(`/api/boards/${board.id}`)).json().board;
    let tb = loaded.columns.flatMap((c) => c.tasks).find((t) => t.id === b.id);
    expect(tb.blocked).toBe(true);
    expect(tb.blockedByIds).toEqual([a.id]);

    const detail = (await viewer.get(`/api/tasks/${b.id}`)).json().task;
    expect(detail.blockedBy).toEqual([expect.objectContaining({ id: a.id, title: 'Commander les serveurs', done: false })]);
    expect((await viewer.get(`/api/tasks/${a.id}`)).json().task.blocks[0].id).toBe(b.id);

    // La carte bloquante passe dans la dernière colonne : plus bloquée
    const last = board.columns[board.columns.length - 1];
    expect((await editor.post(`/api/tasks/${a.id}/move`, { columnId: last.id })).statusCode).toBe(200);
    loaded = (await viewer.get(`/api/boards/${board.id}`)).json().board;
    tb = loaded.columns.flatMap((c) => c.tasks).find((t) => t.id === b.id);
    expect(tb.blocked).toBe(false);
    expect((await viewer.get(`/api/tasks/${b.id}`)).json().task.blockedBy[0].done).toBe(true);

    const act = (await viewer.get(`/api/tasks/${b.id}/activity`)).json().activities;
    expect(act.some((x) => x.type === 'dependency' && x.data.added === 'Commander les serveurs')).toBe(true);

    expect((await editor.del(`/api/tasks/${b.id}/dependencies/${a.id}`)).statusCode).toBe(200);
    expect((await viewer.get(`/api/tasks/${b.id}`)).json().task.blockedBy).toEqual([]);
  });

  it('refuse les cycles et les cartes d\'un autre espace', async () => {
    const board = await newBoard();
    const a = await newTask(board, 'A');
    const b = await newTask(board, 'B');
    const c = await newTask(board, 'C');
    await editor.post(`/api/tasks/${b.id}/dependencies`, { blockerId: a.id }); // A bloque B
    await editor.post(`/api/tasks/${c.id}/dependencies`, { blockerId: b.id }); // B bloque C
    const cycle = await editor.post(`/api/tasks/${a.id}/dependencies`, { blockerId: c.id }); // C bloquerait A
    expect(cycle.statusCode).toBe(400);
    expect(cycle.json().error).toMatch(/circulaire/);

    // Autre espace dont l'éditeur est aussi membre : refusé (cloisonnement)
    const ws2 = (await owner.post('/api/workspaces', { name: 'Autre' })).json().workspace.id;
    await owner.put(`/api/workspaces/${ws2}/members/${users.editor}`, { role: 'EDITOR' });
    const foreignBoard = await newBoard('Ailleurs', ws2);
    const f = await newTask(foreignBoard, 'Étrangère');
    expect((await editor.post(`/api/tasks/${a.id}/dependencies`, { blockerId: f.id })).statusCode).toBe(400);
    // Espace dont l'utilisateur n'est pas membre : 404, rien ne fuit
    const ws3 = (await outsider.post('/api/workspaces', { name: 'Privé' })).json().workspace.id;
    const pb = await newBoard('Privé', ws3, outsider);
    const pt = (await outsider.post(`/api/columns/${pb.columns[0].id}/tasks`, { title: 'Secret' })).json().task;
    expect((await editor.post(`/api/tasks/${a.id}/dependencies`, { blockerId: pt.id })).statusCode).toBe(404);
  });

  it('la suppression d\'une carte supprime ses dépendances', async () => {
    const board = await newBoard();
    const a = await newTask(board, 'A');
    const b = await newTask(board, 'B');
    await editor.post(`/api/tasks/${b.id}/dependencies`, { blockerId: a.id });
    expect((await editor.del(`/api/tasks/${a.id}`)).statusCode).toBe(200);
    const tb = (await viewer.get(`/api/tasks/${b.id}`)).json().task;
    expect(tb.blockedBy).toEqual([]);
  });
});

describe('Champs personnalisés et estimation', () => {
  it('crée des champs, valide les valeurs, exporte en CSV', async () => {
    const board = await newBoard();
    expect((await viewer.post(`/api/boards/${board.id}/fields`, { name: 'Env', type: 'TEXT' })).statusCode).toBe(403);
    expect((await editor.post(`/api/boards/${board.id}/fields`, { name: 'Env', type: 'SELECT' })).statusCode).toBe(400);
    const env = (await editor.post(`/api/boards/${board.id}/fields`, { name: 'Environnement', type: 'SELECT', options: ['Prod', 'Recette'] })).json().field;
    const ticket = (await editor.post(`/api/boards/${board.id}/fields`, { name: 'Ticket', type: 'TEXT' })).json().field;
    const cab = (await editor.post(`/api/boards/${board.id}/fields`, { name: 'Validé CAB', type: 'CHECKBOX' })).json().field;

    const t = await newTask(board, 'Bascule DNS', { estimate: 3 });
    expect(t.estimate).toBe(3);
    expect((await editor.patch(`/api/tasks/${t.id}`, { estimate: -1 })).statusCode).toBe(400);
    expect((await editor.put(`/api/tasks/${t.id}/fields/${env.id}`, { value: 'Dev' })).statusCode).toBe(400);
    expect((await viewer.put(`/api/tasks/${t.id}/fields/${env.id}`, { value: 'Prod' })).statusCode).toBe(403);
    expect((await editor.put(`/api/tasks/${t.id}/fields/${env.id}`, { value: 'Prod' })).json().value).toBe('Prod');
    await editor.put(`/api/tasks/${t.id}/fields/${ticket.id}`, { value: '=CMD()' });
    await editor.put(`/api/tasks/${t.id}/fields/${cab.id}`, { value: true });

    // Champ d'un autre tableau refusé
    const other = await newBoard('Autre');
    const foreign = (await editor.post(`/api/boards/${other.id}/fields`, { name: 'X', type: 'TEXT' })).json().field;
    expect((await editor.put(`/api/tasks/${t.id}/fields/${foreign.id}`, { value: 'x' })).statusCode).toBe(400);

    const loaded = (await viewer.get(`/api/boards/${board.id}`)).json().board;
    expect(loaded.fields.map((f) => f.name)).toEqual(['Environnement', 'Ticket', 'Validé CAB']);
    const card = loaded.columns[0].tasks.find((x) => x.id === t.id);
    expect(card.fieldValues).toEqual({ [env.id]: 'Prod', [ticket.id]: '=CMD()', [cab.id]: true });

    const csv = (await viewer.get(`/api/boards/${board.id}/export.csv`)).body;
    expect(csv).toContain('Estimation');
    expect(csv).toContain('Environnement');
    expect(csv).toContain('Prod');
    expect(csv).toContain('\'=CMD()');
    expect(csv).toContain('oui');

    // Effacement d'une valeur, journal
    expect((await editor.put(`/api/tasks/${t.id}/fields/${ticket.id}`, { value: '' })).json().value).toBe(null);
    const act = (await viewer.get(`/api/tasks/${t.id}/activity`)).json().activities;
    expect(act.some((x) => x.type === 'field' && x.data.name === 'Environnement' && x.data.to === 'Prod')).toBe(true);

    // Option retirée : les valeurs qui l'utilisaient sont effacées
    expect((await editor.patch(`/api/fields/${env.id}`, { options: ['Recette'] })).statusCode).toBe(200);
    expect((await viewer.get(`/api/tasks/${t.id}`)).json().task.fieldValues[env.id]).toBeUndefined();
    expect((await editor.patch(`/api/fields/${ticket.id}`, { options: ['a'] })).statusCode).toBe(400);
    expect((await editor.del(`/api/fields/${cab.id}`)).statusCode).toBe(200);
    expect((await viewer.get(`/api/tasks/${t.id}`)).json().task.fieldValues).toEqual({});
  });

  it('duplication et transfert reprennent les valeurs compatibles', async () => {
    const a = await newBoard('A');
    const b = await newBoard('B');
    const envA = (await editor.post(`/api/boards/${a.id}/fields`, { name: 'Env', type: 'SELECT', options: ['Prod', 'Recette'] })).json().field;
    const pts = (await editor.post(`/api/boards/${a.id}/fields`, { name: 'Points', type: 'NUMBER' })).json().field;
    const envB = (await editor.post(`/api/boards/${b.id}/fields`, { name: 'env', type: 'SELECT', options: ['Prod'] })).json().field;
    await editor.post(`/api/boards/${b.id}/fields`, { name: 'Points', type: 'TEXT' }); // type différent : non repris

    const t = await newTask(a, 'Carte', { estimate: 2 });
    await editor.put(`/api/tasks/${t.id}/fields/${envA.id}`, { value: 'Prod' });
    await editor.put(`/api/tasks/${t.id}/fields/${pts.id}`, { value: 5 });

    const copy = (await editor.post(`/api/tasks/${t.id}/duplicate`)).json().task;
    const copyDetail = (await viewer.get(`/api/tasks/${copy.id}`)).json().task;
    expect(copyDetail.estimate).toBe(2);
    expect(copyDetail.fieldValues).toEqual({ [envA.id]: 'Prod', [pts.id]: 5 });

    expect((await editor.post(`/api/tasks/${t.id}/transfer`, { boardId: b.id })).statusCode).toBe(200);
    expect((await viewer.get(`/api/tasks/${t.id}`)).json().task.fieldValues).toEqual({ [envB.id]: 'Prod' });
  });

  it('limite le nombre de champs par tableau', async () => {
    const board = await newBoard();
    for (let i = 0; i < 20; i++) expect((await editor.post(`/api/boards/${board.id}/fields`, { name: `F${i}`, type: 'TEXT' })).statusCode).toBe(201);
    expect((await editor.post(`/api/boards/${board.id}/fields`, { name: 'F21', type: 'TEXT' })).statusCode).toBe(400);
  });
});

describe('Recherche de cartes de l\'espace', () => {
  it('cherche par titre dans l\'espace uniquement', async () => {
    const board = await newBoard();
    await newTask(board, 'Renouveler le certificat VPN');
    await newTask(board, 'Patch Tuesday');
    const r = (await viewer.get(`/api/workspaces/${wsId}/tasks?q=certif`)).json().tasks;
    expect(r.map((t) => t.title)).toEqual(['Renouveler le certificat VPN']);
    expect(r[0].board?.title ?? r[0].boardTitle).toBe('Run');
    expect((await outsider.get(`/api/workspaces/${wsId}/tasks?q=certif`)).statusCode).toBe(404);
  });
});

describe('Wiki : blocs sous-pages, sommaire et diagramme', () => {
  it('accepte les nouveaux blocs, en retire les attributs et les exporte en Markdown', async () => {
    const { sanitizeDoc, docToMarkdown } = await import('../src/server/lib/wikidoc.js');
    const doc = sanitizeDoc({ type: 'doc', content: [
      { type: 'toc', attrs: { onclick: 'x' } },
      { type: 'subpages' },
      { type: 'codeBlock', attrs: { language: 'mermaid' }, content: [{ type: 'text', text: 'flowchart LR\n A --> B' }] },
    ] });
    expect(doc.content.map((n) => n.type)).toEqual(['toc', 'subpages', 'codeBlock']);
    expect(doc.content[0].attrs).toBeUndefined();
    expect(doc.content[2].attrs.language).toBe('mermaid');
    const md = docToMarkdown('Page', doc);
    expect(md).toContain('```mermaid\nflowchart LR');
    expect(md).toContain('<!-- sommaire -->');
  });
});

describe('Champs : pas de conversion implicite des valeurs', () => {
  it('garde le type envoyé (texte numérique, booléen) et refuse les objets', async () => {
    const board = await newBoard();
    const txt = (await editor.post(`/api/boards/${board.id}/fields`, { name: 'Ticket', type: 'TEXT' })).json().field;
    const cb = (await editor.post(`/api/boards/${board.id}/fields`, { name: 'CAB', type: 'CHECKBOX' })).json().field;
    const t = await newTask(board, 'Carte');
    expect((await editor.put(`/api/tasks/${t.id}/fields/${txt.id}`, { value: '42' })).json().value).toBe('42');
    expect((await editor.put(`/api/tasks/${t.id}/fields/${cb.id}`, { value: true })).json().value).toBe(true);
    expect((await editor.put(`/api/tasks/${t.id}/fields/${cb.id}`, { value: 'true' })).statusCode).toBe(400);
    expect((await editor.put(`/api/tasks/${t.id}/fields/${txt.id}`, { value: { a: 1 } })).statusCode).toBe(400);
  });
});
