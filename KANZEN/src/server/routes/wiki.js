// Wiki : pages arborescentes par espace de travail (à la Outline / Docmost).
// Droits : lecture pour VIEWER, écriture, déplacement et corbeille pour EDITOR, suppression définitive pour OWNER.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { zipSync } from 'fflate';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { docFileIds, docText, docToMarkdown, emptyDoc, remapFiles, sanitizeDoc } from '../lib/wikidoc.js';
import { createWikiAccess } from '../lib/wikiAccess.js';
import { attachWikiCollab } from '../wikiCollab.js';

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
  const access = createWikiAccess(prisma, authz);
  let collab = null; // co-édition (branchée en fin de fichier)
  const checkPage = (user, id, minRole) => access.checkPage(user, id, minRole);
  /** Révision ou fichier : contrôle par la page à laquelle ils appartiennent. */
  async function checkVia(kind, user, id, minRole) {
    await authz.check(user, kind, id, minRole); // 404 si l'objet n'existe pas ou hors espace
    const row = kind === 'wikiRevision'
      ? await prisma.wikiRevision.findUnique({ where: { id }, select: { pageId: true } })
      : await prisma.wikiFile.findUnique({ where: { id }, select: { pageId: true } });
    return { ...(await checkPage(user, row.pageId, minRole)), pageId: row.pageId };
  }

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

  /** Pages restreintes parmi `pageId` et ses ancêtres (null = racine). */
  async function restrictedChain(pageId) {
    const ids = [];
    let id = pageId;
    for (let i = 0; id && i < 100; i++) {
      const p = await prisma.wikiPage.findUnique({ where: { id }, select: { parentId: true, restricted: true } });
      if (!p) break;
      if (p.restricted) ids.push(id);
      id = p.parentId;
    }
    return ids;
  }

  /**
   * Une page qui perd une restriction héritée (restauration à la racine) la garde sous forme de restriction propre :
   * seuls les utilisateurs autorisés sur TOUTES les anciennes restrictions la voient encore.
   */
  async function keepRestriction(pageId, chain) {
    if (!chain.length) return;
    const lists = await Promise.all(chain.map(async (id) => new Set((await prisma.wikiPageMember.findMany({ where: { pageId: id }, select: { userId: true } })).map((m) => m.userId))));
    const users = [...lists[0]].filter((u) => lists.every((l) => l.has(u)));
    await prisma.$transaction([
      prisma.wikiPage.update({ where: { id: pageId }, data: { restricted: true } }),
      prisma.wikiPageMember.deleteMany({ where: { pageId } }),
      prisma.wikiPageMember.createMany({ data: users.map((userId) => ({ pageId, userId })) }),
    ]);
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
    const { canSee } = await access.forWorkspace(req.user, req.params.id);
    const all = await prisma.wikiPage.findMany({
      where: { workspaceId: req.params.id, deletedAt: null },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, parentId: true, title: true, icon: true, position: true, updatedAt: true, restricted: true },
    });
    const pages = all.filter((p) => canSee(p.id));
    const visible = new Set(pages.map((p) => p.id));
    const ws = await prisma.workspace.findUnique({ where: { id: req.params.id }, select: { id: true, name: true, wikiHomePageId: true } });
    const [favorites, views] = await Promise.all([
      prisma.wikiFavorite.findMany({ where: { userId: req.user.id, page: { workspaceId: req.params.id } }, orderBy: { createdAt: 'asc' }, select: { pageId: true } }),
      prisma.wikiView.findMany({ where: { userId: req.user.id, page: { workspaceId: req.params.id, deletedAt: null } }, orderBy: { viewedAt: 'desc' }, take: 30, select: { pageId: true, viewedAt: true } }),
    ]);
    return {
      workspace: { id: ws.id, name: ws.name },
      myRole: role,
      pages,
      homePageId: ws.wikiHomePageId && visible.has(ws.wikiHomePageId) ? ws.wikiHomePageId : null,
      favorites: favorites.map((f) => f.pageId).filter((id) => visible.has(id)),
      recent: views.filter((v) => visible.has(v.pageId)).slice(0, 10),
    };
  });

  app.post('/workspaces/:id/wiki', {
    ...auth,
    bodyLimit: 2 * 1024 * 1024,
    schema: { params: idParam, body: { type: 'object', required: ['title'], additionalProperties: false, properties: { title, icon, parentId: nullableUuid, content } } },
  }, async (req, reply) => {
    const workspaceId = req.params.id;
    await authz.require(req.user, workspaceId, 'EDITOR');
    const parentId = await checkParent(workspaceId, req.body.parentId ?? null);
    if (parentId) await checkPage(req.user, parentId, 'EDITOR');
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
    const { role, workspaceId } = await checkPage(req.user, req.params.id, 'VIEWER');
    const page = await prisma.wikiPage.findUnique({
      where: { id: req.params.id },
      include: {
        createdBy: userRef, updatedBy: userRef,
        children: { where: { deletedAt: null }, orderBy: { position: 'asc' }, select: { id: true, title: true, icon: true, updatedAt: true } },
      },
    });
    const { canSee, restrictedIds } = await access.forWorkspace(req.user, workspaceId);
    const breadcrumb = await ancestors(page);
    const favorite = await prisma.wikiFavorite.findUnique({ where: { userId_pageId: { userId: req.user.id, pageId: page.id } } });
    await prisma.wikiView.upsert({
      where: { userId_pageId: { userId: req.user.id, pageId: page.id } },
      create: { userId: req.user.id, pageId: page.id }, update: { viewedAt: new Date() },
    });
    return {
      page: publicPage(page, {
        children: page.children.filter((c) => canSee(c.id)),
        breadcrumb,
        myRole: role,
        favorite: Boolean(favorite),
        restricted: page.restricted,
        verification: await verificationOf(page),
        /** La page est soumise à une restriction (la sienne ou celle d'un ancêtre) */
        restrictedBy: [...breadcrumb.filter((b) => restrictedIds.has(b.id)), ...(page.restricted ? [{ id: page.id, title: page.title }] : [])].map((b) => ({ id: b.id, title: b.title })),
      }),
    };
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
    const { workspaceId } = await checkPage(req.user, req.params.id, 'EDITOR');
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
    collab?.saved(page.id);
    realtime.wikiChanged(workspaceId, { pageId: page.id, version: page.version, reason: 'update', by: req.user.displayName });
    return { page: publicPage(page) };
  });

  /** Enregistrement automatique quand le dernier co-éditeur part sans enregistrer (voir wikiCollab.js). */
  async function autosave(pageId, { content, title, icon }, user) {
    if (!user) return;
    const current = await prisma.wikiPage.findUnique({ where: { id: pageId } });
    if (!current || current.deletedAt) return;
    try { await checkPage(user, pageId, 'EDITOR'); } catch { return; } // droits retirés entre-temps
    const doc = sanitizeDoc(content);
    const text = docText(doc);
    // Document partagé vide alors que la page a du contenu : état incohérent (client non TipTap, initialisation
    // interrompue), on n'écrase rien. Un vidage volontaire passe par un enregistrement explicite.
    if (!text.trim() && current.text.trim()) { app.log.warn({ pageId }, 'enregistrement automatique ignoré : document partagé vide'); return; }
    const data = { content: doc, text, updatedById: user.id, version: { increment: 1 } };
    if (typeof title === 'string' && title.trim()) data.title = title.trim().slice(0, 200);
    if (typeof icon === 'string') data.icon = icon.slice(0, 16) || null;
    const same = JSON.stringify(doc) === JSON.stringify(sanitizeDoc(current.content))
      && (data.title ?? current.title) === current.title && (data.icon === undefined || data.icon === current.icon);
    if (same) return; // rien n'a réellement changé (simple ouverture en édition)
    const { count } = await prisma.wikiPage.updateMany({ where: { id: pageId, version: current.version, deletedAt: null }, data });
    if (!count) return; // enregistrée entre-temps : la version enregistrée prévaut
    const page = await prisma.wikiPage.findUnique({ where: { id: pageId } });
    await saveRevision(page, user.id);
    await app.audit(null, 'wiki.autosave', { actor: user, target: pageId, details: { version: page.version } });
    realtime.wikiChanged(page.workspaceId, { pageId, version: page.version, reason: 'update', by: `${user.displayName} (enregistrement automatique)` });
  }

  // Déplacement dans l'arborescence (changement de parent et/ou réordonnancement)
  app.post('/wiki/pages/:id/move', {
    ...auth,
    schema: {
      params: idParam,
      body: { type: 'object', required: ['parentId'], additionalProperties: false, properties: { parentId: nullableUuid, afterId: nullableUuid, beforeId: nullableUuid } },
    },
  }, async (req) => {
    const { workspaceId } = await checkPage(req.user, req.params.id, 'EDITOR');
    const page = await prisma.wikiPage.findUnique({ where: { id: req.params.id } });
    if (page.deletedAt) throw conflict('Cette page est dans la corbeille');
    const parentId = await checkParent(workspaceId, req.body.parentId);
    if (parentId) await checkPage(req.user, parentId, 'EDITOR');
    if (parentId && (await subtreeIds(page.id)).includes(parentId)) throw badRequest('Une page ne peut pas être déplacée sous elle-même');
    // Sortir une page d'une zone restreinte l'exposerait : réservé aux propriétaires de l'espace
    if (parentId !== page.parentId) {
      const before = await restrictedChain(page.parentId);
      const after = new Set(await restrictedChain(parentId));
      if (before.some((id) => !after.has(id)) && (await authz.workspaceRole(req.user, workspaceId)) !== 'OWNER') {
        throw forbidden('Cette page est dans une zone à accès restreint : seul un propriétaire de l\'espace peut l\'en sortir');
      }
    }
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
    const { workspaceId } = await checkPage(req.user, req.params.id, 'EDITOR');
    const page = await prisma.wikiPage.findUnique({ where: { id: req.params.id }, select: { title: true, deletedAt: true } });
    if (page.deletedAt) throw conflict('Cette page est déjà dans la corbeille');
    const ids = await subtreeIds(req.params.id);
    await prisma.wikiPage.updateMany({ where: { id: { in: ids }, deletedAt: null }, data: { deletedAt: new Date() } });
    for (const id of ids) collab?.reset(id);
    await audit(req, 'wiki.page.trash', { target: req.params.id, details: { title: page.title, pages: ids.length } });
    realtime.wikiChanged(workspaceId, { pageId: req.params.id, reason: 'trash', by: req.user.displayName });
    return { ok: true, pages: ids.length };
  });

  app.get('/workspaces/:id/wiki/trash', { ...auth, schema: { params: idParam } }, async (req) => {
    const role = await authz.require(req.user, req.params.id, 'EDITOR');
    const { canSee } = await access.forWorkspace(req.user, req.params.id);
    const deleted = await prisma.wikiPage.findMany({
      where: { workspaceId: req.params.id, deletedAt: { not: null } },
      orderBy: { deletedAt: 'desc' },
      select: { id: true, title: true, icon: true, deletedAt: true, parent: { select: { deletedAt: true } }, updatedBy: userRef },
    });
    // Seules les racines de chaque suppression sont listées : leurs sous-pages suivent lors de la restauration
    const roots = deleted.filter((p) => p.parent?.deletedAt?.getTime() !== p.deletedAt.getTime());
    return { myRole: role, pages: roots.filter((p) => canSee(p.id)).map(({ parent: _parent, ...p }) => p) };
  });

  app.post('/wiki/pages/:id/restore', { ...auth, schema: { params: idParam } }, async (req) => {
    const { workspaceId } = await checkPage(req.user, req.params.id, 'EDITOR');
    const page = await prisma.wikiPage.findUnique({ where: { id: req.params.id }, include: { parent: { select: { deletedAt: true } } } });
    if (!page.deletedAt) throw conflict('Cette page n\'est pas dans la corbeille');
    // Les sous-pages supprimées en même temps reviennent avec elle ; si le parent est lui-même à la corbeille, elle revient à la racine
    const ids = await subtreeIds(page.id);
    await prisma.wikiPage.updateMany({ where: { id: { in: ids }, deletedAt: page.deletedAt }, data: { deletedAt: null } });
    if (page.parent?.deletedAt) {
      const chain = await restrictedChain(page.parentId);
      await prisma.wikiPage.update({ where: { id: page.id }, data: { parentId: null, position: await lastPosition(workspaceId, null) } });
      if (!page.restricted) await keepRestriction(page.id, chain);
      else if (chain.length) await keepRestriction(page.id, [page.id, ...chain]);
    }
    await audit(req, 'wiki.page.restore', { target: page.id, details: { title: page.title } });
    realtime.wikiChanged(workspaceId, { pageId: page.id, reason: 'restore', by: req.user.displayName });
    return { ok: true };
  });

  app.delete('/wiki/pages/:id/purge', { ...auth, schema: { params: idParam } }, async (req) => {
    const { workspaceId } = await checkPage(req.user, req.params.id, 'OWNER');
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
    await checkPage(req.user, req.params.id, 'VIEWER');
    const revisions = await prisma.wikiRevision.findMany({
      where: { pageId: req.params.id }, orderBy: { createdAt: 'desc' }, take: 200,
      select: { id: true, version: true, title: true, createdAt: true, author: userRef },
    });
    return { revisions };
  });

  app.get('/wiki/revisions/:id', { ...auth, schema: { params: idParam } }, async (req) => {
    await checkVia('wikiRevision', req.user, req.params.id, 'VIEWER');
    const revision = await prisma.wikiRevision.findUnique({ where: { id: req.params.id }, include: { author: userRef } });
    return { revision };
  });

  app.post('/wiki/revisions/:id/restore', {
    ...auth,
    schema: { params: idParam, body: { type: 'object', required: ['version'], additionalProperties: false, properties: { version: { type: 'integer', minimum: 1 } } } },
  }, async (req, reply) => {
    const { workspaceId } = await checkVia('wikiRevision', req.user, req.params.id, 'EDITOR');
    const rev = await prisma.wikiRevision.findUnique({ where: { id: req.params.id } });
    const { count } = await prisma.wikiPage.updateMany({
      where: { id: rev.pageId, version: req.body.version, deletedAt: null },
      data: { title: rev.title, content: rev.content, text: docText(rev.content), updatedById: req.user.id, version: { increment: 1 } },
    });
    if (count === 0) return reply.code(409).send({ error: 'La page a été modifiée entre-temps : rechargez-la avant de restaurer', code: 'WIKI_CONFLICT' });
    const page = await prisma.wikiPage.findUnique({ where: { id: rev.pageId }, include: { createdBy: userRef, updatedBy: userRef } });
    await saveRevision(page, req.user.id);
    collab?.reset(page.id);
    await audit(req, 'wiki.revision.restore', { target: page.id, details: { fromVersion: rev.version, toVersion: page.version } });
    realtime.wikiChanged(workspaceId, { pageId: page.id, version: page.version, reason: 'update', by: req.user.displayName });
    return { page: publicPage(page) };
  });

  // --- Export Markdown ---
  app.get('/wiki/pages/:id/export.md', { ...auth, schema: { params: idParam } }, async (req, reply) => {
    await checkPage(req.user, req.params.id, 'VIEWER');
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
      LIMIT 60`;
    // Pages à accès restreint : filtrées par espace
    const visibility = new Map();
    for (const wsId of new Set(rows.map((r) => r.workspaceId))) visibility.set(wsId, (await access.forWorkspace(req.user, wsId)).canSee);
    return { results: rows.filter((r) => visibility.get(r.workspaceId)(r.id)).slice(0, 30) };
  });

  // --- Fichiers (images insérées dans les pages) ---
  app.post('/wiki/pages/:id/files', { ...auth, schema: { params: idParam } }, async (req, reply) => {
    await checkPage(req.user, req.params.id, 'EDITOR');
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
    await checkVia('wikiFile', req.user, req.params.id, 'VIEWER');
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

  // --- Accès restreint (propriétaires de l'espace) ---
  app.get('/wiki/pages/:id/access', { ...auth, schema: { params: idParam } }, async (req) => {
    const { workspaceId } = await checkPage(req.user, req.params.id, 'VIEWER');
    const page = await prisma.wikiPage.findUnique({ where: { id: req.params.id }, select: { restricted: true, parentId: true } });
    const members = await prisma.wikiPageMember.findMany({ where: { pageId: req.params.id }, select: { user: userRef } });
    const inherited = [];
    for (const id of await restrictedChain(page.parentId)) {
      const p = await prisma.wikiPage.findUnique({ where: { id }, select: { id: true, title: true } });
      inherited.unshift(p);
    }
    const role = await authz.workspaceRole(req.user, workspaceId);
    return { restricted: page.restricted, members: members.map((m) => m.user), inherited, canManage: role === 'OWNER' };
  });

  app.put('/wiki/pages/:id/access', {
    ...auth,
    schema: {
      params: idParam,
      body: { type: 'object', required: ['restricted', 'userIds'], additionalProperties: false, properties: { restricted: { type: 'boolean' }, userIds: { type: 'array', uniqueItems: true, maxItems: 500, items: uuid } } },
    },
  }, async (req) => {
    const { workspaceId } = await checkPage(req.user, req.params.id, 'OWNER');
    const userIds = req.body.restricted ? req.body.userIds : [];
    if (userIds.length) {
      const members = await prisma.workspaceMember.count({ where: { workspaceId, userId: { in: userIds } } });
      if (members !== userIds.length) throw badRequest('Seuls des membres de l\'espace peuvent être autorisés');
    }
    await prisma.$transaction([
      prisma.wikiPage.update({ where: { id: req.params.id }, data: { restricted: req.body.restricted } }),
      prisma.wikiPageMember.deleteMany({ where: { pageId: req.params.id } }),
      prisma.wikiPageMember.createMany({ data: userIds.map((userId) => ({ pageId: req.params.id, userId })) }),
    ]);
    await audit(req, 'wiki.page.access', { target: req.params.id, details: { restricted: req.body.restricted, users: userIds.length } });
    realtime.wikiChanged(workspaceId, { pageId: req.params.id, reason: 'access', by: req.user.displayName });
    return { ok: true };
  });

  // --- Favoris ---
  app.put('/wiki/pages/:id/favorite', { ...auth, schema: { params: idParam } }, async (req) => {
    await checkPage(req.user, req.params.id, 'VIEWER');
    await prisma.wikiFavorite.upsert({
      where: { userId_pageId: { userId: req.user.id, pageId: req.params.id } }, create: { userId: req.user.id, pageId: req.params.id }, update: {},
    });
    return { ok: true };
  });
  app.delete('/wiki/pages/:id/favorite', { ...auth, schema: { params: idParam } }, async (req) => {
    await checkPage(req.user, req.params.id, 'VIEWER');
    await prisma.wikiFavorite.deleteMany({ where: { userId: req.user.id, pageId: req.params.id } });
    return { ok: true };
  });

  // --- Page d'accueil du wiki de l'espace ---
  app.put('/workspaces/:id/wiki/home', {
    ...auth,
    schema: { params: idParam, body: { type: 'object', required: ['pageId'], additionalProperties: false, properties: { pageId: nullableUuid } } },
  }, async (req) => {
    await authz.require(req.user, req.params.id, 'OWNER');
    if (req.body.pageId) {
      const page = await prisma.wikiPage.findUnique({ where: { id: req.body.pageId }, select: { workspaceId: true, deletedAt: true } });
      if (!page || page.workspaceId !== req.params.id || page.deletedAt) throw badRequest('Page invalide');
    }
    await prisma.workspace.update({ where: { id: req.params.id }, data: { wikiHomePageId: req.body.pageId } });
    realtime.wikiChanged(req.params.id, { pageId: req.body.pageId, reason: 'home', by: req.user.displayName });
    return { ok: true };
  });

  // --- Rétroliens : pages qui pointent vers celle-ci ---
  app.get('/wiki/pages/:id/backlinks', { ...auth, schema: { params: idParam } }, async (req) => {
    const { workspaceId } = await checkPage(req.user, req.params.id, 'VIEWER');
    const needle = `%"/wiki/${req.params.id}%`;
    const rows = await prisma.$queryRaw`
      SELECT id, title, icon, "updatedAt" FROM "WikiPage"
      WHERE "workspaceId" = ${workspaceId}::uuid AND "deletedAt" IS NULL AND id <> ${req.params.id}::uuid AND content::text LIKE ${needle}
      ORDER BY title LIMIT 100`;
    const { canSee } = await access.forWorkspace(req.user, workspaceId);
    return { pages: rows.filter((r) => canSee(r.id)) };
  });

  // --- Liens avec les tâches du Kanban ---
  const taskSel = {
    id: true, title: true, color: true, dueDate: true,
    column: { select: { title: true, board: { select: { id: true, title: true, workspaceId: true } } } },
    assignees: { orderBy: { assignedAt: 'asc' }, select: { user: userRef } },
  };
  const publicTask = (t) => ({
    id: t.id, title: t.title, color: t.color, dueDate: t.dueDate, column: t.column.title,
    board: { id: t.column.board.id, title: t.column.board.title }, assignees: t.assignees.map((a) => a.user),
  });
  const taskWorkspace = async (taskId) => (await prisma.task.findUnique({ where: { id: taskId }, select: { column: { select: { board: { select: { workspaceId: true } } } } } }))?.column.board.workspaceId;

  app.get('/wiki/pages/:id/tasks', { ...auth, schema: { params: idParam } }, async (req) => {
    await checkPage(req.user, req.params.id, 'VIEWER');
    const links = await prisma.wikiTaskLink.findMany({ where: { pageId: req.params.id }, orderBy: { createdAt: 'asc' }, select: { task: { select: taskSel } } });
    return { tasks: links.map((l) => publicTask(l.task)) };
  });

  async function linkPageTask(req, pageId, taskId) {
    const { workspaceId } = await checkPage(req.user, pageId, 'EDITOR');
    const page = await prisma.wikiPage.findUnique({ where: { id: pageId }, select: { deletedAt: true } });
    if (page.deletedAt) throw conflict('Cette page est dans la corbeille');
    await authz.check(req.user, 'task', taskId, 'VIEWER');
    if ((await taskWorkspace(taskId)) !== workspaceId) throw badRequest('La tâche doit appartenir au même espace');
    await prisma.wikiTaskLink.upsert({ where: { pageId_taskId: { pageId, taskId } }, create: { pageId, taskId, createdById: req.user.id }, update: {} });
    return workspaceId;
  }
  async function unlinkPageTask(req, pageId, taskId) {
    const { workspaceId } = await checkPage(req.user, pageId, 'EDITOR');
    await prisma.wikiTaskLink.deleteMany({ where: { pageId, taskId } });
    return workspaceId;
  }
  const notifyLink = async (workspaceId, pageId, taskId, by) => {
    realtime.wikiChanged(workspaceId, { pageId, reason: 'links', by });
    const t = await prisma.task.findUnique({ where: { id: taskId }, select: { column: { select: { boardId: true } } } });
    if (t) realtime.boardChanged(t.column.boardId, 'task');
  };

  const linkBody = (key) => ({ type: 'object', required: [key], additionalProperties: false, properties: { [key]: uuid } });
  app.post('/wiki/pages/:id/tasks', { ...auth, schema: { params: idParam, body: linkBody('taskId') } }, async (req, reply) => {
    const ws = await linkPageTask(req, req.params.id, req.body.taskId);
    await notifyLink(ws, req.params.id, req.body.taskId, req.user.displayName);
    return reply.code(201).send({ ok: true });
  });
  app.delete('/wiki/pages/:id/tasks/:taskId', { ...auth, schema: { params: { type: 'object', required: ['id', 'taskId'], properties: { id: uuid, taskId: uuid } } } }, async (req) => {
    const ws = await unlinkPageTask(req, req.params.id, req.params.taskId);
    await notifyLink(ws, req.params.id, req.params.taskId, req.user.displayName);
    return { ok: true };
  });

  // Côté tâche : pages du wiki liées (visibles par l'utilisateur)
  app.get('/tasks/:id/wiki-pages', { ...auth, schema: { params: idParam } }, async (req) => {
    const { workspaceId, role } = await authz.check(req.user, 'task', req.params.id, 'VIEWER');
    const links = await prisma.wikiTaskLink.findMany({
      where: { taskId: req.params.id, page: { deletedAt: null } }, orderBy: { createdAt: 'asc' },
      select: { page: { select: { id: true, title: true, icon: true, updatedAt: true } } },
    });
    const { canSee } = await access.forWorkspace(req.user, workspaceId);
    return { pages: links.map((l) => l.page).filter((p) => canSee(p.id)), canEdit: role !== 'VIEWER' };
  });
  app.post('/tasks/:id/wiki-pages', { ...auth, schema: { params: idParam, body: linkBody('pageId') } }, async (req, reply) => {
    await authz.check(req.user, 'task', req.params.id, 'EDITOR');
    const ws = await linkPageTask(req, req.body.pageId, req.params.id);
    await notifyLink(ws, req.body.pageId, req.params.id, req.user.displayName);
    return reply.code(201).send({ ok: true });
  });
  app.delete('/tasks/:id/wiki-pages/:pageId', { ...auth, schema: { params: { type: 'object', required: ['id', 'pageId'], properties: { id: uuid, pageId: uuid } } } }, async (req) => {
    await authz.check(req.user, 'task', req.params.id, 'EDITOR');
    const ws = await unlinkPageTask(req, req.params.pageId, req.params.id);
    await notifyLink(ws, req.params.pageId, req.params.id, req.user.displayName);
    return { ok: true };
  });

  // Recherche de tâches d'un espace (sélecteur « lier une tâche »)
  app.get('/workspaces/:id/tasks', {
    ...auth,
    schema: { params: idParam, querystring: { type: 'object', additionalProperties: false, properties: { q: { type: 'string', maxLength: 200, default: '' } } } },
  }, async (req) => {
    await authz.require(req.user, req.params.id, 'VIEWER');
    const tasks = await prisma.task.findMany({
      where: { archivedAt: null, column: { board: { workspaceId: req.params.id, archived: false } }, ...(req.query.q.trim() ? { title: { contains: req.query.q.trim(), mode: 'insensitive' } } : {}) },
      orderBy: { updatedAt: 'desc' }, take: 20, select: taskSel,
    });
    return { tasks: tasks.map(publicTask) };
  });

  // --- Export d'une section (page et sous-pages) en archive ZIP : Markdown + fichiers ---
  app.get('/wiki/pages/:id/export.zip', { ...auth, schema: { params: idParam } }, async (req, reply) => {
    const { workspaceId } = await checkPage(req.user, req.params.id, 'VIEWER');
    const { canSee } = await access.forWorkspace(req.user, workspaceId);
    const ids = (await subtreeIds(req.params.id)).filter((id) => canSee(id));
    const pages = await prisma.wikiPage.findMany({ where: { id: { in: ids }, deletedAt: null }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
    const byParent = new Map();
    for (const p of pages) { const k = p.id === req.params.id ? 'root' : p.parentId; if (!byParent.has(k)) byParent.set(k, []); byParent.get(k).push(p); }
    const files = await prisma.wikiFile.findMany({ where: { pageId: { in: pages.map((p) => p.id) } } });
    const fileById = new Map(files.map((f) => [f.id, f]));
    const safeName = (t) => (t.replace(/[^\p{L}\p{N} ._-]+/gu, '_').replace(/^\.+/, '').trim().slice(0, 80) || 'page');
    const out = {};
    const used = new Set();
    const unique = (p) => { let n = p; let i = 2; while (used.has(n.toLowerCase())) n = p.replace(/(\.md)?$/, ` (${i++})$1`); used.add(n.toLowerCase()); return n; };
    const usedFiles = new Map();
    let total = 0;
    const walk = (list, dir, depth) => {
      for (const p of list) {
        const base = safeName(p.title);
        const fileUrl = (src) => {
          const id = src.split('/').pop();
          const f = fileById.get(id);
          if (!f) return src;
          const name = `_fichiers/${f.id.slice(0, 8)}-${safeName(f.filename)}`;
          usedFiles.set(f.id, name);
          return `${'../'.repeat(depth)}${encodeURI(name)}`;
        };
        out[unique(`${dir}${base}.md`)] = Buffer.from(docToMarkdown(p.title, p.content, { fileUrl }), 'utf8');
        const children = byParent.get(p.id) ?? [];
        if (children.length) walk(children, `${dir}${base}/`, depth + 1);
      }
    };
    walk(byParent.get('root') ?? [], '', 0);
    for (const [id, name] of usedFiles) {
      const f = fileById.get(id);
      total += f.size;
      if (total > 500 * 1024 * 1024) throw badRequest('Section trop volumineuse pour un export (plus de 500 Mo de fichiers)');
      const filePath = path.join(uploadDir, f.storageName);
      if (fs.existsSync(filePath)) out[name] = fs.readFileSync(filePath);
    }
    const root = pages.find((p) => p.id === req.params.id);
    if (!root) throw notFound();
    await audit(req, 'wiki.export', { target: req.params.id, details: { pages: pages.length, files: usedFiles.size } });
    const zip = zipSync(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [new Uint8Array(v), { level: k.endsWith('.md') ? 6 : 0 }]])));
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${safeName(root.title)}.zip`)}`)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store')
      .send(Buffer.from(zip));
  });

  // ---------------------------------------------------------------------------
  // Page vérifiée (à la Confluence / Notion) : un propriétaire, une date de dernière vérification
  // et une périodicité de revue. Une page dont la revue est dépassée est signalée « à revoir ».
  // ---------------------------------------------------------------------------
  const REVIEW_PERIODS = [30, 90, 180, 365];
  function verificationStatus(p, now = Date.now()) {
    if (!p.verifiedAt) return p.reviewEveryDays ? 'expired' : 'none';
    if (!p.reviewEveryDays) return 'verified';
    return p.verifiedAt.getTime() + p.reviewEveryDays * 86400_000 < now ? 'expired' : 'verified';
  }
  async function verificationOf(page) {
    const [owner, verifiedBy] = await Promise.all([
      page.ownerId ? prisma.user.findUnique({ where: { id: page.ownerId }, ...userRef }) : null,
      page.verifiedById ? prisma.user.findUnique({ where: { id: page.verifiedById }, ...userRef }) : null,
    ]);
    const dueAt = page.verifiedAt && page.reviewEveryDays ? new Date(page.verifiedAt.getTime() + page.reviewEveryDays * 86400_000) : null;
    return { status: verificationStatus(page), owner, verifiedAt: page.verifiedAt, verifiedBy, reviewEveryDays: page.reviewEveryDays, dueAt };
  }

  app.put('/wiki/pages/:id/verification', {
    ...auth,
    schema: {
      params: idParam,
      body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { ownerId: nullableUuid, reviewEveryDays: { type: ['integer', 'null'], enum: [...REVIEW_PERIODS, null] } } },
    },
  }, async (req) => {
    const { workspaceId } = await checkPage(req.user, req.params.id, 'EDITOR');
    const data = {};
    if (req.body.ownerId !== undefined) {
      if (req.body.ownerId) {
        const owner = await prisma.user.findUnique({ where: { id: req.body.ownerId } });
        if (!owner || owner.disabled || !(await authz.workspaceRole(owner, workspaceId))) throw badRequest('Le propriétaire doit être membre de l\'espace');
      }
      data.ownerId = req.body.ownerId;
    }
    if (req.body.reviewEveryDays !== undefined) data.reviewEveryDays = req.body.reviewEveryDays;
    const page = await prisma.wikiPage.update({ where: { id: req.params.id }, data });
    realtime.wikiChanged(workspaceId, { pageId: page.id, reason: 'verification', by: req.user.displayName });
    return { verification: await verificationOf(page) };
  });

  app.post('/wiki/pages/:id/verify', { ...auth, schema: { params: idParam } }, async (req) => {
    const { workspaceId } = await checkPage(req.user, req.params.id, 'EDITOR');
    const current = await prisma.wikiPage.findUnique({ where: { id: req.params.id }, select: { deletedAt: true, ownerId: true } });
    if (current.deletedAt) throw conflict('Cette page est dans la corbeille');
    const page = await prisma.wikiPage.update({
      where: { id: req.params.id },
      // Sans propriétaire désigné, celui qui vérifie le devient
      data: { verifiedAt: new Date(), verifiedById: req.user.id, ...(current.ownerId ? {} : { ownerId: req.user.id }) },
    });
    await audit(req, 'wiki.verify', { target: page.id });
    realtime.wikiChanged(workspaceId, { pageId: page.id, reason: 'verification', by: req.user.displayName });
    return { verification: await verificationOf(page) };
  });

  app.delete('/wiki/pages/:id/verify', { ...auth, schema: { params: idParam } }, async (req) => {
    const { workspaceId } = await checkPage(req.user, req.params.id, 'EDITOR');
    const page = await prisma.wikiPage.update({ where: { id: req.params.id }, data: { verifiedAt: null, verifiedById: null } });
    realtime.wikiChanged(workspaceId, { pageId: page.id, reason: 'verification', by: req.user.displayName });
    return { verification: await verificationOf(page) };
  });

  // Pages à revoir (revue dépassée) et pages dont je suis propriétaire
  app.get('/workspaces/:id/wiki/review', { ...auth, schema: { params: idParam } }, async (req) => {
    await authz.require(req.user, req.params.id, 'VIEWER');
    const { canSee } = await access.forWorkspace(req.user, req.params.id);
    const rows = await prisma.wikiPage.findMany({
      where: { workspaceId: req.params.id, deletedAt: null, OR: [{ reviewEveryDays: { not: null } }, { ownerId: req.user.id }] },
      select: { id: true, title: true, icon: true, ownerId: true, verifiedAt: true, reviewEveryDays: true, owner: userRef },
      take: 2000,
    });
    const now = Date.now();
    const pages = rows.filter((p) => canSee(p.id)).map((p) => ({ ...p, status: verificationStatus(p, now) }));
    return {
      expired: pages.filter((p) => p.status === 'expired').sort((a, b) => (a.verifiedAt?.getTime() ?? 0) - (b.verifiedAt?.getTime() ?? 0)),
      mine: pages.filter((p) => p.ownerId === req.user.id),
    };
  });

  // ---------------------------------------------------------------------------
  // Commentaires de page : fils à un niveau (commentaire + réponses), résolvables
  // ---------------------------------------------------------------------------
  const commentSel = {
    id: true, pageId: true, parentId: true, content: true, createdAt: true, editedAt: true, resolvedAt: true,
    author: { select: { id: true, displayName: true } }, resolvedBy: { select: { id: true, displayName: true } },
  };
  /** Commentaire et contrôle d'accès à sa page (pages restreintes comprises). */
  async function checkComment(user, id, minRole) {
    await authz.check(user, 'wikiComment', id, minRole);
    const comment = await prisma.wikiComment.findUnique({ where: { id } });
    const { role, workspaceId } = await checkPage(user, comment.pageId, minRole);
    return { comment, role, workspaceId };
  }

  app.get('/wiki/pages/:id/comments', { ...auth, schema: { params: idParam } }, async (req) => {
    await checkPage(req.user, req.params.id, 'VIEWER');
    const all = await prisma.wikiComment.findMany({ where: { pageId: req.params.id }, orderBy: { createdAt: 'asc' }, select: commentSel, take: 2000 });
    const threads = all.filter((c) => !c.parentId).map((c) => ({ ...c, replies: all.filter((r) => r.parentId === c.id) }));
    return { threads };
  });

  const commentText = { type: 'string', minLength: 1, maxLength: 5000 };
  app.post('/wiki/pages/:id/comments', {
    ...auth,
    schema: { params: idParam, body: { type: 'object', required: ['content'], additionalProperties: false, properties: { content: commentText, parentId: nullableUuid } } },
  }, async (req, reply) => {
    const { workspaceId } = await checkPage(req.user, req.params.id, 'EDITOR');
    const page = await prisma.wikiPage.findUnique({ where: { id: req.params.id }, select: { deletedAt: true } });
    if (page.deletedAt) throw conflict('Cette page est dans la corbeille');
    if (req.body.parentId) {
      const parent = await prisma.wikiComment.findUnique({ where: { id: req.body.parentId }, select: { pageId: true, parentId: true } });
      if (!parent || parent.pageId !== req.params.id || parent.parentId) throw badRequest('Commentaire parent invalide');
    }
    const comment = await prisma.wikiComment.create({
      data: { pageId: req.params.id, parentId: req.body.parentId ?? null, content: req.body.content.trim() || req.body.content, authorId: req.user.id },
      select: commentSel,
    });
    // Une réponse rouvre un fil résolu
    if (req.body.parentId) await prisma.wikiComment.updateMany({ where: { id: req.body.parentId, resolvedAt: { not: null } }, data: { resolvedAt: null, resolvedById: null } });
    realtime.wikiChanged(workspaceId, { pageId: req.params.id, reason: 'comments', by: req.user.displayName });
    return reply.code(201).send({ comment });
  });

  app.patch('/wiki/comments/:id', {
    ...auth,
    schema: { params: idParam, body: { type: 'object', required: ['content'], additionalProperties: false, properties: { content: commentText } } },
  }, async (req) => {
    const { comment: current, workspaceId } = await checkComment(req.user, req.params.id, 'EDITOR');
    if (current.authorId !== req.user.id) throw forbidden('Seul l\'auteur peut modifier ce commentaire');
    const comment = await prisma.wikiComment.update({ where: { id: current.id }, data: { content: req.body.content, editedAt: new Date() }, select: commentSel });
    realtime.wikiChanged(workspaceId, { pageId: current.pageId, reason: 'comments', by: req.user.displayName });
    return { comment };
  });

  app.post('/wiki/comments/:id/resolve', {
    ...auth,
    schema: { params: idParam, body: { type: 'object', required: ['resolved'], additionalProperties: false, properties: { resolved: { type: 'boolean' } } } },
  }, async (req) => {
    const { comment: current, workspaceId } = await checkComment(req.user, req.params.id, 'EDITOR');
    if (current.parentId) throw badRequest('Seul le premier commentaire d\'un fil se résout');
    const comment = await prisma.wikiComment.update({
      where: { id: current.id },
      data: req.body.resolved ? { resolvedAt: new Date(), resolvedById: req.user.id } : { resolvedAt: null, resolvedById: null },
      select: commentSel,
    });
    realtime.wikiChanged(workspaceId, { pageId: current.pageId, reason: 'comments', by: req.user.displayName });
    return { comment };
  });

  app.delete('/wiki/comments/:id', { ...auth, schema: { params: idParam } }, async (req) => {
    const { comment, role, workspaceId } = await checkComment(req.user, req.params.id, 'VIEWER');
    if (comment.authorId !== req.user.id && role !== 'OWNER') throw forbidden();
    await prisma.wikiComment.delete({ where: { id: comment.id } }); // les réponses suivent (cascade)
    realtime.wikiChanged(workspaceId, { pageId: comment.pageId, reason: 'comments', by: req.user.displayName });
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // Modèles de page de l'équipe. Les images et fichiers ne sont pas repris : ils appartiennent
  // à la page d'origine (droits, cycle de vie) et un modèle ne doit pas en dépendre.
  // ---------------------------------------------------------------------------
  const tplProps = { title, icon, description: { type: 'string', maxLength: 300 } };
  const publicTemplate = (t) => ({ id: t.id, title: t.title, icon: t.icon, description: t.description, content: t.content, createdBy: t.createdBy ?? null, createdAt: t.createdAt, updatedAt: t.updatedAt });

  app.get('/workspaces/:id/wiki/templates', { ...auth, schema: { params: idParam } }, async (req) => {
    await authz.require(req.user, req.params.id, 'VIEWER');
    const templates = await prisma.wikiTemplate.findMany({ where: { workspaceId: req.params.id }, orderBy: { title: 'asc' }, include: { createdBy: { select: { id: true, displayName: true } } } });
    return { templates: templates.map(publicTemplate) };
  });

  app.post('/workspaces/:id/wiki/templates', {
    ...auth,
    bodyLimit: 2 * 1024 * 1024,
    schema: { params: idParam, body: { type: 'object', required: ['title'], additionalProperties: false, properties: { ...tplProps, content, pageId: uuid } } },
  }, async (req, reply) => {
    await authz.require(req.user, req.params.id, 'EDITOR');
    if (await prisma.wikiTemplate.count({ where: { workspaceId: req.params.id } }) >= 100) throw badRequest('100 modèles au plus par espace');
    let doc = req.body.content;
    if (req.body.pageId) {
      const { workspaceId } = await checkPage(req.user, req.body.pageId, 'VIEWER');
      if (workspaceId !== req.params.id) throw badRequest('La page doit appartenir à cet espace');
      doc = (await prisma.wikiPage.findUnique({ where: { id: req.body.pageId }, select: { content: true } })).content;
    }
    doc = remapFiles(sanitizeDoc(doc ?? emptyDoc()), new Map());
    const tpl = await prisma.wikiTemplate.create({
      data: { workspaceId: req.params.id, title: req.body.title, icon: req.body.icon ?? null, description: req.body.description ?? '', content: doc, createdById: req.user.id },
      include: { createdBy: { select: { id: true, displayName: true } } },
    });
    await audit(req, 'wiki.template.create', { target: tpl.id, details: { title: tpl.title } });
    return reply.code(201).send({ template: publicTemplate(tpl) });
  });

  app.patch('/wiki/templates/:id', {
    ...auth,
    schema: { params: idParam, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: tplProps } },
  }, async (req) => {
    await authz.check(req.user, 'wikiTemplate', req.params.id, 'EDITOR');
    const tpl = await prisma.wikiTemplate.update({ where: { id: req.params.id }, data: req.body, include: { createdBy: { select: { id: true, displayName: true } } } });
    return { template: publicTemplate(tpl) };
  });

  app.delete('/wiki/templates/:id', { ...auth, schema: { params: idParam } }, async (req) => {
    const { role } = await authz.check(req.user, 'wikiTemplate', req.params.id, 'EDITOR');
    const tpl = await prisma.wikiTemplate.findUnique({ where: { id: req.params.id } });
    if (tpl.createdById !== req.user.id && role !== 'OWNER') throw forbidden('Seuls l\'auteur du modèle et les propriétaires de l\'espace peuvent le supprimer');
    await prisma.wikiTemplate.delete({ where: { id: tpl.id } });
    await audit(req, 'wiki.template.delete', { target: tpl.id, details: { title: tpl.title } });
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // Duplication d'une page (et, sur demande, de ses sous-pages visibles). Les fichiers sont copiés :
  // la copie est indépendante de l'original. La restriction d'accès est reprise à l'identique.
  // ---------------------------------------------------------------------------
  async function copyFiles(srcPageId, dstPageId, doc, userId) {
    const ids = [...docFileIds(doc)];
    const files = ids.length ? await prisma.wikiFile.findMany({ where: { id: { in: ids } } }) : [];
    const map = new Map();
    for (const f of files) {
      const from = path.join(uploadDir, f.storageName);
      if (!fs.existsSync(from)) continue;
      const storageName = crypto.randomUUID();
      fs.copyFileSync(from, path.join(uploadDir, storageName));
      const nf = await prisma.wikiFile.create({ data: { pageId: dstPageId, filename: f.filename, storageName, mimetype: f.mimetype, size: f.size, sha256: f.sha256, uploadedById: userId } });
      map.set(f.id, nf.id);
    }
    return remapFiles(doc, map);
  }

  app.post('/wiki/pages/:id/duplicate', {
    ...auth,
    schema: { params: idParam, body: { type: 'object', additionalProperties: false, properties: { withChildren: { type: 'boolean' } } } },
  }, async (req, reply) => {
    const { workspaceId } = await checkPage(req.user, req.params.id, 'VIEWER');
    await authz.require(req.user, workspaceId, 'EDITOR');
    const root = await prisma.wikiPage.findUnique({ where: { id: req.params.id } });
    if (root.deletedAt) throw conflict('Cette page est dans la corbeille');
    if (root.parentId) await checkPage(req.user, root.parentId, 'EDITOR');
    const { canSee } = await access.forWorkspace(req.user, workspaceId);
    const ids = req.body?.withChildren ? (await subtreeIds(root.id)).filter((id) => canSee(id)) : [root.id];
    if (ids.length > 500) throw badRequest('Section trop volumineuse pour être dupliquée (500 pages au plus)');
    const pages = await prisma.wikiPage.findMany({ where: { id: { in: ids }, deletedAt: null }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
    const members = await prisma.wikiPageMember.findMany({ where: { pageId: { in: pages.filter((p) => p.restricted).map((p) => p.id) } } });

    // Position : juste après l'original parmi ses sœurs
    const next = await prisma.wikiPage.findFirst({ where: { workspaceId, parentId: root.parentId, deletedAt: null, position: { gt: root.position } }, orderBy: { position: 'asc' }, select: { position: true } });
    const idMap = new Map();
    const queue = [root];
    let copyRoot = null;
    while (queue.length) {
      const src = queue.shift();
      const isRoot = src.id === root.id;
      const created = await prisma.wikiPage.create({
        data: {
          workspaceId, parentId: isRoot ? root.parentId : idMap.get(src.parentId),
          title: isRoot ? `${src.title} (copie)`.slice(0, 200) : src.title, icon: src.icon,
          content: emptyDoc(), text: '', restricted: src.restricted,
          position: isRoot ? (next ? (root.position + next.position) / 2 : root.position + 1000) : src.position,
          createdById: req.user.id, updatedById: req.user.id,
        },
      });
      idMap.set(src.id, created.id);
      const doc = await copyFiles(src.id, created.id, src.content, req.user.id);
      const page = await prisma.wikiPage.update({ where: { id: created.id }, data: { content: doc, text: docText(doc) } });
      if (src.restricted) {
        await prisma.wikiPageMember.createMany({ data: members.filter((m) => m.pageId === src.id).map((m) => ({ pageId: created.id, userId: m.userId })) });
      }
      await saveRevision(page, req.user.id);
      copyRoot ??= page;
      queue.push(...pages.filter((p) => p.parentId === src.id));
    }
    await audit(req, 'wiki.duplicate', { target: root.id, details: { copy: copyRoot.id, pages: idMap.size } });
    realtime.wikiChanged(workspaceId, { pageId: copyRoot.id, version: copyRoot.version, reason: 'create', by: req.user.displayName });
    return reply.code(201).send({ page: publicPage(copyRoot), count: idMap.size });
  });

  // --- Co-édition en temps réel (Yjs sur Socket.io) ---
  collab = attachWikiCollab({ io: realtime.io, prisma, authz, access, onAbandon: autosave, log: app.log });
  realtime.wikiCollab = collab; // accessible hors du plugin (diagnostic, tests)
}
