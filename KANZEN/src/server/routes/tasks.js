import { badRequest, forbidden } from '../lib/errors.js';

const uuid = { type: 'string', format: 'uuid' };
const idParam = { type: 'object', required: ['id'], properties: { id: uuid } };
const COLORS = ['white', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'];
const taskProps = {
  title: { type: 'string', minLength: 1, maxLength: 300 },
  description: { type: 'string', maxLength: 20000 },
  color: { enum: COLORS },
  dueDate: { type: ['string', 'null'], format: 'date-time' },
  assigneeId: { type: ['string', 'null'], format: 'uuid' },
};

export default async function taskRoutes(app) {
  const { prisma, authz, realtime } = app;
  const auth = { onRequest: [app.requireUser] };
  const boardOfColumn = async (columnId) => (await prisma.column.findUnique({ where: { id: columnId }, select: { boardId: true } })).boardId;
  const boardOfTask = async (taskId) => (await prisma.task.findUnique({ where: { id: taskId }, select: { column: { select: { boardId: true } } } })).column.boardId;

  // L'assigné doit être membre de l'espace
  async function checkAssignee(workspaceId, assigneeId) {
    if (!assigneeId) return;
    const user = await prisma.user.findUnique({ where: { id: assigneeId } });
    if (!user || user.disabled || !(await authz.workspaceRole(user, workspaceId))) throw badRequest('Assigné non membre de l\'espace');
  }
  const toData = (b) => ({ ...b, ...(b.dueDate !== undefined ? { dueDate: b.dueDate ? new Date(b.dueDate) : null } : {}) });

  app.post('/columns/:id/tasks', {
    ...auth,
    schema: { params: idParam, body: { type: 'object', required: ['title'], additionalProperties: false, properties: taskProps } },
  }, async (req, reply) => {
    const { workspaceId } = await authz.check(req.user, 'column', req.params.id, 'EDITOR');
    await checkAssignee(workspaceId, req.body.assigneeId);
    const last = await prisma.task.findFirst({ where: { columnId: req.params.id }, orderBy: { position: 'desc' } });
    const task = await prisma.task.create({
      data: { ...toData(req.body), columnId: req.params.id, position: (last?.position ?? 0) + 1000, createdById: req.user.id },
    });
    await prisma.taskEvent.create({ data: { taskId: task.id, toColumnId: task.columnId, actorId: req.user.id } });
    realtime.boardChanged(await boardOfColumn(task.columnId), 'task');
    return reply.code(201).send({ task });
  });

  app.get('/tasks/:id', { ...auth, schema: { params: idParam } }, async (req) => {
    const { role } = await authz.check(req.user, 'task', req.params.id, 'VIEWER');
    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      include: {
        assignee: { select: { id: true, username: true, displayName: true } },
        createdBy: { select: { id: true, displayName: true } },
        subtasks: { orderBy: { position: 'asc' } },
        comments: { orderBy: { createdAt: 'asc' }, include: { author: { select: { id: true, displayName: true } } } },
        attachments: { orderBy: { uploadedAt: 'asc' }, select: { id: true, filename: true, mimetype: true, size: true, uploadedAt: true } },
      },
    });
    return { task: { ...task, myRole: role } };
  });

  app.patch('/tasks/:id', {
    ...auth,
    schema: { params: idParam, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: taskProps } },
  }, async (req) => {
    const { workspaceId } = await authz.check(req.user, 'task', req.params.id, 'EDITOR');
    await checkAssignee(workspaceId, req.body.assigneeId);
    const task = await prisma.task.update({ where: { id: req.params.id }, data: toData(req.body) });
    realtime.boardChanged(await boardOfColumn(task.columnId), 'task');
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
    const task = await prisma.task.findUnique({ where: { id: req.params.id }, include: { column: true } });
    const target = await prisma.column.findUnique({ where: { id: req.body.columnId } });
    if (!target || target.boardId !== task.column.boardId) throw badRequest('Colonne cible invalide');
    // Position entre les voisins indiqués (afterId = carte au-dessus, beforeId = carte en dessous)
    const pos = async (id) => (id ? (await prisma.task.findFirst({ where: { id, columnId: target.id }, select: { position: true } }))?.position : undefined);
    const above = await pos(req.body.afterId);
    const below = await pos(req.body.beforeId);
    let position;
    if (above !== undefined && below !== undefined) position = (above + below) / 2;
    else if (above !== undefined) position = above + 1000;
    else if (below !== undefined) position = below - 1000;
    else position = ((await prisma.task.findFirst({ where: { columnId: target.id }, orderBy: { position: 'desc' } }))?.position ?? 0) + 1000;

    const updated = await prisma.task.update({ where: { id: task.id }, data: { columnId: target.id, position } });
    if (task.columnId !== target.id) {
      await prisma.taskEvent.create({ data: { taskId: task.id, fromColumnId: task.columnId, toColumnId: target.id, actorId: req.user.id } });
    }
    realtime.boardChanged(target.boardId, 'move');
    return { task: updated };
  });

  app.delete('/tasks/:id', { ...auth, schema: { params: idParam } }, async (req) => {
    await authz.check(req.user, 'task', req.params.id, 'EDITOR');
    const boardId = await boardOfTask(req.params.id);
    const attachments = await prisma.attachment.findMany({ where: { taskId: req.params.id }, select: { storageName: true } });
    await prisma.task.delete({ where: { id: req.params.id } });
    await app.removeStoredFiles(attachments.map((a) => a.storageName));
    realtime.boardChanged(boardId, 'task');
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
    realtime.boardChanged(await boardOfTask(req.params.id), 'subtask');
    return reply.code(201).send({ subtask });
  });

  app.patch('/subtasks/:id', {
    ...auth,
    schema: { params: idParam, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { content: { type: 'string', minLength: 1, maxLength: 300 }, completed: { type: 'boolean' } } } },
  }, async (req) => {
    await authz.check(req.user, 'subtask', req.params.id, 'EDITOR');
    const subtask = await prisma.subTask.update({ where: { id: req.params.id }, data: req.body });
    realtime.boardChanged(await boardOfTask(subtask.taskId), 'subtask');
    return { subtask };
  });

  app.delete('/subtasks/:id', { ...auth, schema: { params: idParam } }, async (req) => {
    await authz.check(req.user, 'subtask', req.params.id, 'EDITOR');
    const subtask = await prisma.subTask.delete({ where: { id: req.params.id } });
    realtime.boardChanged(await boardOfTask(subtask.taskId), 'subtask');
    return { ok: true };
  });

  // --- Commentaires ---
  app.post('/tasks/:id/comments', {
    ...auth,
    schema: { params: idParam, body: { type: 'object', required: ['content'], additionalProperties: false, properties: { content: { type: 'string', minLength: 1, maxLength: 10000 } } } },
  }, async (req, reply) => {
    await authz.check(req.user, 'task', req.params.id, 'EDITOR');
    const comment = await prisma.comment.create({ data: { content: req.body.content, taskId: req.params.id, authorId: req.user.id } });
    realtime.boardChanged(await boardOfTask(req.params.id), 'comment');
    return reply.code(201).send({ comment });
  });

  app.delete('/comments/:id', { ...auth, schema: { params: idParam } }, async (req) => {
    const { role } = await authz.check(req.user, 'comment', req.params.id, 'VIEWER');
    const comment = await prisma.comment.findUnique({ where: { id: req.params.id } });
    if (comment.authorId !== req.user.id && role !== 'OWNER') throw forbidden();
    await prisma.comment.delete({ where: { id: comment.id } });
    realtime.boardChanged(await boardOfTask(comment.taskId), 'comment');
    return { ok: true };
  });
}
