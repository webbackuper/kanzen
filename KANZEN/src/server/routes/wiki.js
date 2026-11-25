// Wiki : pages arborescentes par espace de travail (à la Outline / Docmost).
// Droits : lecture pour VIEWER, écriture, déplacement et corbeille pour EDITOR, suppression définitive pour OWNER.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { badRequest, conflict } from '../lib/errors.js';
import { docFileIds, docText, docToMarkdown, emptyDoc, sanitizeDoc } from '../lib/wikidoc.js';

const uuid = { type: 'string', format: 'uuid' };
const nullableUuid = { type: ['string', 'null'], format: 'uuid' };
const idParam = { type: 'object', required: ['id'], properties: { id: uuid } };
const title = { type: 'string', minLength: 1, maxLength: 200 };
const icon = { type: ['string', 'null'], maxLength: 16 };
const content = { type: 'object', required: ['type'], properties: { type: { const: 'doc' } } };
/** Images affichables dans la page. Tout autre type est servi en téléchargement. */
const INLINE_IMAGES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
/** Les enregistrements successifs d'un même auteur dans ce délai sont regroupés dans une seule révision. */
const REVISION_MERGE_MS = 10 * 60 * 1000;
const userRef = { select: { id: true, username: true, displayName: true } };

export default async function wikiRoutes(app) {
  const { prisma, authz, audit, realtime, cfg, uploadDir } = app;
  const auth = { onRequest: [app.requireUser] };

  /** Identifiants de la page et de toute sa descendance. */
  async function subtreeIds(pageId) {
    const rows = await prisma.$queryRaw`
      WITH RECURSIVE t AS (
        SELECT id FROM "WikiPage" WHERE id = ${pageId}::uuid
        UNION ALL
        SELECT p.id FROM "WikiPage" p JOIN t ON p."parentId" = t.id
      ) SELECT id FROM t`;
    return rows.map((r) => r.id);
  }

  /** Ancêtres de la page, de la racine vers le parent direct. */
  async function ancestors(page) {
    const chain = [];
    let parentId = page.parentId;
    while (parentId && chain.length < 100) {
      const p = await prisma.wikiPage.findUnique({ where: { id: parentId }, select: { id: true, title: true, icon: true, parentId: true } });
      if (!p) break;
      chain.unshift({ id: p.id, title: p.title, icon: p.icon });
      parentId = p.parentId;
    }
    return chain;
  }

  /** Position en fin de liste des pages sœurs. */
  async function lastPosition(workspaceId, parentId) {
    const last = await prisma.wikiPage.findFirst({ where: { workspaceId, parentId, deletedAt: null }, orderBy: { position: 'desc' }, select: { position: true } });
    return (last?.position ?? 0) + 1000;
  }

  /** Parent valide : même espace, hors corbeille. */
  async function checkParent(workspaceId, parentId) {
    if (!parentId) return null;
    const parent = await prisma.wikiPage.findUnique({ where: { id: parentId }, select: { workspaceId: true, deletedAt: true } });
    if (!parent || parent.workspaceId !== workspaceId || parent.deletedAt) throw badRequest('Page parente invalide');
    return parentId;
  }

  async function saveRevision(page, userId) {
    const last = await prisma.wikiRevision.findFirst({ where: { pageId: page.id }, orderBy: { createdAt: 'desc' } });
    const data = { version: page.version, title: page.title, content: page.content, authorId: userId, createdAt: new Date() };
    if (last && last.authorId === userId && Date.now() - last.createdAt.getTime() < REVISION_MERGE_MS) {
      await prisma.wikiRevision.update({ where: { id: last.id }, data });
    } else {
      await prisma.wikiRevision.create({ data: { ...data, pageId: page.id } });
    }
  }

  /** Fichiers devenus inutiles : ni dans le contenu actuel, ni dans une révision. */
  async function pruneFiles(pageId) {
    const [page, revisions, files] = await Promise.all([
      prisma.wikiPage.findUnique({ where: { id: pageId }, select: { content: true } }),
      prisma.wikiRevision.findMany({ where: { pageId }, select: { content: true } }),
      prisma.wikiFile.findMany({ where: { pageId, uploadedAt: { lt: new Date(Date.now() - 24 * 3600 * 1000) } }, select: { id: true, storageName: true } }),
    ]);
    const used = new Set([page.content, ...revisions.map((r) => r.content)].flatMap((d) => [...docFileIds(d)]));
    const orphans = files.filter((f) => !used.has(f.id));
    if (!orphans.length) return;
    await prisma.wikiFile.deleteMany({ where: { id: { in: orphans.map((f) => f.id) } } });
    await app.removeStoredFiles(orphans.map((f) => f.storageName));
  }

  const publicPage = (p, extra = {}) => ({
    id: p.id, workspaceId: p.workspaceId, parentId: p.parentId, title: p.title, icon: p.icon, content: p.content,
    version: p.version, createdAt: p.createdAt, updatedAt: p.updatedAt, deletedAt: p.deletedAt,
    createdBy: p.createdBy ?? null, updatedBy: p.updatedBy ?? null, ...extra,
  });

  // --- Arborescence d'un espace ---
  app.get('/workspaces/:id/wiki', { ...auth, schema: { params: idParam } }, async (req) => {
    const role = await authz.require(req.user, req.params.id, 'VIEWER');
    const pages = await prisma.wikiPage.findMany({
      where: { workspaceId: req.params.id, deletedAt: null },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, parentId: true, title: true, icon: true, position: true, updatedAt: true },
    });
    const ws = await prisma.workspace.findUnique({ where: { id: req.params.id }, select: { id: true, name: true } });
    return { workspace: ws, myRole: role, pages };
  });

  app.post('/workspaces/:id/wiki', {
    ...auth,
    bodyLimit: 2 * 1024 * 1024,
    schema: { params: idParam, body: { type: 'object', required: ['title'], additionalProperties: false, properties: { title, icon, parentId: nullableUuid, content } } },
  }, async (req, reply) => {
    const workspaceId = req.params.id;
    await authz.require(req.user, workspaceId, 'EDITOR');
    const parentId = await checkParent(workspaceId, req.body.parentId ?? null);
    const doc = req.body.content ? sanitizeDoc(req.body.content) : emptyDoc();
    const page = await prisma.wikiPage.create({
      data: {
        workspaceId, parentId, title: req.body.title, icon: req.body.icon ?? null, content: doc, text: docText(doc),
        position: await lastPosition(workspaceId, parentId), createdById: req.user.id, updatedById: req.user.id,
      },
    });
    await saveRevision(page, req.user.id);
    realtime.wikiChanged(workspaceId, { pageId: page.id, version: page.version, reason: 'create', by: req.user.displayName });
    return reply.code(201).send({ page: publicPage(page) });
  });

  // --- Page ---
  app.get('/wiki/pages/:id', { ...auth, schema: { params: idParam } }, async (req) => {
    const { role } = await authz.check(req.user, 'wikiPage', req.params.id, 'VIEWER');
    const page = await prisma.wikiPage.findUnique({
      where: { id: req.params.id },
      include: {
        createdBy: userRef, updatedBy: userRef,
        children: { where: { deletedAt: null }, orderBy: { position: 'asc' }, select: { id: true, title: true, icon: true, updatedAt: true } },
      },
    });
    return { page: publicPage(page, { children: page.children, breadcrumb: await ancestors(page), myRole: role }) };
  });

  // Enregistrement : « version » est celle sur laquelle l'utilisateur a travaillé. Si quelqu'un a enregistré
  // entre-temps, la requête est refusée (409) au lieu d'écraser silencieusement son travail.
  app.patch('/wiki/pages/:id', {
    ...auth,
    bodyLimit: 2 * 1024 * 1024,
    schema: {
      params: idParam,
      body: { type: 'object', required: ['version'], additionalProperties: false, properties: { version: { type: 'integer', minimum: 1 }, title, icon, content } },
    },
  }, async (req, reply) => {
    const { workspaceId } = await authz.check(req.user, 'wikiPage', req.params.id, 'EDITOR');
    const { version, ...changes } = req.body;
    const data = { updatedById: req.user.id, version: { increment: 1 } };
    if (changes.title !== undefined) data.title = changes.title;
    if (changes.icon !== undefined) data.icon = changes.icon;
    if (changes.content !== undefined) {
      const doc = sanitizeDoc(changes.content);
      data.content = doc;
      data.text = docText(doc);
    }
    const { count } = await prisma.wikiPage.updateMany({ where: { id: req.params.id, version, deletedAt: null }, data });
    if (count === 0) {
      const current = await prisma.wikiPage.findUnique({ where: { id: req.params.id }, include: { updatedBy: userRef } });
      if (current.deletedAt) throw conflict('Cette page est dans la corbeille');
      return reply.code(409).send({
        error: `Page modifiée entre-temps par ${current.updatedBy?.displayName ?? 'un autre utilisateur'}`,
        code: 'WIKI_CONFLICT',
        page: publicPage(current),
      });
    }
    const page = await prisma.wikiPage.findUnique({ where: { id: req.params.id }, include: { createdBy: userRef, updatedBy: userRef } });
    await saveRevision(page, req.user.id);
    realtime.wikiChanged(workspaceId, { pageId: page.id, version: page.version, reason: 'update', by: req.user.displayName });
    return { page: publicPage(page) };
  });

  // Déplacement dans l'arborescence (changement de parent et/ou réordonnancement)
  app.post('/wiki/pages/:id/move', {
    ...auth,
    schema: {
      params: idParam,
      body: { type: 'object', required: ['parentId'], additionalProperties: false, properties: { parentId: nullableUuid, afterId: nullableUuid, beforeId: nullableUuid } },
    },
  }, async (req) => {
    const { workspaceId } = await authz.check(req.user, 'wikiPage', req.params.id, 'EDITOR');
    const page = await prisma.wikiPage.findUnique({ where: { id: req.params.id } });
    if (page.deletedAt) throw conflict('Cette page est dans la corbeille');
    const parentId = await checkParent(workspaceId, req.body.parentId);
    if (parentId && (await subtreeIds(page.id)).includes(parentId)) throw badRequest('Une page ne peut pas être déplacée sous elle-même');
    const pos = async (id) => (id ? (await prisma.wikiPage.findFirst({ where: { id, workspaceId, parentId, deletedAt: null }, select: { position: true } }))?.position : undefined);
    const above = await pos(req.body.afterId);
    const below = await pos(req.body.beforeId);
    let position;
    if (above !== undefined && below !== undefined) position = (above + below) / 2;
    else if (above !== undefined) position = above + 1000;
    else if (below !== undefined) position = below - 1000;
    else position = await lastPosition(workspaceId, parentId);
    await prisma.wikiPage.update({ where: { id: page.id }, data: { parentId, position } });
    realtime.wikiChanged(workspaceId, { pageId: page.id, reason: 'move', by: req.user.displayName });
    return { ok: true };
  });

  // --- Corbeille ---
  app.delete('/wiki/pages/:id', { ...auth, schema: { params: idParam } }, async (req) => {
    const { workspaceId } = await authz.check(req.user, 'wikiPage', req.params.id, 'EDITOR');
    const page = await prisma.wikiPage.findUnique({ where: { id: req.params.id }, select: { title: true, deletedAt: true } });
    if (page.deletedAt) throw conflict('Cette page est déjà dans la corbeille');
    const ids = await subtreeIds(req.params.id);
    await prisma.wikiPage.updateMany({ where: { id: { in: ids }, deletedAt: null }, data: { deletedAt: new Date() } });
    await audit(req, 'wiki.page.trash', { target: req.params.id, details: { title: page.title, pages: ids.length } });
    realtime.wikiChanged(workspaceId, { pageId: req.params.id, reason: 'trash', by: req.user.displayName });
    return { ok: true, pages: ids.length };
  });

  app.get('/workspaces/:id/wiki/trash', { ...auth, schema: { params: idParam } }, async (req) => {
    const role = await authz.require(req.user, req.params.id, 'EDITOR');
    const deleted = await prisma.wikiPage.findMany({
      where: { workspaceId: req.params.id, deletedAt: { not: null } },
      orderBy: { deletedAt: 'desc' },
      select: { id: true, title: true, icon: true, deletedAt: true, parent: { select: { deletedAt: true } }, updatedBy: userRef },
    });
    // Seules les racines de chaque suppression sont listées : leurs sous-pages suivent lors de la restauration
    const roots = deleted.filter((p) => p.parent?.deletedAt?.getTime() !== p.deletedAt.getTime());
    return { myRole: role, pages: roots.map(({ parent: _parent, ...p }) => p) };
  });

  app.post('/wiki/pages/:id/restore', { ...auth, schema: { params: idParam } }, async (req) => {
    const { workspaceId } = await authz.check(req.user, 'wikiPage', req.params.id, 'EDITOR');
    const page = await prisma.wikiPage.findUnique({ where: { id: req.params.id }, include: { parent: { select: { deletedAt: true } } } });
    if (!page.deletedAt) throw conflict('Cette page n\'est pas dans la corbeille');
    // Les sous-pages supprimées en même temps reviennent avec elle ; si le parent est lui-même à la corbeille, elle revient à la racine
    const ids = await subtreeIds(page.id);
    await prisma.wikiPage.updateMany({ where: { id: { in: ids }, deletedAt: page.deletedAt }, data: { deletedAt: null } });
    if (page.parent?.deletedAt) {
      await prisma.wikiPage.update({ where: { id: page.id }, data: { parentId: null, position: await lastPosition(workspaceId, null) } });
    }
    await audit(req, 'wiki.page.restore', { target: page.id, details: { title: page.title } });
    realtime.wikiChanged(workspaceId, { pageId: page.id, reason: 'restore', by: req.user.displayName });
    return { ok: true };
  });

  app.delete('/wiki/pages/:id/purge', { ...auth, schema: { params: idParam } }, async (req) => {
    const { workspaceId } = await authz.check(req.user, 'wikiPage', req.params.id, 'OWNER');
    const page = await prisma.wikiPage.findUnique({ where: { id: req.params.id }, select: { title: true, deletedAt: true } });
    if (!page.deletedAt) throw conflict('Placer d\'abord la page dans la corbeille');
    const ids = await subtreeIds(req.params.id);
    const files = await prisma.wikiFile.findMany({ where: { pageId: { in: ids } }, select: { storageName: true } });
    await prisma.wikiPage.delete({ where: { id: req.params.id } }); // cascade : sous-pages, révisions, fichiers
    await app.removeStoredFiles(files.map((f) => f.storageName));
    await audit(req, 'wiki.page.purge', { target: req.params.id, details: { title: page.title, pages: ids.length } });
    realtime.wikiChanged(workspaceId, { pageId: req.params.id, reason: 'purge', by: req.user.displayName });
    return { ok: true };
  });

  // --- Historique ---
  app.get('/wiki/pages/:id/revisions', { ...auth, schema: { params: idParam } }, async (req) => {
    await authz.check(req.user, 'wikiPage', req.params.id, 'VIEWER');
    const revisions = await prisma.wikiRevision.findMany({
      where: { pageId: req.params.id }, orderBy: { createdAt: 'desc' }, take: 200,
      select: { id: true, version: true, title: true, createdAt: true, author: userRef },
    });
    return { revisions };
  });

  app.get('/wiki/revisions/:id', { ...auth, schema: { params: idParam } }, async (req) => {
    await authz.check(req.user, 'wikiRevision', req.params.id, 'VIEWER');
    const revision = await prisma.wikiRevision.findUnique({ where: { id: req.params.id }, include: { author: userRef } });
    return { revision };
  });

  app.post('/wiki/revisions/:id/restore', {
    ...auth,
    schema: { params: idParam, body: { type: 'object', required: ['version'], additionalProperties: false, properties: { version: { type: 'integer', minimum: 1 } } } },
  }, async (req, reply) => {
    const { workspaceId } = await authz.check(req.user, 'wikiRevision', req.params.id, 'EDITOR');
    const rev = await prisma.wikiRevision.findUnique({ where: { id: req.params.id } });
    const { count } = await prisma.wikiPage.updateMany({
      where: { id: rev.pageId, version: req.body.version, deletedAt: null },
      data: { title: rev.title, content: rev.content, text: docText(rev.content), updatedById: req.user.id, version: { increment: 1 } },
    });
    if (count === 0) return reply.code(409).send({ error: 'La page a été modifiée entre-temps : rechargez-la avant de restaurer', code: 'WIKI_CONFLICT' });
    const page = await prisma.wikiPage.findUnique({ where: { id: rev.pageId }, include: { createdBy: userRef, updatedBy: userRef } });
    await saveRevision(page, req.user.id);
    await audit(req, 'wiki.revision.restore', { target: page.id, details: { fromVersion: rev.version, toVersion: page.version } });
    realtime.wikiChanged(workspaceId, { pageId: page.id, version: page.version, reason: 'update', by: req.user.displayName });
    return { page: publicPage(page) };
  });

  // --- Export Markdown ---
  app.get('/wiki/pages/:id/export.md', { ...auth, schema: { params: idParam } }, async (req, reply) => {
    await authz.check(req.user, 'wikiPage', req.params.id, 'VIEWER');
    const page = await prisma.wikiPage.findUnique({ where: { id: req.params.id } });
    const name = `${page.title.replace(/[^\p{L}\p{N} _-]+/gu, '_').slice(0, 80) || 'page'}.md`;
    return reply
      .header('content-type', 'text/markdown; charset=utf-8')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store')
      .send(docToMarkdown(page.title, page.content));
  });

  // --- Recherche plein texte (français) dans les espaces accessibles ---
  app.get('/wiki/search', {
    ...auth,
    schema: { querystring: { type: 'object', required: ['q'], additionalProperties: false, properties: { q: { type: 'string', minLength: 1, maxLength: 200 }, workspaceId: uuid } } },
  }, async (req) => {
    let workspaceIds;
    if (req.query.workspaceId) {
      await authz.require(req.user, req.query.workspaceId, 'VIEWER');
      workspaceIds = [req.query.workspaceId];
    } else if (req.user.role === 'ADMIN') {
      workspaceIds = (await prisma.workspace.findMany({ select: { id: true } })).map((w) => w.id);
    } else {
      workspaceIds = (await prisma.workspaceMember.findMany({ where: { userId: req.user.id }, select: { workspaceId: true } })).map((m) => m.workspaceId);
    }
    if (!workspaceIds.length) return { results: [] };
    const q = req.query.q.trim();
    // Saisie en cours : préfixes sur les mots (« migr » trouve « migration »), en plus de la syntaxe web (guillemets, -exclusion)
    const words = (q.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 8).map((w) => `${w.slice(0, 64)}:*`).join(' & ');
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    const rows = await prisma.$queryRaw`
      SELECT p.id, p.title, p.icon, p."workspaceId", w.name AS "workspaceName", p."updatedAt",
             ts_headline('french', p.text, query, ${'StartSel=\u0001, StopSel=\u0002, MaxWords=30, MinWords=12, MaxFragments=2, FragmentDelimiter=" … "'}) AS snippet
      FROM "WikiPage" p
      JOIN "Workspace" w ON w.id = p."workspaceId",
           LATERAL (SELECT websearch_to_tsquery('french', ${q}) || to_tsquery('french', ${words || ''}) AS query) qq
      WHERE p."deletedAt" IS NULL
        AND p."workspaceId" = ANY(${workspaceIds}::uuid[])
        AND (p.search @@ query OR p.title ILIKE ${like})
      ORDER BY (p.title ILIKE ${like}) DESC, ts_rank(p.search, query) DESC, p."updatedAt" DESC
      LIMIT 30`;
    return { results: rows };
  });

  // --- Fichiers (images insérées dans les pages) ---
  app.post('/wiki/pages/:id/files', { ...auth, schema: { params: idParam } }, async (req, reply) => {
    await authz.check(req.user, 'wikiPage', req.params.id, 'EDITOR');
    const file = await req.file();
    if (!file) throw badRequest('Fichier manquant');
    if (!cfg.upload.allowedMime.includes(file.mimetype)) {
      file.file.resume();
      throw badRequest(`Type de fichier non autorisé : ${file.mimetype}`);
    }
    const storageName = crypto.randomUUID();
    const tmp = path.join(uploadDir, `.${storageName}.part`);
    const hash = crypto.createHash('sha256');
    let size = 0;
    const meter = new Transform({ transform(chunk, _enc, cb) { size += chunk.length; hash.update(chunk); cb(null, chunk); } });
    try {
      await pipeline(file.file, meter, fs.createWriteStream(tmp, { mode: 0o640 }));
      if (file.file.truncated) throw badRequest(`Fichier trop volumineux (max ${cfg.upload.maxMb} Mo)`);
      fs.renameSync(tmp, path.join(uploadDir, storageName));
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    // eslint-disable-next-line no-control-regex -- suppression volontaire des caractères de contrôle
    const filename = path.basename(file.filename).replace(/[\u0000-\u001f"\\/]/g, '_').slice(0, 200) || 'fichier';
    const f = await prisma.wikiFile.create({
      data: { filename, storageName, mimetype: file.mimetype, size, sha256: hash.digest('hex'), pageId: req.params.id, uploadedById: req.user.id },
    });
    await pruneFiles(req.params.id);
    return reply.code(201).send({ file: { id: f.id, filename: f.filename, mimetype: f.mimetype, size: f.size, url: `/api/wiki/files/${f.id}`, inline: INLINE_IMAGES.includes(f.mimetype) } });
  });

  // Images matricielles affichées dans la page ; tout le reste (SVG compris) est forcé en téléchargement.
  app.get('/wiki/files/:id', { ...auth, schema: { params: idParam } }, async (req, reply) => {
    await authz.check(req.user, 'wikiFile', req.params.id, 'VIEWER');
    const f = await prisma.wikiFile.findUnique({ where: { id: req.params.id } });
    const filePath = path.join(uploadDir, f.storageName);
    if (!fs.existsSync(filePath)) return reply.code(410).send({ error: 'Fichier absent du stockage' });
    const inline = INLINE_IMAGES.includes(f.mimetype);
    return reply
      .header('content-type', inline ? f.mimetype : 'application/octet-stream')
      .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.filename)}`)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cache-control', 'private, max-age=300')
      .send(fs.createReadStream(filePath));
  });
}
