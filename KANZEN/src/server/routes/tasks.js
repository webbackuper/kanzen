import { badRequest, forbidden } from '../lib/errors.js';

const uuid = { type: 'string', format: 'uuid' };
const idParam = { type: 'object', required: ['id'], properties: { id: uuid } };
const COLORS = ['white', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'];
const taskProps = {
  title: { type: 'string', minLength: 1, maxLength: 300 },
  description: { type: 'string', maxLength: 20000 },
  color: { enum: COLORS },
  dueDate: { type: ['string', 'null'], format: 'date-time' },
  // Affectation multiple : liste complète des assignés (remplace la liste existante)
  assigneeIds: { type: 'array', maxItems: 25, uniqueItems: true, items: { type: 'string', format: 'uuid' } },
};
const assigneesInclude = { assignees: { orderBy: { assignedAt: 'asc' }, select: { user: { select: { id: true, username: true, displayName: true } } } } };
const flatAssignees = (t) => ({ ...t, assignees: (t.assignees ?? []).map((a) => a.user) });

// Écart minimal entre deux positions voisines. En dessous, la précision d'un double ne garantit plus un ordre
// stable (après ~50 insertions au même endroit) : la colonne est alors renumérotée par pas de STEP.
export const STEP = 1000;
export const MIN_GAP = 1e-6;

/**
 * Position pour insérer une carte au rang « index » parmi « siblings » (triés, carte déplacée exclue).
 * Renumérote la colonne dans la transaction « tx » si l'écart entre les voisins est épuisé.
 */
export async function placeAt(tx, siblings, index) {
  const above = siblings[index - 1]?.position;
  const below = siblings[index]?.position;
  if (above === undefined && below === undefined) return STEP;
  if (below === undefined) return above + STEP;
  if (above === undefined) return below - STEP;
  if (below - above > MIN_GAP) {
    const mid = (above + below) / 2;
    if (mid > above && mid < below) return mid;
  }
  for (let i = 0; i < siblings.length; i += 1) {
    const position = (i < index ? i + 1 : i + 2) * STEP;
    if (siblings[i].position !== position) await tx.task.update({ where: { id: siblings[i].id }, data: { position } });
  }
  return (index + 1) * STEP;
}

export default async function taskRoutes(app) {
  const { prisma, authz, realtime } = app;
  const auth = { onRequest: [app.requireUser] };
  const boardOfColumn = async (columnId) => (await prisma.column.findUnique({ where: { id: columnId }, select: { boardId: true } })).boardId;
  const boardOfTask = async (taskId) => (await prisma.task.findUnique({ where: { id: taskId }, select: { column: { select: { boardId: true } } } })).column.boardId;

  // Chaque assigné doit être un compte actif membre de l'espace
  async function checkAssignees(workspaceId, ids) {
    if (!ids?.length) return;
    const users = await prisma.user.findMany({ where: { id: { in: ids } } });
    if (users.length !== ids.length) throw badRequest('Assigné inconnu');
    for (const u of users) {
      if (u.disabled || !(await authz.workspaceRole(u, workspaceId))) throw badRequest(`${u.displayName} n'est pas membre de l'espace`);
    }
  }
  const toData = ({ assigneeIds, ...b }) => ({
    ...b,
    ...(b.dueDate !== undefined ? { dueDate: b.dueDate ? new Date(b.dueDate) : null } : {}),
    ...(assigneeIds !== undefined ? { assignees: { deleteMany: {}, create: assigneeIds.map((userId) => ({ userId })) } } : {}),
  });

  app.post('/columns/:id/tasks', {
    ...auth,
    schema: { params: idParam, body: { type: 'object', required: ['title'], additionalProperties: false, properties: taskProps } },
  }, async (req, reply) => {
    const { workspaceId } = await authz.check(req.user, 'column', req.params.id, 'EDITOR');
    await checkAssignees(workspaceId, req.body.assigneeIds);
    const last = await prisma.task.findFirst({ where: { columnId: req.params.id }, orderBy: { position: 'desc' } });
    const { assignees, ...data } = toData(req.body);
    const task = flatAssignees(await prisma.task.create({
      data: {
        ...data, columnId: req.params.id, position: (last?.position ?? 0) + 1000, createdById: req.user.id,
        ...(assignees ? { assignees: { create: assignees.create } } : {}),
      },
      include: assigneesInclude,
    }));
    await prisma.taskEvent.create({ data: { taskId: task.id, toColumnId: task.columnId, actorId: req.user.id } });
    realtime.boardChanged(await boardOfColumn(task.columnId), 'task', req);
    return reply.code(201).send({ task });
  });

  app.get('/tasks/:id', { ...auth, schema: { params: idParam } }, async (req) => {
    const { role } = await authz.check(req.user, 'task', req.params.id, 'VIEWER');
    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      include: {
        ...assigneesInclude,
        createdBy: { select: { id: true, displayName: true } },
        subtasks: { orderBy: { position: 'asc' } },
        comments: { orderBy: { createdAt: 'asc' }, include: { author: { select: { id: true, displayName: true } } } },
        attachments: { orderBy: { uploadedAt: 'asc' }, select: { id: true, filename: true, mimetype: true, size: true, uploadedAt: true } },
      },
    });
    return { task: { ...flatAssignees(task), myRole: role } };
  });

  app.patch('/tasks/:id', {
    ...auth,
    schema: { params: idParam, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: taskProps } },
  }, async (req) => {
    const { workspaceId } = await authz.check(req.user, 'task', req.params.id, 'EDITOR');
    await checkAssignees(workspaceId, req.body.assigneeIds);
    const task = flatAssignees(await prisma.task.update({ where: { id: req.params.id }, data: toData(req.body), include: assigneesInclude }));
    realtime.boardChanged(await boardOfColumn(task.columnId), 'task', req);
    return { task };
  });

  // Déplacement : la colonne cible doit appartenir au MÊME tableau (corrige l'IDOR de la v2)
  app.post('/tasks/:id/move', {
    ...auth,
    schema: {
      params: idParam,
      body: { type: 'object', required: ['columnId'], additionalProperties: false, properties: { columnId: uuid, beforeId: { type: ['string', 'null'], format: 'uuid' }, afterId: { type: ['string', 'null'], format: 'uuid' } } },
    },
  }, async (req) => {
    await authz.check(req.user, 'task', req.params.id, 'EDITOR');
    const { afterId = null, beforeId = null } = req.body;
    // Transaction + verrou de la colonne cible : deux déplacements simultanés dans la même colonne
    // sont sérialisés et ne peuvent plus calculer la même position.
    const { updated, target } = await prisma.$transaction(async (tx) => {
      const task = await tx.task.findUnique({ where: { id: req.params.id }, include: { column: true } });
      const target = await tx.column.findUnique({ where: { id: req.body.columnId } });
      if (!task || !target || target.boardId !== task.column.boardId) throw badRequest('Colonne cible invalide');
      await tx.$queryRaw`SELECT id FROM "Column" WHERE id = ${target.id}::uuid FOR UPDATE`;
      const siblings = await tx.task.findMany({
        where: { columnId: target.id, id: { not: task.id } }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }], select: { id: true, position: true },
      });
      // Rang d'insertion : après « afterId » (carte au-dessus), sinon avant « beforeId », sinon en fin de colonne
      let index = siblings.length;
      const ai = afterId ? siblings.findIndex((t) => t.id === afterId) : -1;
      const bi = beforeId ? siblings.findIndex((t) => t.id === beforeId) : -1;
      if (ai >= 0) index = ai + 1; else if (bi >= 0) index = bi;
      const position = await placeAt(tx, siblings, index);
      const updated = await tx.task.update({ where: { id: task.id }, data: { columnId: target.id, position } });
      if (task.columnId !== target.id) {
        await tx.taskEvent.create({ data: { taskId: task.id, fromColumnId: task.columnId, toColumnId: target.id, actorId: req.user.id } });
      }
      return { updated, target };
    });
    realtime.boardChanged(target.boardId, 'move', req);
    return { task: updated };
  });

  app.delete('/tasks/:id', { ...auth, schema: { params: idParam } }, async (req) => {
    await authz.check(req.user, 'task', req.params.id, 'EDITOR');
    const boardId = await boardOfTask(req.params.id);
    const attachments = await prisma.attachment.findMany({ where: { taskId: req.params.id }, select: { storageName: true } });
    await prisma.task.delete({ where: { id: req.params.id } });
    await app.removeStoredFiles(attachments.map((a) => a.storageName));
    realtime.boardChanged(boardId, 'task', req);
    return { ok: true };
  });

  // --- Sous-tâches ---
  app.post('/tasks/:id/subtasks', {
    ...auth,
    schema: { params: idParam, body: { type: 'object', required: ['content'], additionalProperties: false, properties: { content: { type: 'string', minLength: 1, maxLength: 300 } } } },
  }, async (req, reply) => {
    await authz.check(req.user, 'task', req.params.id, 'EDITOR');
    const last = await prisma.subTask.findFirst({ where: { taskId: req.params.id }, orderBy: { position: 'desc' } });
    const subtask = await prisma.subTask.create({ data: { content: req.body.content, taskId: req.params.id, position: (last?.position ?? 0) + 1000 } });
    realtime.boardChanged(await boardOfTask(req.params.id), 'subtask', req);
    return reply.code(201).send({ subtask });
  });

  app.patch('/subtasks/:id', {
    ...auth,
    schema: { params: idParam, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { content: { type: 'string', minLength: 1, maxLength: 300 }, completed: { type: 'boolean' } } } },
  }, async (req) => {
    await authz.check(req.user, 'subtask', req.params.id, 'EDITOR');
    const subtask = await prisma.subTask.update({ where: { id: req.params.id }, data: req.body });
    realtime.boardChanged(await boardOfTask(subtask.taskId), 'subtask', req);
    return { subtask };
  });

  app.delete('/subtasks/:id', { ...auth, schema: { params: idParam } }, async (req) => {
    await authz.check(req.user, 'subtask', req.params.id, 'EDITOR');
    const subtask = await prisma.subTask.delete({ where: { id: req.params.id } });
    realtime.boardChanged(await boardOfTask(subtask.taskId), 'subtask', req);
    return { ok: true };
  });

  // --- Commentaires ---
  app.post('/tasks/:id/comments', {
    ...auth,
    schema: { params: idParam, body: { type: 'object', required: ['content'], additionalProperties: false, properties: { content: { type: 'string', minLength: 1, maxLength: 10000 } } } },
  }, async (req, reply) => {
    await authz.check(req.user, 'task', req.params.id, 'EDITOR');
    const comment = await prisma.comment.create({ data: { content: req.body.content, taskId: req.params.id, authorId: req.user.id } });
    realtime.boardChanged(await boardOfTask(req.params.id), 'comment', req);
    return reply.code(201).send({ comment });
  });

  app.delete('/comments/:id', { ...auth, schema: { params: idParam } }, async (req) => {
    const { role } = await authz.check(req.user, 'comment', req.params.id, 'VIEWER');
    const comment = await prisma.comment.findUnique({ where: { id: req.params.id } });
    if (comment.authorId !== req.user.id && role !== 'OWNER') throw forbidden();
    await prisma.comment.delete({ where: { id: comment.id } });
    realtime.boardChanged(await boardOfTask(comment.taskId), 'comment', req);
    return { ok: true };
  });
}
