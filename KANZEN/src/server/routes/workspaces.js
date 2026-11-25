import { conflict, notFound } from '../lib/errors.js';

const uuid = { type: 'string', format: 'uuid' };
const idParam = { type: 'object', required: ['id'], properties: { id: uuid } };

const slugify = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'espace';

export default async function workspaceRoutes(app) {
  const { prisma, authz, audit } = app;
  const auth = { onRequest: [app.requireUser] };

  app.get('/workspaces', auth, async (req) => {
    const where = req.user.role === 'ADMIN' ? {} : { members: { some: { userId: req.user.id } } };
    const list = await prisma.workspace.findMany({
      where, orderBy: { name: 'asc' },
      include: { members: { where: { userId: req.user.id }, select: { role: true } }, _count: { select: { boards: true, members: true } } },
    });
    return {
      workspaces: list.map((w) => ({
        id: w.id, name: w.name, slug: w.slug, boards: w._count.boards, members: w._count.members,
        myRole: req.user.role === 'ADMIN' ? 'OWNER' : w.members[0]?.role,
      })),
    };
  });

  app.post('/workspaces', {
    ...auth,
    schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 100 } } } },
  }, async (req, reply) => {
    const base = slugify(req.body.name);
    let slug = base;
    for (let i = 2; await prisma.workspace.findUnique({ where: { slug } }); i++) slug = `${base}-${i}`;
    const ws = await prisma.workspace.create({
      data: { name: req.body.name, slug, members: { create: { userId: req.user.id, role: 'OWNER' } } },
    });
    await audit(req, 'workspace.create', { target: ws.id, details: { name: ws.name } });
    return reply.code(201).send({ workspace: ws });
  });

  app.get('/workspaces/:id', { ...auth, schema: { params: idParam } }, async (req) => {
    const role = await authz.require(req.user, req.params.id, 'VIEWER');
    const ws = await prisma.workspace.findUnique({
      where: { id: req.params.id },
      include: {
        boards: { where: { archived: false }, orderBy: { createdAt: 'asc' }, select: { id: true, title: true, createdAt: true } },
        members: { include: { user: { select: { id: true, username: true, displayName: true } } }, orderBy: { user: { displayName: 'asc' } } },
      },
    });
    return {
      workspace: {
        id: ws.id, name: ws.name, slug: ws.slug, myRole: role, boards: ws.boards,
        members: ws.members.map((m) => ({ ...m.user, role: m.role })),
      },
    };
  });

  app.patch('/workspaces/:id', {
    ...auth,
    schema: { params: idParam, body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 100 } } } },
  }, async (req) => {
    await authz.require(req.user, req.params.id, 'OWNER');
    const ws = await prisma.workspace.update({ where: { id: req.params.id }, data: { name: req.body.name } });
    return { workspace: ws };
  });

  app.delete('/workspaces/:id', { ...auth, schema: { params: idParam } }, async (req) => {
    await authz.require(req.user, req.params.id, 'OWNER');
    await prisma.workspace.delete({ where: { id: req.params.id } });
    await audit(req, 'workspace.delete', { target: req.params.id });
    return { ok: true };
  });

  // Ajout ou changement de rôle d'un membre
  app.put('/workspaces/:id/members/:userId', {
    ...auth,
    schema: {
      params: { type: 'object', required: ['id', 'userId'], properties: { id: uuid, userId: uuid } },
      body: { type: 'object', required: ['role'], additionalProperties: false, properties: { role: { enum: ['OWNER', 'EDITOR', 'VIEWER'] } } },
    },
  }, async (req) => {
    const { id, userId } = req.params;
    await authz.require(req.user, id, 'OWNER');
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.disabled) throw notFound('Utilisateur introuvable');
    if (req.body.role !== 'OWNER') await ensureAnotherOwner(id, userId);
    const m = await prisma.workspaceMember.upsert({
      where: { userId_workspaceId: { userId, workspaceId: id } },
      create: { userId, workspaceId: id, role: req.body.role },
      update: { role: req.body.role },
    });
    await audit(req, 'workspace.member_set', { target: id, details: { userId, role: m.role } });
    return { member: m };
  });

  app.delete('/workspaces/:id/members/:userId', {
    ...auth,
    schema: { params: { type: 'object', required: ['id', 'userId'], properties: { id: uuid, userId: uuid } } },
  }, async (req) => {
    const { id, userId } = req.params;
    if (userId !== req.user.id) await authz.require(req.user, id, 'OWNER'); // on peut toujours quitter un espace
    await ensureAnotherOwner(id, userId);
    await prisma.workspaceMember.delete({ where: { userId_workspaceId: { userId, workspaceId: id } } });
    await audit(req, 'workspace.member_remove', { target: id, details: { userId } });
    return { ok: true };
  });

  // Un espace garde toujours au moins un propriétaire
  async function ensureAnotherOwner(workspaceId, userId) {
    const current = await prisma.workspaceMember.findUnique({ where: { userId_workspaceId: { userId, workspaceId } } });
    if (current?.role !== 'OWNER') return;
    const owners = await prisma.workspaceMember.count({ where: { workspaceId, role: 'OWNER' } });
    if (owners <= 1) throw conflict('L\'espace doit conserver au moins un propriétaire');
  }

  // Tableaux d'un espace
  app.post('/workspaces/:id/boards', {
    ...auth,
    schema: {
      params: idParam,
      body: { type: 'object', required: ['title'], additionalProperties: false, properties: { title: { type: 'string', minLength: 1, maxLength: 120 }, template: { enum: ['empty', 'kanban'] } } },
    },
  }, async (req, reply) => {
    await authz.require(req.user, req.params.id, 'EDITOR');
    const cols = req.body.template === 'empty' ? [] : ['À faire', 'En cours', 'En revue', 'Terminé'];
    const board = await prisma.board.create({
      data: { title: req.body.title, workspaceId: req.params.id, columns: { create: cols.map((title, i) => ({ title, position: (i + 1) * 1000 })) } },
    });
    return reply.code(201).send({ board });
  });

}
