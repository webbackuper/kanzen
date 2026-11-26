import { badRequest, conflict, forbidden } from '../lib/errors.js';

const uuid = { type: 'string', format: 'uuid' };
const idParam = { type: 'object', required: ['id'], properties: { id: uuid } };
const COLORS = ['white', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'];
export const PRIORITIES = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const uuidList = (max) => ({ type: 'array', maxItems: max, uniqueItems: true, items: uuid });
const taskProps = {
  title: { type: 'string', minLength: 1, maxLength: 300 },
  description: { type: 'string', maxLength: 20000 },
  color: { enum: COLORS },
  dueDate: { type: ['string', 'null'], format: 'date-time' },
  startDate: { type: ['string', 'null'], format: 'date-time' },
  priority: { enum: PRIORITIES },
  estimate: { type: ['number', 'null'], minimum: 0, maximum: 100000 },
  // Affectation multiple : liste complète des assignés (remplace la liste existante)
  assigneeIds: uuidList(25),
  // Étiquettes du tableau : liste complète (remplace la liste existante)
  labelIds: uuidList(20),
};
const userSel = { select: { id: true, username: true, displayName: true } };
const assigneesInclude = { assignees: { orderBy: { assignedAt: 'asc' }, select: { user: userSel } } };
const labelsInclude = { labels: { select: { labelId: true } } };
const taskInclude = { ...assigneesInclude, ...labelsInclude };
const flatTask = (t) => ({
  ...t,
  assignees: (t.assignees ?? []).map((a) => a.user),
  ...(t.labels ? { labels: undefined, labelIds: t.labels.map((l) => l.labelId) } : {}),
});
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

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

const depTaskSel = { id: true, title: true, archivedAt: true, column: { select: { id: true, title: true, boardId: true, board: { select: { title: true } } } } };

/** Validation d'une valeur de champ personnalisé selon son type ; null efface la valeur. */
export function checkFieldValue(field, value) {
  if (value === null) return null;
  switch (field.type) {
    case 'TEXT': if (typeof value === 'string' && value.length <= 500) return value; break;
    case 'NUMBER': if (typeof value === 'number' && Number.isFinite(value)) return value; break;
    case 'DATE': if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))) return value; break;
    case 'SELECT': if (typeof value === 'string' && field.options.includes(value)) return value; break;
    case 'CHECKBOX': if (typeof value === 'boolean') return value; break;
    default:
  }
  throw badRequest(`Valeur invalide pour le champ « ${field.name} »`);
}

export default async function taskRoutes(app) {
  const { prisma, authz, realtime } = app;
  /** Dernière colonne (« terminé ») de chaque tableau cité. */
  async function lastColumnIds(boardIds) {
    const ids = [...new Set(boardIds)];
    if (!ids.length) return new Set();
    const cols = await prisma.column.findMany({ where: { boardId: { in: ids } }, select: { id: true, boardId: true, position: true }, orderBy: { position: 'desc' } });
    const last = new Map();
    for (const c of cols) if (!last.has(c.boardId)) last.set(c.boardId, c.id);
    return new Set(last.values());
  }
  const auth = { onRequest: [app.requireUser] };
  const boardOfColumn = async (columnId) => (await prisma.column.findUnique({ where: { id: columnId }, select: { boardId: true } })).boardId;
  const boardOfTask = async (taskId) => (await prisma.task.findUnique({ where: { id: taskId }, select: { column: { select: { boardId: true } } } })).column.boardId;
  const activity = (taskId, actorId, type, data) => prisma.taskActivity.create({ data: { taskId, actorId, type, ...(data ? { data } : {}) } });

  // Chaque assigné doit être un compte actif membre de l'espace
  async function checkAssignees(workspaceId, ids) {
    if (!ids?.length) return;
    const users = await prisma.user.findMany({ where: { id: { in: ids } } });
    if (users.length !== ids.length) throw badRequest('Assigné inconnu');
    for (const u of users) {
      if (u.disabled || !(await authz.workspaceRole(u, workspaceId))) throw badRequest(`${u.displayName} n'est pas membre de l'espace`);
    }
  }
  // Les étiquettes doivent appartenir au tableau de la tâche
  async function checkLabels(boardId, ids) {
    if (!ids?.length) return;
    const n = await prisma.label.count({ where: { id: { in: ids }, boardId } });
    if (n !== ids.length) throw badRequest('Étiquette inconnue sur ce tableau');
  }
  function checkDates(startDate, dueDate) {
    if (startDate && dueDate && new Date(startDate) > new Date(dueDate)) throw badRequest('La date de début doit précéder l\'échéance');
  }
  const date = (v) => (v ? new Date(v) : null);
  const toData = ({ assigneeIds, labelIds, ...b }) => ({
    ...b,
    ...(b.dueDate !== undefined ? { dueDate: date(b.dueDate) } : {}),
    ...(b.startDate !== undefined ? { startDate: date(b.startDate) } : {}),
    ...(assigneeIds !== undefined ? { assignees: { deleteMany: {}, create: assigneeIds.map((userId) => ({ userId })) } } : {}),
    ...(labelIds !== undefined ? { labels: { deleteMany: {}, create: labelIds.map((labelId) => ({ labelId })) } } : {}),
  });

  /** Résumé lisible des champs modifiés, pour le journal d'activité. */
  async function describeChanges(before, after) {
    const changes = [];
    if (before.title !== after.title) changes.push({ field: 'title', from: before.title, to: after.title });
    if (before.description !== after.description) changes.push({ field: 'description' });
    if (before.color !== after.color) changes.push({ field: 'color', from: before.color, to: after.color });
    if (before.priority !== after.priority) changes.push({ field: 'priority', from: before.priority, to: after.priority });
    if ((before.estimate ?? null) !== (after.estimate ?? null)) changes.push({ field: 'estimate', from: before.estimate ?? null, to: after.estimate ?? null });
    if (day(before.dueDate) !== day(after.dueDate)) changes.push({ field: 'dueDate', from: day(before.dueDate), to: day(after.dueDate) });
    if (day(before.startDate) !== day(after.startDate)) changes.push({ field: 'startDate', from: day(before.startDate), to: day(after.startDate) });
    const diffIds = (a, b) => ({ added: b.filter((x) => !a.includes(x)), removed: a.filter((x) => !b.includes(x)) });
    const a = diffIds(before.assignees.map((u) => u.id), after.assignees.map((u) => u.id));
    if (a.added.length || a.removed.length) {
      const names = new Map([...before.assignees, ...after.assignees].map((u) => [u.id, u.displayName]));
      changes.push({ field: 'assignees', added: a.added.map((id) => names.get(id)), removed: a.removed.map((id) => names.get(id)) });
    }
    const l = diffIds(before.labelIds, after.labelIds);
    if (l.added.length || l.removed.length) {
      const labels = await prisma.label.findMany({ where: { id: { in: [...l.added, ...l.removed] } }, select: { id: true, name: true } });
      const n = new Map(labels.map((x) => [x.id, x.name]));
      changes.push({ field: 'labels', added: l.added.map((id) => n.get(id)), removed: l.removed.map((id) => n.get(id)) });
    }
    return changes;
  }

  app.post('/columns/:id/tasks', {
    ...auth,
    schema: { params: idParam, body: { type: 'object', required: ['title'], additionalProperties: false, properties: taskProps } },
  }, async (req, reply) => {
    const { workspaceId } = await authz.check(req.user, 'column', req.params.id, 'EDITOR');
    const boardId = await boardOfColumn(req.params.id);
    await checkAssignees(workspaceId, req.body.assigneeIds);
    await checkLabels(boardId, req.body.labelIds);
    checkDates(req.body.startDate, req.body.dueDate);
    const last = await prisma.task.findFirst({ where: { columnId: req.params.id }, orderBy: { position: 'desc' } });
    const { assignees, labels, ...data } = toData(req.body);
    const task = flatTask(await prisma.task.create({
      data: {
        ...data, columnId: req.params.id, position: (last?.position ?? 0) + 1000, createdById: req.user.id,
        ...(assignees ? { assignees: { create: assignees.create } } : {}),
        ...(labels ? { labels: { create: labels.create } } : {}),
      },
      include: taskInclude,
    }));
    await prisma.taskEvent.create({ data: { taskId: task.id, toColumnId: task.columnId, actorId: req.user.id } });
    await activity(task.id, req.user.id, 'create');
    realtime.boardChanged(boardId, 'task', req);
    return reply.code(201).send({ task });
  });

  app.get('/tasks/:id', { ...auth, schema: { params: idParam } }, async (req) => {
    const { role } = await authz.check(req.user, 'task', req.params.id, 'VIEWER');
    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      include: {
        ...taskInclude,
        column: { select: { id: true, title: true, boardId: true, board: { select: { labels: { orderBy: { position: 'asc' } }, fields: { orderBy: { position: 'asc' } } } } } },
        fieldValues: { select: { fieldId: true, value: true } },
        blockedBy: { select: { blocker: { select: depTaskSel } } },
        blocks: { select: { blocked: { select: depTaskSel } } },
        createdBy: { select: { id: true, displayName: true } },
        subtasks: { orderBy: { position: 'asc' } },
        comments: { orderBy: { createdAt: 'asc' }, include: { author: { select: { id: true, displayName: true } } } },
        attachments: { orderBy: { uploadedAt: 'asc' }, select: { id: true, filename: true, mimetype: true, size: true, uploadedAt: true } },
      },
    });
    const { column, fieldValues, blockedBy, blocks, ...rest } = task;
    const doneOf = await lastColumnIds([...blockedBy.map((d) => d.blocker), ...blocks.map((d) => d.blocked)].map((t) => t.column.boardId));
    const dep = (t) => ({ id: t.id, title: t.title, boardId: t.column.boardId, boardTitle: t.column.board.title, column: t.column.title, done: Boolean(t.archivedAt) || doneOf.has(t.column.id) });
    return {
      task: {
        ...flatTask(rest), myRole: role, boardId: column.boardId,
        column: { id: column.id, title: column.title }, boardLabels: column.board.labels, boardFields: column.board.fields,
        fieldValues: Object.fromEntries(fieldValues.map((v) => [v.fieldId, v.value])),
        blockedBy: blockedBy.map((d) => dep(d.blocker)),
        blocks: blocks.map((d) => dep(d.blocked)),
      },
    };
  });

  app.patch('/tasks/:id', {
    ...auth,
    schema: { params: idParam, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: taskProps } },
  }, async (req) => {
    const { workspaceId } = await authz.check(req.user, 'task', req.params.id, 'EDITOR');
    const before = flatTask(await prisma.task.findUnique({ where: { id: req.params.id }, include: taskInclude }));
    const boardId = await boardOfColumn(before.columnId);
    await checkAssignees(workspaceId, req.body.assigneeIds);
    await checkLabels(boardId, req.body.labelIds);
    checkDates(req.body.startDate !== undefined ? req.body.startDate : before.startDate, req.body.dueDate !== undefined ? req.body.dueDate : before.dueDate);
    const task = flatTask(await prisma.task.update({ where: { id: req.params.id }, data: toData(req.body), include: taskInclude }));
    const changes = await describeChanges(before, task);
    if (changes.length) await activity(task.id, req.user.id, 'update', { changes });
    realtime.boardChanged(boardId, 'task', req);
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
      if (task?.archivedAt) throw conflict('Cette carte est archivée');
      const target = await tx.column.findUnique({ where: { id: req.body.columnId } });
      if (!task || !target || target.boardId !== task.column.boardId) throw badRequest('Colonne cible invalide');
      await tx.$queryRaw`SELECT id FROM "Column" WHERE id = ${target.id}::uuid FOR UPDATE`;
      const siblings = await tx.task.findMany({
        where: { columnId: target.id, id: { not: task.id }, archivedAt: null }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }], select: { id: true, position: true },
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
        await tx.taskActivity.create({ data: { taskId: task.id, actorId: req.user.id, type: 'move', data: { from: task.column.title, to: target.title } } });
      }
      return { updated, target };
    });
    realtime.boardChanged(target.boardId, 'move', req);
    return { task: updated };
  });

  // --- Archivage (à la Trello) : la carte quitte le tableau mais reste consultable et restaurable ---
  app.post('/tasks/:id/archive', { ...auth, schema: { params: idParam } }, async (req) => {
    await authz.check(req.user, 'task', req.params.id, 'EDITOR');
    const task = await prisma.task.update({ where: { id: req.params.id }, data: { archivedAt: new Date() }, select: { id: true, archivedAt: true, column: { select: { boardId: true } } } });
    await activity(task.id, req.user.id, 'archive');
    realtime.boardChanged(task.column.boardId, 'task', req);
    return { task: { id: task.id, archivedAt: task.archivedAt } };
  });

  app.post('/tasks/:id/restore', { ...auth, schema: { params: idParam } }, async (req) => {
    await authz.check(req.user, 'task', req.params.id, 'EDITOR');
    const current = await prisma.task.findUnique({ where: { id: req.params.id }, select: { columnId: true } });
    const last = await prisma.task.findFirst({ where: { columnId: current.columnId, archivedAt: null }, orderBy: { position: 'desc' } });
    const task = await prisma.task.update({
      where: { id: req.params.id }, data: { archivedAt: null, position: (last?.position ?? 0) + 1000 },
      select: { id: true, columnId: true, column: { select: { boardId: true } } },
    });
    await activity(task.id, req.user.id, 'restore');
    realtime.boardChanged(task.column.boardId, 'task', req);
    return { task: { id: task.id, columnId: task.columnId, archivedAt: null } };
  });

  app.get('/boards/:id/archived', { ...auth, schema: { params: idParam } }, async (req) => {
    await authz.check(req.user, 'board', req.params.id, 'VIEWER');
    const tasks = await prisma.task.findMany({
      where: { column: { boardId: req.params.id }, archivedAt: { not: null } },
      orderBy: { archivedAt: 'desc' },
      take: 500,
      select: { id: true, title: true, color: true, archivedAt: true, dueDate: true, priority: true, column: { select: { id: true, title: true } } },
    });
    return { tasks };
  });

  // --- Duplication (dans la même colonne, juste en dessous) ---
  app.post('/tasks/:id/duplicate', {
    ...auth,
    schema: { params: idParam, body: { type: 'object', additionalProperties: false, properties: { title: taskProps.title } } },
  }, async (req, reply) => {
    await authz.check(req.user, 'task', req.params.id, 'EDITOR');
    const src = await prisma.task.findUnique({ where: { id: req.params.id }, include: { ...taskInclude, subtasks: { orderBy: { position: 'asc' } }, fieldValues: true, column: { select: { boardId: true } } } });
    const next = await prisma.task.findFirst({ where: { columnId: src.columnId, position: { gt: src.position } }, orderBy: { position: 'asc' }, select: { position: true } });
    const position = next ? (src.position + next.position) / 2 : src.position + 1000;
    const copy = flatTask(await prisma.task.create({
      data: {
        title: req.body?.title ?? `${src.title} (copie)`.slice(0, 300),
        description: src.description, color: src.color, priority: src.priority, dueDate: src.dueDate, startDate: src.startDate, estimate: src.estimate,
        fieldValues: { create: src.fieldValues.map((v) => ({ fieldId: v.fieldId, value: v.value })) },
        columnId: src.columnId, position, createdById: req.user.id,
        assignees: { create: src.assignees.map((a) => ({ userId: a.user.id })) },
        labels: { create: src.labels.map((l) => ({ labelId: l.labelId })) },
        // La liste de contrôle est reprise, décochée : la copie sert souvent de modèle
        subtasks: { create: src.subtasks.map((s) => ({ content: s.content, position: s.position, completed: false })) },
      },
      include: taskInclude,
    }));
    await prisma.taskEvent.create({ data: { taskId: copy.id, toColumnId: copy.columnId, actorId: req.user.id } });
    await activity(copy.id, req.user.id, 'duplicate', { fromTitle: src.title });
    realtime.boardChanged(src.column.boardId, 'task', req);
    return reply.code(201).send({ task: copy });
  });

  // --- Transfert vers un autre tableau du même espace ---
  // Les étiquettes sont reprises par nom (créées si besoin sur le tableau cible), les assignés et liens wiki sont conservés.
  app.post('/tasks/:id/transfer', {
    ...auth,
    schema: { params: idParam, body: { type: 'object', required: ['boardId'], additionalProperties: false, properties: { boardId: uuid, columnId: uuid } } },
  }, async (req) => {
    const { workspaceId } = await authz.check(req.user, 'task', req.params.id, 'EDITOR');
    const target = await authz.check(req.user, 'board', req.body.boardId, 'EDITOR');
    if (target.workspaceId !== workspaceId) throw badRequest('Le tableau cible doit appartenir au même espace');
    const task = await prisma.task.findUnique({ where: { id: req.params.id }, include: { column: { select: { title: true, boardId: true, board: { select: { title: true } } } }, labels: { include: { label: true } }, fieldValues: { include: { field: true } } } });
    if (task.column.boardId === req.body.boardId) throw badRequest('La carte est déjà sur ce tableau');
    const column = req.body.columnId
      ? await prisma.column.findFirst({ where: { id: req.body.columnId, boardId: req.body.boardId } })
      : await prisma.column.findFirst({ where: { boardId: req.body.boardId }, orderBy: { position: 'asc' } });
    if (!column) throw badRequest('Colonne cible invalide');
    const targetBoard = await prisma.board.findUnique({ where: { id: req.body.boardId }, select: { title: true, labels: true, fields: true } });
    // Champs personnalisés : valeur reprise si le tableau cible a un champ de même nom et de même type
    const fieldValues = [];
    for (const v of task.fieldValues) {
      const same = targetBoard.fields.find((f) => f.name.toLowerCase() === v.field.name.toLowerCase() && f.type === v.field.type);
      if (same && (same.type !== 'SELECT' || same.options.includes(v.value))) fieldValues.push({ fieldId: same.id, value: v.value });
    }

    const labelIds = [];
    let pos = (targetBoard.labels.reduce((m, l) => Math.max(m, l.position), 0)) + 1000;
    for (const { label } of task.labels) {
      const same = targetBoard.labels.find((l) => l.name.toLowerCase() === label.name.toLowerCase());
      if (same) labelIds.push(same.id);
      else {
        const created = await prisma.label.create({ data: { boardId: req.body.boardId, name: label.name, color: label.color, position: pos } });
        pos += 1000;
        labelIds.push(created.id);
      }
    }
    const last = await prisma.task.findFirst({ where: { columnId: column.id }, orderBy: { position: 'desc' } });
    await prisma.task.update({
      where: { id: task.id },
      data: { columnId: column.id, position: (last?.position ?? 0) + 1000, labels: { deleteMany: {}, create: labelIds.map((labelId) => ({ labelId })) },
        fieldValues: { deleteMany: {}, create: fieldValues },
      },
    });
    await prisma.taskEvent.create({ data: { taskId: task.id, fromColumnId: task.columnId, toColumnId: column.id, actorId: req.user.id } });
    await activity(task.id, req.user.id, 'transfer', { fromBoard: task.column.board.title, toBoard: targetBoard.title, to: column.title });
    realtime.boardChanged(task.column.boardId, 'task', req);
    realtime.boardChanged(req.body.boardId, 'task', req);
    return { task: { id: task.id, boardId: req.body.boardId, columnId: column.id } };
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

  // --- Dépendances : « cette carte est bloquée par… » (même espace, sans cycle) ---
  app.post('/tasks/:id/dependencies', {
    ...auth,
    schema: { params: idParam, body: { type: 'object', required: ['blockerId'], additionalProperties: false, properties: { blockerId: uuid } } },
  }, async (req, reply) => {
    const { workspaceId } = await authz.check(req.user, 'task', req.params.id, 'EDITOR');
    const blockerId = req.body.blockerId;
    if (blockerId === req.params.id) throw badRequest('Une carte ne peut pas se bloquer elle-même');
    const other = await authz.check(req.user, 'task', blockerId, 'VIEWER');
    if (other.workspaceId !== workspaceId) throw badRequest('La carte bloquante doit appartenir au même espace');
    // Cycle : la carte bloquante ne doit pas déjà dépendre (directement ou non) de celle-ci
    const seen = new Set([blockerId]);
    let frontier = [blockerId];
    for (let depth = 0; frontier.length && depth < 100; depth++) {
      const rows = await prisma.taskDependency.findMany({ where: { blockedId: { in: frontier } }, select: { blockerId: true } });
      frontier = [];
      for (const r of rows) {
        if (r.blockerId === req.params.id) throw badRequest('Dépendance circulaire : cette carte bloque déjà, directement ou non, la carte choisie');
        if (!seen.has(r.blockerId)) { seen.add(r.blockerId); frontier.push(r.blockerId); }
      }
    }
    const exists = await prisma.taskDependency.findUnique({ where: { blockerId_blockedId: { blockerId, blockedId: req.params.id } } });
    if (!exists) {
      await prisma.taskDependency.create({ data: { blockerId, blockedId: req.params.id, createdById: req.user.id } });
      const b = await prisma.task.findUnique({ where: { id: blockerId }, select: { title: true, column: { select: { boardId: true } } } });
      await activity(req.params.id, req.user.id, 'dependency', { added: b.title });
      realtime.boardChanged(await boardOfTask(req.params.id), 'task', req);
      if (b.column.boardId !== await boardOfTask(req.params.id)) realtime.boardChanged(b.column.boardId, 'task', req);
    }
    return reply.code(exists ? 200 : 201).send({ ok: true });
  });

  app.delete('/tasks/:id/dependencies/:blockerId', {
    ...auth,
    schema: { params: { type: 'object', required: ['id', 'blockerId'], properties: { id: uuid, blockerId: uuid } } },
  }, async (req) => {
    await authz.check(req.user, 'task', req.params.id, 'EDITOR');
    const { count } = await prisma.taskDependency.deleteMany({ where: { blockerId: req.params.blockerId, blockedId: req.params.id } });
    if (count) {
      const b = await prisma.task.findUnique({ where: { id: req.params.blockerId }, select: { title: true } });
      await activity(req.params.id, req.user.id, 'dependency', { removed: b?.title ?? '?' });
      realtime.boardChanged(await boardOfTask(req.params.id), 'task', req);
    }
    return { ok: true };
  });

  // --- Champs personnalisés : valeur d'un champ sur une carte ---
  app.put('/tasks/:id/fields/:fieldId', {
    ...auth,
    schema: {
      params: { type: 'object', required: ['id', 'fieldId'], properties: { id: uuid, fieldId: uuid } },
      body: { type: 'object', required: ['value'], additionalProperties: false, properties: { value: {} } }, // type vérifié par checkFieldValue (pas de coercition Ajv : « 42 » reste un texte, true un booléen)
    },
  }, async (req) => {
    await authz.check(req.user, 'task', req.params.id, 'EDITOR');
    const boardId = await boardOfTask(req.params.id);
    const field = await prisma.boardField.findFirst({ where: { id: req.params.fieldId, boardId } });
    if (!field) throw badRequest('Champ inconnu sur ce tableau');
    const value = checkFieldValue(field, req.body.value);
    const key = { taskId_fieldId: { taskId: req.params.id, fieldId: field.id } };
    const before = await prisma.taskFieldValue.findUnique({ where: key });
    if (value === null || value === '') await prisma.taskFieldValue.deleteMany({ where: { taskId: req.params.id, fieldId: field.id } });
    else await prisma.taskFieldValue.upsert({ where: key, create: { taskId: req.params.id, fieldId: field.id, value }, update: { value } });
    const to = value === '' ? null : value;
    if ((before?.value ?? null) !== to) await activity(req.params.id, req.user.id, 'field', { name: field.name, from: before?.value ?? null, to });
    realtime.boardChanged(boardId, 'task', req);
    return { value: to };
  });

  // --- Journal d'activité ---
  app.get('/tasks/:id/activity', { ...auth, schema: { params: idParam } }, async (req) => {
    await authz.check(req.user, 'task', req.params.id, 'VIEWER');
    const activities = await prisma.taskActivity.findMany({
      where: { taskId: req.params.id }, orderBy: { createdAt: 'desc' }, take: 200,
      select: { id: true, type: true, data: true, createdAt: true, actor: { select: { id: true, displayName: true } } },
    });
    return { activities };
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
  const commentBody = { type: 'object', required: ['content'], additionalProperties: false, properties: { content: { type: 'string', minLength: 1, maxLength: 10000 } } };
  app.post('/tasks/:id/comments', { ...auth, schema: { params: idParam, body: commentBody } }, async (req, reply) => {
    await authz.check(req.user, 'task', req.params.id, 'EDITOR');
    const comment = await prisma.comment.create({ data: { content: req.body.content, taskId: req.params.id, authorId: req.user.id } });
    await activity(req.params.id, req.user.id, 'comment');
    realtime.boardChanged(await boardOfTask(req.params.id), 'comment', req);
    return reply.code(201).send({ comment });
  });

  // Seul l'auteur modifie son commentaire (y compris un propriétaire d'espace : on ne fait pas dire à quelqu'un ce qu'il n'a pas écrit)
  app.patch('/comments/:id', { ...auth, schema: { params: idParam, body: commentBody } }, async (req) => {
    await authz.check(req.user, 'comment', req.params.id, 'EDITOR');
    const current = await prisma.comment.findUnique({ where: { id: req.params.id } });
    if (current.authorId !== req.user.id) throw forbidden('Seul l\'auteur peut modifier ce commentaire');
    const comment = await prisma.comment.update({ where: { id: current.id }, data: { content: req.body.content, editedAt: new Date() } });
    realtime.boardChanged(await boardOfTask(comment.taskId), 'comment', req);
    return { comment };
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
