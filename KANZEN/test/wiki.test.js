import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setup, migrate, createUser, client } from './helpers.js';
import { sanitizeDoc, docText, docToMarkdown, safeHref } from '../src/server/lib/wikidoc.js';

const doc = (...content) => ({ type: 'doc', content });
const p = (text, marks) => ({ type: 'paragraph', content: [{ type: 'text', text, ...(marks ? { marks } : {}) }] });

describe('documents du wiki (validation)', () => {
  it('refuse un nœud inconnu (HTML brut, iframe…)', () => {
    expect(() => sanitizeDoc(doc({ type: 'html', content: [] }))).toThrow(/non autorisé/);
    expect(() => sanitizeDoc({ type: 'paragraph' })).toThrow(/racine/);
  });

  it('neutralise les liens dangereux et garde le texte', () => {
    const out = sanitizeDoc(doc(p('clic', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }])));
    expect(out.content[0].content[0]).toEqual({ type: 'text', text: 'clic' });
    for (const bad of ['javascript:x', 'JaVaScRiPt:x', 'data:text/html,x', '//evil.example', 'vbscript:x', ' java\tscript:x']) expect(safeHref(bad)).toBeNull();
    for (const ok of ['https://intranet.corp.local/x', 'mailto:a@b.c', '/wiki/123', '#titre']) expect(safeHref(ok)).toBe(ok);
  });

  it('retire les images externes et les attributs non prévus', () => {
    const out = sanitizeDoc(doc(
      { type: 'image', attrs: { src: 'https://tracker.example/p.gif' } },
      { type: 'image', attrs: { src: '/api/wiki/files/123e4567-e89b-12d3-a456-426614174000', alt: 'schéma', onerror: 'alert(1)' } },
      { type: 'heading', attrs: { level: 9, style: 'x' }, content: [{ type: 'text', text: 'T' }] },
    ));
    expect(out.content).toHaveLength(2);
    expect(out.content[0].attrs).toEqual({ src: '/api/wiki/files/123e4567-e89b-12d3-a456-426614174000', alt: 'schéma' });
    expect(out.content[1].attrs).toBeUndefined();
  });

  it('extrait le texte et exporte en Markdown', () => {
    const d = doc(
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Procédure' }] },
      p('Redémarrer ', undefined),
      { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [p('sauvegarde')] }] },
    );
    expect(docText(d)).toContain('Procédure');
    const md = docToMarkdown('Runbook', d);
    expect(md).toContain('# Runbook');
    expect(md).toContain('## Procédure');
    expect(md).toContain('- [x] sauvegarde');
  });
});

describe('wiki (API)', () => {
  let app, prisma, owner, editor, viewer, outsider, wsId, uploadDir;
  beforeAll(() => migrate());
  afterAll(async () => { await app?.close(); await prisma?.$disconnect(); });

  beforeEach(async () => {
    if (app) { await app.close(); await prisma.$disconnect(); }
    uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kz-wiki-'));
    ({ app, prisma } = await setup({ env: { upload: { dir: uploadDir, maxMb: 1, allowedMime: ['image/png', 'image/svg+xml', 'text/plain'] } } }));
    for (const n of ['owner', 'editor', 'viewer', 'outsider']) await createUser(prisma, n);
    owner = client(app); editor = client(app); viewer = client(app); outsider = client(app);
    await owner.login('owner'); await editor.login('editor'); await viewer.login('viewer'); await outsider.login('outsider');
    wsId = (await owner.post('/api/workspaces', { name: 'Infra' })).json().workspace.id;
    const users = Object.fromEntries((await prisma.user.findMany()).map((u) => [u.username, u.id]));
    await owner.put(`/api/workspaces/${wsId}/members/${users.editor}`, { role: 'EDITOR' });
    await owner.put(`/api/workspaces/${wsId}/members/${users.viewer}`, { role: 'VIEWER' });
  });

  const create = async (c, body) => c.post(`/api/workspaces/${wsId}/wiki`, body);

  it('crée une arborescence, lit la page avec son fil d\'Ariane', async () => {
    const root = (await create(editor, { title: 'Exploitation' })).json().page;
    const child = (await create(editor, { title: 'Sauvegardes', parentId: root.id, content: doc(p('pg_dump chaque nuit')) })).json().page;
    const tree = (await viewer.get(`/api/workspaces/${wsId}/wiki`)).json();
    expect(tree.pages.map((x) => x.title)).toEqual(['Exploitation', 'Sauvegardes']);
    const r = (await viewer.get(`/api/wiki/pages/${child.id}`)).json().page;
    expect(r.breadcrumb.map((x) => x.title)).toEqual(['Exploitation']);
    expect(r.myRole).toBe('VIEWER');
    expect((await viewer.get(`/api/wiki/pages/${root.id}`)).json().page.children.map((x) => x.title)).toEqual(['Sauvegardes']);
  });

  it('applique les droits : lecteur en lecture seule, non-membre en 404', async () => {
    const page = (await create(editor, { title: 'Doc' })).json().page;
    expect((await create(viewer, { title: 'x' })).statusCode).toBe(403);
    expect((await viewer.patch(`/api/wiki/pages/${page.id}`, { version: 1, title: 'y' })).statusCode).toBe(403);
    expect((await outsider.get(`/api/wiki/pages/${page.id}`)).statusCode).toBe(404);
    expect((await outsider.get(`/api/workspaces/${wsId}/wiki`)).statusCode).toBe(404);
    expect((await outsider.get(`/api/wiki/pages/${page.id}/export.md`)).statusCode).toBe(404);
  });

  it('refuse d\'écraser une modification concurrente (409) et garde l\'historique', async () => {
    const page = (await create(editor, { title: 'Runbook' })).json().page;
    const a = await editor.patch(`/api/wiki/pages/${page.id}`, { version: 1, content: doc(p('version A')) });
    expect(a.statusCode).toBe(200);
    expect(a.json().page.version).toBe(2);
    const b = await owner.patch(`/api/wiki/pages/${page.id}`, { version: 1, content: doc(p('version B')) });
    expect(b.statusCode).toBe(409);
    expect(b.json().code).toBe('WIKI_CONFLICT');
    expect(b.json().page.version).toBe(2);
    const ok = await owner.patch(`/api/wiki/pages/${page.id}`, { version: 2, content: doc(p('version B')) });
    expect(ok.statusCode).toBe(200);
    const revs = (await viewer.get(`/api/wiki/pages/${page.id}/revisions`)).json().revisions;
    // editor : création + enregistrement regroupés ; owner : une révision
    expect(revs.map((r) => r.author.username)).toEqual(['owner', 'editor']);
    const restore = await editor.post(`/api/wiki/revisions/${revs[1].id}/restore`, { version: 3 });
    expect(restore.statusCode).toBe(200);
    expect(docText(restore.json().page.content)).toBe('version A');
  });

  it('nettoie le contenu à l\'enregistrement', async () => {
    const page = (await create(editor, { title: 'X' })).json().page;
    const r = await editor.patch(`/api/wiki/pages/${page.id}`, { version: 1, content: doc(p('lien', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }])) });
    expect(r.json().page.content.content[0].content[0].marks).toBeUndefined();
    expect((await editor.patch(`/api/wiki/pages/${page.id}`, { version: 2, content: doc({ type: 'iframe' }) })).statusCode).toBe(400);
    expect((await editor.patch(`/api/wiki/pages/${page.id}`, { version: 2, extra: 1 })).statusCode).toBe(400);
  });

  it('déplace une page sans créer de cycle ni sortir de l\'espace', async () => {
    const a = (await create(editor, { title: 'A' })).json().page;
    const b = (await create(editor, { title: 'B', parentId: a.id })).json().page;
    expect((await editor.post(`/api/wiki/pages/${a.id}/move`, { parentId: b.id })).statusCode).toBe(400);
    const ws2 = (await outsider.post('/api/workspaces', { name: 'Autre' })).json().workspace.id;
    const foreign = (await outsider.post(`/api/workspaces/${ws2}/wiki`, { title: 'Étranger' })).json().page;
    expect((await editor.post(`/api/wiki/pages/${b.id}/move`, { parentId: foreign.id })).statusCode).toBe(400);
    expect((await editor.post(`/api/wiki/pages/${b.id}/move`, { parentId: null, beforeId: a.id })).statusCode).toBe(200);
    const tree = (await editor.get(`/api/workspaces/${wsId}/wiki`)).json().pages;
    expect(tree.map((x) => [x.title, x.parentId])).toEqual([['B', null], ['A', null]]);
  });

  it('corbeille : suppression avec sous-pages, restauration, purge réservée au propriétaire', async () => {
    const a = (await create(editor, { title: 'A' })).json().page;
    await create(editor, { title: 'A1', parentId: a.id });
    expect((await editor.del(`/api/wiki/pages/${a.id}`)).json().pages).toBe(2);
    expect((await editor.get(`/api/workspaces/${wsId}/wiki`)).json().pages).toHaveLength(0);
    const trash = (await editor.get(`/api/workspaces/${wsId}/wiki/trash`)).json().pages;
    expect(trash.map((x) => x.title)).toEqual(['A']);
    expect((await viewer.get(`/api/workspaces/${wsId}/wiki/trash`)).statusCode).toBe(403);
    await editor.post(`/api/wiki/pages/${a.id}/restore`);
    expect((await editor.get(`/api/workspaces/${wsId}/wiki`)).json().pages).toHaveLength(2);
    await editor.del(`/api/wiki/pages/${a.id}`);
    expect((await editor.del(`/api/wiki/pages/${a.id}/purge`)).statusCode).toBe(403);
    expect((await owner.del(`/api/wiki/pages/${a.id}/purge`)).statusCode).toBe(200);
    expect(await prisma.wikiPage.count()).toBe(0);
    const audit = (await prisma.auditLog.findMany({ where: { action: { startsWith: 'wiki.' } } })).map((x) => x.action);
    expect(audit).toEqual(expect.arrayContaining(['wiki.page.trash', 'wiki.page.restore', 'wiki.page.purge']));
  });

  it('recherche plein texte en français, limitée aux espaces accessibles', async () => {
    await create(editor, { title: 'Plan de reprise', content: doc(p('Restauration des sauvegardes PostgreSQL sur le site de secours')) });
    await create(editor, { title: 'Annuaire', content: doc(p('Groupes Active Directory')) });
    const ws2 = (await outsider.post('/api/workspaces', { name: 'Secret' })).json().workspace.id;
    await outsider.post(`/api/workspaces/${ws2}/wiki`, { title: 'Sauvegardes confidentielles', content: doc(p('sauvegarde')) });
    const r = (await viewer.get(`/api/wiki/search?q=${encodeURIComponent('sauvegarde')}`)).json().results;
    expect(r.map((x) => x.title)).toEqual(['Plan de reprise']); // racinisation : « sauvegarde » trouve « sauvegardes »
    expect(r[0].snippet).toContain('\u0001');
    const prefix = (await viewer.get('/api/wiki/search?q=annu')).json().results;
    expect(prefix.map((x) => x.title)).toEqual(['Annuaire']);
    expect((await viewer.get(`/api/wiki/search?q=x&workspaceId=${ws2}`)).statusCode).toBe(404);
    expect((await viewer.get(`/api/wiki/search?q=${encodeURIComponent('100%_\\')}`)).statusCode).toBe(200);
  });

  it('images : affichage limité aux images matricielles, SVG en téléchargement', async () => {
    const page = (await create(editor, { title: 'Schéma' })).json().page;
    const up = (name, type, body) => {
      const boundary = '----kz';
      return editor.raw('POST', `/api/wiki/pages/${page.id}/files`,
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n${body}\r\n--${boundary}--\r\n`,
        { 'content-type': `multipart/form-data; boundary=${boundary}` });
    };
    const png = (await up('a.png', 'image/png', 'PNGDATA')).json().file;
    expect(png.url).toBe(`/api/wiki/files/${png.id}`);
    const g = await viewer.get(png.url);
    expect(g.headers['content-disposition']).toMatch(/^inline/);
    expect(g.headers['content-security-policy']).toContain('sandbox');
    const svg = (await up('x.svg', 'image/svg+xml', '<svg onload="alert(1)"/>')).json().file;
    const s = await viewer.get(svg.url);
    expect(s.headers['content-disposition']).toMatch(/^attachment/);
    expect(s.headers['content-type']).toBe('application/octet-stream');
    expect((await outsider.get(png.url)).statusCode).toBe(404);
    // suppression de l'espace : les fichiers quittent aussi le disque
    await owner.del(`/api/workspaces/${wsId}`);
    expect(fs.readdirSync(uploadDir)).toHaveLength(0);
  });

  it('exporte une page en Markdown', async () => {
    const page = (await create(editor, { title: 'Runbook', content: doc(p('Étape **1**')) })).json().page;
    const r = await viewer.get(`/api/wiki/pages/${page.id}/export.md`);
    expect(r.headers['content-type']).toMatch(/text\/markdown/);
    expect(r.headers['content-disposition']).toMatch(/^attachment/);
    expect(r.body).toBe('# Runbook\n\nÉtape \\*\\*1\\*\\*\n');
  });
});
