import { Parser } from 'json2csv';
import { badRequest } from '../lib/errors.js';

const uuid = { type: 'string', format: 'uuid' };
const idParam = { type: 'object', required: ['id'], properties: { id: uuid } };
const userSel = { select: { id: true, username: true, displayName: true } };
const assigneesSel = { orderBy: { assignedAt: 'asc' }, select: { user: userSel } };
const flat = (t) => {
  const { labels, ...rest } = t;
  return { ...rest, assignees: t.assignees.map((a) => a.user), ...(labels ? { labelIds: labels.map((l) => l.labelId) } : {}) };
};
/** Palette des étiquettes (classes définies côté client) */
export const LABEL_COLORS = ['gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'indigo', 'purple', 'pink'];
const PRIORITY_LABEL = { NONE: '', LOW: 'Basse', MEDIUM: 'Normale', HIGH: 'Haute', CRITICAL: 'Critique' };

export default async function boardRoutes(app) {
  const { prisma, authz, realtime } = app;
  const auth = { onRequest: [app.requireUser] };

  app.get('/boards/:id', { ...auth, schema: { params: idParam } }, async (req) => {
    const { role } = await authz.check(req.user, 'board', req.params.id, 'VIEWER');
    const board = await prisma.board.findUnique({
      where: { id: req.params.id },
      include: {
        workspace: { select: { id: true, name: true } },
        labels: { orderBy: { position: 'asc' } },
        columns: {
          orderBy: { position: 'asc' },
          include: {
            tasks: {
              where: { archivedAt: null },
              orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
              include: {
                assignees: assigneesSel,
                labels: { select: { labelId: true } },
                subtasks: { orderBy: { position: 'asc' } },
                _count: { select: { comments: true, attachments: true } },
              },
            },
          },
        },
      },
    });
    const columns = board.columns.map((c) => ({ ...c, tasks: c.tasks.map(flat) }));
    const archivedCount = await prisma.task.count({ where: { column: { boardId: board.id }, archivedAt: { not: null } } });
    return { board: { ...board, columns, archivedCount, myRole: role } };
  });

  app.patch('/boards/:id', {
    ...auth,
    schema: { params: idParam, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { title: { type: 'string', minLength: 1, maxLength: 120 }, archived: { type: 'boolean' } } } },
  }, async (req) => {
    await authz.check(req.user, 'board', req.params.id, 'EDITOR');
    const board = await prisma.board.update({ where: { id: req.params.id }, data: req.body });
    realtime.boardChanged(board.id, 'board', req);
    return { board };
  });

  app.delete('/boards/:id', { ...auth, schema: { params: idParam } }, async (req) => {
    await authz.check(req.user, 'board', req.params.id, 'OWNER');
    const files = await app.storedFilesOf({ boardId: req.params.id });
    await prisma.board.delete({ where: { id: req.params.id } });
    await app.removeStoredFiles(files);
    await app.audit(req, 'board.delete', { target: req.params.id });
    return { ok: true };
  });

  // --- Colonnes ---
  const colBody = { title: { type: 'string', minLength: 1, maxLength: 80 }, position: { type: 'number' }, wipLimit: { type: ['integer', 'null'], minimum: 1 } };

  app.post('/boards/:id/columns', {
    ...auth,
    schema: { params: idParam, body: { type: 'object', required: ['title'], additionalProperties: false, properties: colBody } },
  }, async (req, reply) => {
    await authz.check(req.user, 'board', req.params.id, 'EDITOR');
    const last = await prisma.column.findFirst({ where: { boardId: req.params.id }, orderBy: { position: 'desc' } });
    const column = await prisma.column.create({
      data: { ...req.body, position: req.body.position ?? (last?.position ?? 0) + 1000, boardId: req.params.id },
    });
    realtime.boardChanged(req.params.id, 'column', req);
    return reply.code(201).send({ column });
  });

  app.patch('/columns/:id', {
    ...auth,
    schema: { params: idParam, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: colBody } },
  }, async (req) => {
    await authz.check(req.user, 'column', req.params.id, 'EDITOR');
    const column = await prisma.column.update({ where: { id: req.params.id }, data: req.body });
    realtime.boardChanged(column.boardId, 'column', req);
    return { column };
  });

  app.delete('/columns/:id', { ...auth, schema: { params: idParam } }, async (req) => {
    await authz.check(req.user, 'column', req.params.id, 'EDITOR');
    const files = await app.storedFilesOf({ columnId: req.params.id });
    const column = await prisma.column.delete({ where: { id: req.params.id } });
    await app.removeStoredFiles(files);
    realtime.boardChanged(column.boardId, 'column', req);
    return { ok: true };
  });

  // --- Étiquettes du tableau ---
  const labelBody = { name: { type: 'string', minLength: 1, maxLength: 40 }, color: { enum: LABEL_COLORS }, position: { type: 'number' } };
  app.post('/boards/:id/labels', {
    ...auth,
    schema: { params: idParam, body: { type: 'object', required: ['name', 'color'], additionalProperties: false, properties: labelBody } },
  }, async (req, reply) => {
    await authz.check(req.user, 'board', req.params.id, 'EDITOR');
    if (await prisma.label.count({ where: { boardId: req.params.id } }) >= 50) throw badRequest('50 étiquettes au plus par tableau');
    const last = await prisma.label.findFirst({ where: { boardId: req.params.id }, orderBy: { position: 'desc' } });
    const label = await prisma.label.create({ data: { ...req.body, name: req.body.name.trim(), position: req.body.position ?? (last?.position ?? 0) + 1000, boardId: req.params.id } });
    realtime.boardChanged(req.params.id, 'label', req);
    return reply.code(201).send({ label });
  });

  app.patch('/labels/:id', {
    ...auth,
    schema: { params: idParam, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: labelBody } },
  }, async (req) => {
    await authz.check(req.user, 'label', req.params.id, 'EDITOR');
    const label = await prisma.label.update({ where: { id: req.params.id }, data: { ...req.body, ...(req.body.name ? { name: req.body.name.trim() } : {}) } });
    realtime.boardChanged(label.boardId, 'label', req);
    return { label };
  });

  app.delete('/labels/:id', { ...auth, schema: { params: idParam } }, async (req) => {
    await authz.check(req.user, 'label', req.params.id, 'EDITOR');
    const label = await prisma.label.delete({ where: { id: req.params.id } });
    realtime.boardChanged(label.boardId, 'label', req);
    return { ok: true };
  });

  // --- Statistiques ---
  app.get('/boards/:id/stats', {
    ...auth,
    schema: { params: idParam, querystring: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 365, default: 30 } } } },
  }, async (req) => {
    await authz.check(req.user, 'board', req.params.id, 'VIEWER');
    const since = new Date(Date.now() - req.query.days * 86400_000);
    const columns = await prisma.column.findMany({
      where: { boardId: req.params.id }, orderBy: { position: 'asc' },
      select: { id: true, title: true, _count: { select: { tasks: { where: { archivedAt: null } } } } },
    });
    const ids = columns.map((c) => c.id);
    const events = await prisma.taskEvent.findMany({ where: { toColumnId: { in: ids }, timestamp: { gte: since } }, select: { toColumnId: true, timestamp: true } });
    const overdue = await prisma.task.count({ where: { columnId: { in: ids.slice(0, -1) }, archivedAt: null, dueDate: { lt: new Date() } } });
    const perDay = {};
    const doneId = ids.at(-1);
    for (const e of events) if (e.toColumnId === doneId) {
      const d = e.timestamp.toISOString().slice(0, 10);
      perDay[d] = (perDay[d] ?? 0) + 1;
    }
    return {
      columns: columns.map((c) => ({ id: c.id, title: c.title, count: c._count.tasks })),
      moves: events.length,
      overdue,
      completedPerDay: Object.entries(perDay).sort().map(([date, count]) => ({ date, count })),
    };
  });

  app.get('/boards/:id/export.csv', { ...auth, schema: { params: idParam } }, async (req, reply) => {
    await authz.check(req.user, 'board', req.params.id, 'VIEWER');
    const tasks = await prisma.task.findMany({
      where: { column: { boardId: req.params.id }, archivedAt: null },
      include: { column: { select: { title: true } }, assignees: assigneesSel, labels: { select: { label: { select: { name: true } } } } },
      orderBy: [{ column: { position: 'asc' } }, { position: 'asc' }],
    });
    // Neutralisation de l'injection de formules (=, +, -, @) à l'ouverture dans un tableur
    const safe = (v) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
    const rows = tasks.map((t) => ({
      Colonne: safe(t.column.title), Titre: safe(t.title), Assignes: safe(t.assignees.map((a) => a.user.displayName).join(', ')),
      Priorite: PRIORITY_LABEL[t.priority], Etiquettes: safe(t.labels.map((l) => l.label.name).join(', ')),
      Debut: t.startDate?.toISOString().slice(0, 10) ?? '',
      Echeance: t.dueDate?.toISOString().slice(0, 10) ?? '', Creation: t.createdAt.toISOString(), MiseAJour: t.updatedAt.toISOString(),
    }));
    const csv = new Parser({ fields: ['Colonne', 'Titre', 'Assignes', 'Priorite', 'Etiquettes', 'Debut', 'Echeance', 'Creation', 'MiseAJour'], delimiter: ';' }).parse(rows);
    return reply.header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="kanzen-export.csv"')
      .send(`\uFEFF${csv}`);
  });

  // --- Agenda : tâches avec échéance dans les espaces de l'utilisateur ---
  app.get('/calendar', {
    ...auth,
    schema: { querystring: { type: 'object', required: ['from', 'to'], properties: { from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' }, mine: { type: 'boolean' } } } },
  }, async (req) => {
    const wsFilter = req.user.role === 'ADMIN' ? {} : { workspace: { members: { some: { userId: req.user.id } } } };
    const tasks = await prisma.task.findMany({
      where: {
        dueDate: { gte: new Date(req.query.from), lte: new Date(`${req.query.to}T23:59:59.999Z`) },
        archivedAt: null,
        column: { board: { archived: false, ...wsFilter } },
        ...(req.query.mine ? { assignees: { some: { userId: req.user.id } } } : {}),
      },
      select: { id: true, title: true, color: true, dueDate: true, assignees: assigneesSel, column: { select: { title: true, board: { select: { id: true, title: true } } } } },
      orderBy: { dueDate: 'asc' },
      take: 1000,
    });
    return { tasks: tasks.map(flat) };
  });
}
