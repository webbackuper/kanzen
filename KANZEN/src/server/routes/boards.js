import { Parser } from 'json2csv';

const uuid = { type: 'string', format: 'uuid' };
const idParam = { type: 'object', required: ['id'], properties: { id: uuid } };
const userSel = { select: { id: true, username: true, displayName: true } };
const assigneesSel = { orderBy: { assignedAt: 'asc' }, select: { user: userSel } };
const flat = (t) => ({ ...t, assignees: t.assignees.map((a) => a.user) });

export default async function boardRoutes(app) {
  const { prisma, authz, realtime } = app;
  const auth = { onRequest: [app.requireUser] };

  app.get('/boards/:id', { ...auth, schema: { params: idParam } }, async (req) => {
    const { role } = await authz.check(req.user, 'board', req.params.id, 'VIEWER');
    const board = await prisma.board.findUnique({
      where: { id: req.params.id },
      include: {
        workspace: { select: { id: true, name: true } },
        columns: {
          orderBy: { position: 'asc' },
          include: {
            tasks: {
              orderBy: { position: 'asc' },
              include: {
                assignees: assigneesSel,
                subtasks: { orderBy: { position: 'asc' } },
                _count: { select: { comments: true, attachments: true } },
              },
            },
          },
        },
      },
    });
    const columns = board.columns.map((c) => ({ ...c, tasks: c.tasks.map(flat) }));
    return { board: { ...board, columns, myRole: role } };
  });

  app.patch('/boards/:id', {
    ...auth,
    schema: { params: idParam, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { title: { type: 'string', minLength: 1, maxLength: 120 }, archived: { type: 'boolean' } } } },
  }, async (req) => {
    await authz.check(req.user, 'board', req.params.id, 'EDITOR');
    const board = await prisma.board.update({ where: { id: req.params.id }, data: req.body });
    realtime.boardChanged(board.id, 'board');
    return { board };
  });

  app.delete('/boards/:id', { ...auth, schema: { params: idParam } }, async (req) => {
    await authz.check(req.user, 'board', req.params.id, 'OWNER');
    await prisma.board.delete({ where: { id: req.params.id } });
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
    realtime.boardChanged(req.params.id, 'column');
    return reply.code(201).send({ column });
  });

  app.patch('/columns/:id', {
    ...auth,
    schema: { params: idParam, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: colBody } },
  }, async (req) => {
    await authz.check(req.user, 'column', req.params.id, 'EDITOR');
    const column = await prisma.column.update({ where: { id: req.params.id }, data: req.body });
    realtime.boardChanged(column.boardId, 'column');
    return { column };
  });

  app.delete('/columns/:id', { ...auth, schema: { params: idParam } }, async (req) => {
    await authz.check(req.user, 'column', req.params.id, 'EDITOR');
    const column = await prisma.column.delete({ where: { id: req.params.id } });
    realtime.boardChanged(column.boardId, 'column');
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
      select: { id: true, title: true, _count: { select: { tasks: true } } },
    });
    const ids = columns.map((c) => c.id);
    const events = await prisma.taskEvent.findMany({ where: { toColumnId: { in: ids }, timestamp: { gte: since } }, select: { toColumnId: true, timestamp: true } });
    const overdue = await prisma.task.count({ where: { columnId: { in: ids.slice(0, -1) }, dueDate: { lt: new Date() } } });
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
      where: { column: { boardId: req.params.id } },
      include: { column: { select: { title: true } }, assignees: assigneesSel },
      orderBy: [{ column: { position: 'asc' } }, { position: 'asc' }],
    });
    // Neutralisation de l'injection de formules (=, +, -, @) à l'ouverture dans un tableur
    const safe = (v) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
    const rows = tasks.map((t) => ({
      Colonne: safe(t.column.title), Titre: safe(t.title), Assignes: safe(t.assignees.map((a) => a.user.displayName).join(', ')),
      Echeance: t.dueDate?.toISOString().slice(0, 10) ?? '', Creation: t.createdAt.toISOString(), MiseAJour: t.updatedAt.toISOString(),
    }));
    const csv = new Parser({ fields: ['Colonne', 'Titre', 'Assignes', 'Echeance', 'Creation', 'MiseAJour'], delimiter: ';' }).parse(rows);
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
