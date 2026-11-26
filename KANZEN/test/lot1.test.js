// Lot 1 « Kanban et Wiki » : étiquettes, priorité, dates, archivage, journal d'activité, duplication et transfert
// de cartes, commentaires modifiables ; wiki : commentaires de page, page vérifiée, modèles d'équipe, duplication.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setup, migrate, createUser, client } from './helpers.js';
import { remapFiles } from '../src/server/lib/wikidoc.js';

const doc = (...content) => ({ type: 'doc', content });
const p = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const FILE_A = '123e4567-e89b-12d3-a456-426614174000';
const FILE_B = '123e4567-e89b-12d3-a456-426614174999';

describe('remapFiles', () => {
  it('réécrit les fichiers connus et retire les autres', () => {
    const out = remapFiles(doc(
      { type: 'image', attrs: { src: `/api/wiki/files/${FILE_A}`, alt: 'schéma' } },
      { type: 'fileAttachment', attrs: { src: `/api/wiki/files/${FILE_B}`, filename: 'x.pdf' } },
      p('texte'),
    ), new Map([[FILE_A, FILE_B]]));
    expect(out.content).toHaveLength(2);
    expect(out.content[0].attrs.src).toBe(`/api/wiki/files/${FILE_B}`);
    expect(out.content[0].attrs.alt).toBe('schéma');
    expect(out.content[1].type).toBe('paragraph');
  });
});

let app, prisma, uploadDir, owner, editor, editor2, viewer, outsider, users, wsId;
beforeAll(() => migrate());
afterAll(async () => { await app?.close(); await prisma?.$disconnect(); });

beforeEach(async () => {
  if (app) { await app.close(); await prisma.$disconnect(); }
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kz-lot1-'));
  ({ app, prisma } = await setup({ env: { upload: { dir: uploadDir, maxMb: 1, allowedMime: ['image/png', 'application/pdf'] } } }));
  for (const n of ['owner', 'editor', 'editor2', 'viewer', 'outsider']) await createUser(prisma, n);
  owner = client(app); editor = client(app); editor2 = client(app); viewer = client(app); outsider = client(app);
  await owner.login('owner'); await editor.login('editor'); await editor2.login('editor2'); await viewer.login('viewer'); await outsider.login('outsider');
  wsId = (await owner.post('/api/workspaces', { name: 'Infra' })).json().workspace.id;
  users = Object.fromEntries((await prisma.user.findMany()).map((u) => [u.username, u.id]));
  await owner.put(`/api/workspaces/${wsId}/members/${users.editor}`, { role: 'EDITOR' });
  await owner.put(`/api/workspaces/${wsId}/members/${users.editor2}`, { role: 'EDITOR' });
  await owner.put(`/api/workspaces/${wsId}/members/${users.viewer}`, { role: 'VIEWER' });
});

async function newBoard(title = 'Run') {
  const b = (await owner.post(`/api/workspaces/${wsId}/boards`, { title })).json().board;
  const board = (await owner.get(`/api/boards/${b.id}`)).json().board;
  return board;
}

describe('Kanban : étiquettes, priorité, dates', () => {
  it('crée des étiquettes par tableau et les pose sur une carte', async () => {
    const board = await newBoard();
    const sec = await editor.post(`/api/boards/${board.id}/labels`, { name: ' Sécurité ', color: 'red' });
    expect(sec.statusCode).toBe(201);
    expect(sec.json().label.name).toBe('Sécurité');
    expect((await viewer.post(`/api/boards/${board.id}/labels`, { name: 'X', color: 'red' })).statusCode).toBe(403);
    expect((await outsider.post(`/api/boards/${board.id}/labels`, { name: 'X', color: 'red' })).statusCode).toBe(404);
    expect((await editor.post(`/api/boards/${board.id}/labels`, { name: 'X', color: 'fuchsia' })).statusCode).toBe(400);
    const net = (await editor.post(`/api/boards/${board.id}/labels`, { name: 'Réseau', color: 'blue' })).json().label;

    const task = (await editor.post(`/api/columns/${board.columns[0].id}/tasks`, {
      title: 'Renouveler le certificat', labelIds: [sec.json().label.id], priority: 'HIGH',
      startDate: '2026-12-01T12:00:00Z', dueDate: '2026-12-10T12:00:00Z',
    })).json().task;
    expect(task.labelIds).toEqual([sec.json().label.id]);
    expect(task.priority).toBe('HIGH');

    // Étiquette d'un autre tableau refusée
    const other = await newBoard('Projets');
    const foreign = (await editor.post(`/api/boards/${other.id}/labels`, { name: 'Autre', color: 'gray' })).json().label;
    expect((await editor.patch(`/api/tasks/${task.id}`, { labelIds: [foreign.id] })).statusCode).toBe(400);
    // Début après l'échéance refusé
    expect((await editor.patch(`/api/tasks/${task.id}`, { startDate: '2026-12-20T12:00:00Z' })).statusCode).toBe(400);

    await editor.patch(`/api/tasks/${task.id}`, { labelIds: [sec.json().label.id, net.id] });
    const loaded = (await viewer.get(`/api/boards/${board.id}`)).json().board;
    expect(loaded.labels.map((l) => l.name)).toEqual(['Sécurité', 'Réseau']);
    expect(loaded.columns[0].tasks[0].labelIds).toHaveLength(2);

    // Suppression de l'étiquette : retirée des cartes
    expect((await editor.del(`/api/labels/${net.id}`)).statusCode).toBe(200);
    expect((await viewer.get(`/api/tasks/${task.id}`)).json().task.labelIds).toEqual([sec.json().label.id]);

    const csv = (await viewer.get(`/api/boards/${board.id}/export.csv`)).body;
    expect(csv).toContain('Priorite');
    expect(csv).toContain('Haute');
    expect(csv).toContain('Sécurité');
  });
});

describe('Kanban : archivage', () => {
  it('archive une carte, la masque du tableau, puis la restaure', async () => {
    const board = await newBoard();
    const col = board.columns[0].id;
    const task = (await editor.post(`/api/columns/${col}/tasks`, { title: 'Ancienne demande', dueDate: '2020-01-01T12:00:00Z' })).json().task;
    expect((await viewer.post(`/api/tasks/${task.id}/archive`)).statusCode).toBe(403);
    expect((await editor.post(`/api/tasks/${task.id}/archive`)).statusCode).toBe(200);

    const b = (await viewer.get(`/api/boards/${board.id}`)).json().board;
    expect(b.columns[0].tasks).toHaveLength(0);
    expect(b.archivedCount).toBe(1);
    expect((await viewer.get(`/api/boards/${board.id}/stats`)).json().overdue).toBe(0);
    const archived = (await viewer.get(`/api/boards/${board.id}/archived`)).json().tasks;
    expect(archived.map((t) => t.title)).toEqual(['Ancienne demande']);
    expect((await outsider.get(`/api/boards/${board.id}/archived`)).statusCode).toBe(404);
    // Une carte archivée ne se déplace pas
    expect((await editor.post(`/api/tasks/${task.id}/move`, { columnId: board.columns[1].id })).statusCode).toBe(409);

    expect((await editor.post(`/api/tasks/${task.id}/restore`)).statusCode).toBe(200);
    expect((await viewer.get(`/api/boards/${board.id}`)).json().board.columns[0].tasks).toHaveLength(1);
  });
});

describe('Kanban : journal d\'activité', () => {
  it('trace création, modifications, déplacement, commentaire et archivage', async () => {
    const board = await newBoard();
    const label = (await editor.post(`/api/boards/${board.id}/labels`, { name: 'Urgent', color: 'red' })).json().label;
    const task = (await editor.post(`/api/columns/${board.columns[0].id}/tasks`, { title: 'Patch' })).json().task;
    await editor.patch(`/api/tasks/${task.id}`, { title: 'Patch Tuesday', priority: 'CRITICAL', assigneeIds: [users.editor2], labelIds: [label.id] });
    await editor.patch(`/api/tasks/${task.id}`, { title: 'Patch Tuesday' }); // aucune modification réelle : rien n'est tracé
    await editor.post(`/api/tasks/${task.id}/move`, { columnId: board.columns[1].id });
    await editor.post(`/api/tasks/${task.id}/comments`, { content: 'fait sur la recette' });
    await editor.post(`/api/tasks/${task.id}/archive`);

    const r = await viewer.get(`/api/tasks/${task.id}/activity`);
    expect(r.statusCode).toBe(200);
    const acts = r.json().activities.reverse();
    expect(acts.map((a) => a.type)).toEqual(['create', 'update', 'move', 'comment', 'archive']);
    const changes = acts[1].data.changes;
    expect(changes.map((c) => c.field).sort()).toEqual(['assignees', 'labels', 'priority', 'title']);
    expect(changes.find((c) => c.field === 'assignees').added).toEqual(['editor2']);
    expect(changes.find((c) => c.field === 'labels').added).toEqual(['Urgent']);
    expect(acts[2].data).toEqual({ from: 'À faire', to: 'En cours' });
    expect(acts[0].actor.displayName).toBe('editor');
    expect((await outsider.get(`/api/tasks/${task.id}/activity`)).statusCode).toBe(404);
  });
});

describe('Kanban : duplication et transfert', () => {
  it('duplique une carte juste en dessous, avec étiquettes et liste de contrôle décochée', async () => {
    const board = await newBoard();
    const col = board.columns[0].id;
    const label = (await editor.post(`/api/boards/${board.id}/labels`, { name: 'PKI', color: 'purple' })).json().label;
    const a = (await editor.post(`/api/columns/${col}/tasks`, { title: 'Revue des comptes', labelIds: [label.id], assigneeIds: [users.editor], priority: 'MEDIUM' })).json().task;
    await editor.post(`/api/columns/${col}/tasks`, { title: 'Suivante' });
    const st = (await editor.post(`/api/tasks/${a.id}/subtasks`, { content: 'Exporter la liste' })).json().subtask;
    await editor.patch(`/api/subtasks/${st.id}`, { completed: true });

    expect((await viewer.post(`/api/tasks/${a.id}/duplicate`, {})).statusCode).toBe(403);
    const r = await editor.post(`/api/tasks/${a.id}/duplicate`, {});
    expect(r.statusCode).toBe(201);
    const copy = r.json().task;
    expect(copy.title).toBe('Revue des comptes (copie)');
    expect(copy.labelIds).toEqual([label.id]);
    expect(copy.priority).toBe('MEDIUM');
    const titles = (await viewer.get(`/api/boards/${board.id}`)).json().board.columns[0].tasks.map((t) => t.title);
    expect(titles).toEqual(['Revue des comptes', 'Revue des comptes (copie)', 'Suivante']);
    const detail = (await viewer.get(`/api/tasks/${copy.id}`)).json().task;
    expect(detail.subtasks.map((s) => [s.content, s.completed])).toEqual([['Exporter la liste', false]]);
    expect(detail.assignees.map((u) => u.username)).toEqual(['editor']);
  });

  it('transfère une carte vers un autre tableau du même espace, étiquettes reprises par nom', async () => {
    const src = await newBoard('Run');
    const dst = await newBoard('Projets');
    const l1 = (await editor.post(`/api/boards/${src.id}/labels`, { name: 'Réseau', color: 'blue' })).json().label;
    const l2 = (await editor.post(`/api/boards/${src.id}/labels`, { name: 'Sécurité', color: 'red' })).json().label;
    const existing = (await editor.post(`/api/boards/${dst.id}/labels`, { name: 'réseau', color: 'teal' })).json().label;
    const task = (await editor.post(`/api/columns/${src.columns[1].id}/tasks`, { title: 'Migrer le pare-feu', labelIds: [l1.id, l2.id] })).json().task;

    const r = await editor.post(`/api/tasks/${task.id}/transfer`, { boardId: dst.id });
    expect(r.statusCode).toBe(200);
    expect(r.json().task.columnId).toBe(dst.columns[0].id);
    const d = (await viewer.get(`/api/boards/${dst.id}`)).json().board;
    expect(d.columns[0].tasks.map((t) => t.title)).toEqual(['Migrer le pare-feu']);
    expect(d.labels.map((l) => l.name).sort()).toEqual(['réseau', 'Sécurité'].sort());
    expect(d.columns[0].tasks[0].labelIds).toContain(existing.id);
    expect((await viewer.get(`/api/boards/${src.id}`)).json().board.columns[1].tasks).toHaveLength(0);

    // Autre espace : refusé
    const ws2 = (await editor.post('/api/workspaces', { name: 'Perso' })).json().workspace.id;
    const b2 = (await editor.post(`/api/workspaces/${ws2}/boards`, { title: 'Perso' })).json().board;
    expect((await editor.post(`/api/tasks/${task.id}/transfer`, { boardId: b2.id })).statusCode).toBe(400);
    // Tableau sans droit d'écriture : refusé sans révéler son existence
    const ws3 = (await outsider.post('/api/workspaces', { name: 'Ailleurs' })).json().workspace.id;
    const b3 = (await outsider.post(`/api/workspaces/${ws3}/boards`, { title: 'X' })).json().board;
    expect((await editor.post(`/api/tasks/${task.id}/transfer`, { boardId: b3.id })).statusCode).toBe(404);
  });
});

describe('Kanban : commentaires modifiables', () => {
  it('seul l\'auteur modifie son commentaire', async () => {
    const board = await newBoard();
    const task = (await editor.post(`/api/columns/${board.columns[0].id}/tasks`, { title: 'T' })).json().task;
    const c = (await editor.post(`/api/tasks/${task.id}/comments`, { content: 'premier jet' })).json().comment;
    expect((await editor2.patch(`/api/comments/${c.id}`, { content: 'pirate' })).statusCode).toBe(403);
    expect((await owner.patch(`/api/comments/${c.id}`, { content: 'pirate' })).statusCode).toBe(403);
    const r = await editor.patch(`/api/comments/${c.id}`, { content: 'version corrigée' });
    expect(r.statusCode).toBe(200);
    expect(r.json().comment.editedAt).toBeTruthy();
    expect((await viewer.get(`/api/tasks/${task.id}`)).json().task.comments[0].content).toBe('version corrigée');
  });
});

describe('Kanban : réordonner les colonnes', () => {
  it('déplace une colonne par sa position', async () => {
    const board = await newBoard();
    const [a, b] = board.columns;
    expect((await editor.patch(`/api/columns/${b.id}`, { position: a.position - 500 })).statusCode).toBe(200);
    const cols = (await viewer.get(`/api/boards/${board.id}`)).json().board.columns.map((c) => c.id);
    expect(cols.slice(0, 2)).toEqual([b.id, a.id]);
  });
});

// ---------------------------------------------------------------------------

const createPage = async (c, body) => (await c.post(`/api/workspaces/${wsId}/wiki`, body)).json().page;

describe('Wiki : commentaires de page', () => {
  it('fil de discussion, réponses, résolution, droits', async () => {
    const page = await createPage(editor, { title: 'Procédure sauvegarde', content: doc(p('pg_dump')) });
    expect((await viewer.post(`/api/wiki/pages/${page.id}/comments`, { content: 'x' })).statusCode).toBe(403);
    const c1 = await editor2.post(`/api/wiki/pages/${page.id}/comments`, { content: 'L\'étape 3 est obsolète' });
    expect(c1.statusCode).toBe(201);
    const root = c1.json().comment;
    const reply = (await editor.post(`/api/wiki/pages/${page.id}/comments`, { content: 'Corrigé', parentId: root.id })).json().comment;
    // Pas de réponse à une réponse
    expect((await editor.post(`/api/wiki/pages/${page.id}/comments`, { content: 'x', parentId: reply.id })).statusCode).toBe(400);
    // Pas de réponse à un commentaire d'une autre page
    const other = await createPage(editor, { title: 'Autre' });
    expect((await editor.post(`/api/wiki/pages/${other.id}/comments`, { content: 'x', parentId: root.id })).statusCode).toBe(400);

    expect((await editor.post(`/api/wiki/comments/${reply.id}/resolve`, { resolved: true })).statusCode).toBe(400);
    expect((await editor.post(`/api/wiki/comments/${root.id}/resolve`, { resolved: true })).statusCode).toBe(200);
    let threads = (await viewer.get(`/api/wiki/pages/${page.id}/comments`)).json().threads;
    expect(threads).toHaveLength(1);
    expect(threads[0].resolvedBy.displayName).toBe('editor');
    expect(threads[0].replies.map((r) => r.content)).toEqual(['Corrigé']);
    // Une nouvelle réponse rouvre le fil
    await editor2.post(`/api/wiki/pages/${page.id}/comments`, { content: 'Merci, mais l\'étape 4 aussi', parentId: root.id });
    threads = (await viewer.get(`/api/wiki/pages/${page.id}/comments`)).json().threads;
    expect(threads[0].resolvedAt).toBeNull();

    expect((await editor.patch(`/api/wiki/comments/${root.id}`, { content: 'pirate' })).statusCode).toBe(403);
    expect((await editor2.patch(`/api/wiki/comments/${root.id}`, { content: 'L\'étape 3 est fausse' })).json().comment.editedAt).toBeTruthy();
    expect((await editor.del(`/api/wiki/comments/${root.id}`)).statusCode).toBe(403);
    expect((await owner.del(`/api/wiki/comments/${root.id}`)).statusCode).toBe(200);
    expect((await viewer.get(`/api/wiki/pages/${page.id}/comments`)).json().threads).toHaveLength(0);
    expect(await prisma.wikiComment.count()).toBe(0);
    expect((await outsider.get(`/api/wiki/pages/${page.id}/comments`)).statusCode).toBe(404);
  });

  it('respecte l\'accès restreint de la page', async () => {
    const page = await createPage(owner, { title: 'RH' });
    const c = (await owner.post(`/api/wiki/pages/${page.id}/comments`, { content: 'confidentiel' })).json().comment;
    await owner.put(`/api/wiki/pages/${page.id}/access`, { restricted: true, userIds: [] });
    expect((await editor.get(`/api/wiki/pages/${page.id}/comments`)).statusCode).toBe(404);
    expect((await editor.post(`/api/wiki/comments/${c.id}/resolve`, { resolved: true })).statusCode).toBe(404);
    expect((await editor.del(`/api/wiki/comments/${c.id}`)).statusCode).toBe(404);
  });
});

describe('Wiki : page vérifiée', () => {
  it('propriétaire, vérification, échéance de revue et liste « à revoir »', async () => {
    const page = await createPage(editor, { title: 'PRA' });
    expect((await viewer.post(`/api/wiki/pages/${page.id}/verify`)).statusCode).toBe(403);
    expect((await editor.put(`/api/wiki/pages/${page.id}/verification`, { ownerId: users.outsider })).statusCode).toBe(400);
    expect((await editor.put(`/api/wiki/pages/${page.id}/verification`, { reviewEveryDays: 45 })).statusCode).toBe(400);
    let v = (await editor.put(`/api/wiki/pages/${page.id}/verification`, { ownerId: users.editor2, reviewEveryDays: 90 })).json().verification;
    expect(v.status).toBe('expired'); // périodicité fixée mais jamais vérifiée
    expect(v.owner.username).toBe('editor2');

    v = (await editor2.post(`/api/wiki/pages/${page.id}/verify`)).json().verification;
    expect(v.status).toBe('verified');
    expect(v.verifiedBy.username).toBe('editor2');
    expect((await viewer.get(`/api/wiki/pages/${page.id}`)).json().page.verification.status).toBe('verified');

    // Vérification ancienne : la page passe « à revoir »
    await prisma.wikiPage.update({ where: { id: page.id }, data: { verifiedAt: new Date(Date.now() - 100 * 86400_000) } });
    expect((await viewer.get(`/api/wiki/pages/${page.id}`)).json().page.verification.status).toBe('expired');
    const review = (await editor2.get(`/api/workspaces/${wsId}/wiki/review`)).json();
    expect(review.expired.map((x) => x.title)).toEqual(['PRA']);
    expect(review.mine.map((x) => x.title)).toEqual(['PRA']);
    expect((await outsider.get(`/api/workspaces/${wsId}/wiki/review`)).statusCode).toBe(404);

    // Page restreinte : absente de la liste pour ceux qui ne la voient pas
    await owner.put(`/api/wiki/pages/${page.id}/access`, { restricted: true, userIds: [users.editor2] });
    expect((await viewer.get(`/api/workspaces/${wsId}/wiki/review`)).json().expired).toHaveLength(0);

    expect((await editor2.del(`/api/wiki/pages/${page.id}/verify`)).json().verification.verifiedAt).toBeNull();
  });

  it('vérifier sans propriétaire désigné en fait le propriétaire', async () => {
    const page = await createPage(editor, { title: 'Annuaire' });
    const v = (await editor.post(`/api/wiki/pages/${page.id}/verify`)).json().verification;
    expect(v.owner.username).toBe('editor');
    expect(v.status).toBe('verified');
  });
});

describe('Wiki : modèles d\'équipe', () => {
  it('crée un modèle depuis une page (fichiers retirés), le liste et le supprime', async () => {
    const page = await createPage(editor, {
      title: 'Compte rendu CAB',
      content: doc(p('Participants'), { type: 'image', attrs: { src: `/api/wiki/files/${FILE_A}` } }),
    });
    expect((await viewer.post(`/api/workspaces/${wsId}/wiki/templates`, { title: 'CAB', pageId: page.id })).statusCode).toBe(403);
    const r = await editor.post(`/api/workspaces/${wsId}/wiki/templates`, { title: 'Compte rendu CAB', icon: '🗓️', description: 'Ordre du jour et décisions', pageId: page.id });
    expect(r.statusCode).toBe(201);
    const tpl = r.json().template;
    expect(tpl.content.content.map((n) => n.type)).toEqual(['paragraph']);

    // Depuis un contenu fourni : assaini comme une page
    const raw = await editor.post(`/api/workspaces/${wsId}/wiki/templates`, { title: 'Brut', content: doc({ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }) });
    expect(JSON.stringify(raw.json().template.content)).not.toContain('javascript');

    // Page d'un autre espace : refusée
    const ws2 = (await editor.post('/api/workspaces', { name: 'Perso' })).json().workspace.id;
    const foreign = (await editor.post(`/api/workspaces/${ws2}/wiki`, { title: 'Ailleurs' })).json().page;
    expect((await editor.post(`/api/workspaces/${wsId}/wiki/templates`, { title: 'X', pageId: foreign.id })).statusCode).toBe(400);

    const list = (await viewer.get(`/api/workspaces/${wsId}/wiki/templates`)).json().templates;
    expect(list.map((t) => t.title)).toEqual(['Brut', 'Compte rendu CAB']);
    expect((await outsider.get(`/api/workspaces/${wsId}/wiki/templates`)).statusCode).toBe(404);

    expect((await editor2.patch(`/api/wiki/templates/${tpl.id}`, { description: 'Mis à jour' })).statusCode).toBe(200);
    expect((await editor2.del(`/api/wiki/templates/${tpl.id}`)).statusCode).toBe(403);
    expect((await owner.del(`/api/wiki/templates/${tpl.id}`)).statusCode).toBe(200);
  });
});

describe('Wiki : duplication', () => {
  it('duplique une page et ses sous-pages, copie les fichiers et la restriction', async () => {
    const root = await createPage(editor, { title: 'Exploitation' });
    const boundary = '----kz';
    const up = await editor.raw('POST', `/api/wiki/pages/${root.id}/files`,
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="plan.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4\r\n--${boundary}--\r\n`,
      { 'content-type': `multipart/form-data; boundary=${boundary}` });
    const file = up.json().file;
    await editor.patch(`/api/wiki/pages/${root.id}`, { version: 1, content: doc(p('intro'), { type: 'fileAttachment', attrs: { src: file.url, filename: 'plan.pdf' } }) });
    const child = await createPage(editor, { title: 'Sauvegardes', parentId: root.id, content: doc(p('pg_dump')) });
    const secret = await createPage(owner, { title: 'Comptes de service', parentId: root.id });
    await owner.put(`/api/wiki/pages/${secret.id}/access`, { restricted: true, userIds: [users.editor2] });
    await createPage(editor, { title: 'Après' });

    expect((await viewer.post(`/api/wiki/pages/${root.id}/duplicate`, {})).statusCode).toBe(403);
    // editor ne voit pas la sous-page restreinte : elle n'est pas copiée
    const r = await editor.post(`/api/wiki/pages/${root.id}/duplicate`, { withChildren: true });
    expect(r.statusCode).toBe(201);
    expect(r.json().count).toBe(2);
    const copy = r.json().page;
    expect(copy.title).toBe('Exploitation (copie)');
    const newFile = copy.content.content[1].attrs.src;
    expect(newFile).not.toBe(file.url);
    expect((await viewer.get(newFile)).statusCode).toBe(200);
    expect(fs.readdirSync(uploadDir).filter((f) => !f.startsWith('.'))).toHaveLength(2);

    const tree = (await editor.get(`/api/workspaces/${wsId}/wiki`)).json().pages;
    const roots = tree.filter((x) => !x.parentId).map((x) => x.title);
    expect(roots).toEqual(['Exploitation', 'Exploitation (copie)', 'Après']);
    const kids = tree.filter((x) => x.parentId === copy.id).map((x) => x.title);
    expect(kids).toEqual(['Sauvegardes']);
    expect(tree.find((x) => x.parentId === copy.id).id).not.toBe(child.id);

    // editor2 voit la sous-page restreinte : sa copie reste restreinte à editor2
    const r2 = (await editor2.post(`/api/wiki/pages/${root.id}/duplicate`, { withChildren: true })).json();
    expect(r2.count).toBe(3);
    const copied = await prisma.wikiPage.findFirst({ where: { title: 'Comptes de service', NOT: { id: secret.id } }, include: { access: true } });
    expect(copied.restricted).toBe(true);
    expect(copied.access.map((a) => a.userId)).toEqual([users.editor2]);
    expect((await editor.get(`/api/wiki/pages/${copied.id}`)).statusCode).toBe(404);

    // Page seule
    const solo = (await editor.post(`/api/wiki/pages/${child.id}/duplicate`, {})).json();
    expect(solo.count).toBe(1);
    expect(solo.page.parentId).toBe(root.id);
  });
});
