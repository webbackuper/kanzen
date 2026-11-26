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
        fields: { orderBy: { position: 'asc' } },
        columns: {
          orderBy: { position: 'asc' },
          include: {
            tasks: {
              where: { archivedAt: null },
              orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
              include: {
                assignees: assigneesSel,
                labels: { select: { labelId: true } },
                fieldValues: { select: { fieldId: true, value: true } },
                blockedBy: { select: { blocker: { select: { id: true, archivedAt: true, columnId: true, column: { select: { boardId: true } } } } } },
                _count: { select: { comments: true, attachments: true, blocks: true } },
                subtasks: { orderBy: { position: 'asc' } },
              },
            },
          },
        },
      },
    });
    // Carte bloquée : au moins une carte bloquante ni archivée ni dans la dernière colonne de son tableau
    const blockerBoards = [...new Set(board.columns.flatMap((c) => c.tasks.flatMap((t) => t.blockedBy.map((d) => d.blocker.column.boardId))))];
    const lastCols = new Map();
    if (blockerBoards.length) {
      const cols = await prisma.column.findMany({ where: { boardId: { in: blockerBoards } }, orderBy: { position: 'desc' }, select: { id: true, boardId: true } });
      for (const c of cols) if (!lastCols.has(c.boardId)) lastCols.set(c.boardId, c.id);
    }
    const done = new Set(lastCols.values());
    const columns = board.columns.map((c) => ({
      ...c,
      tasks: c.tasks.map((t) => {
        const { blockedBy, fieldValues, ...rest } = flat(t);
        return {
          ...rest,
          fieldValues: Object.fromEntries(fieldValues.map((v) => [v.fieldId, v.value])),
          blockedByIds: blockedBy.map((d) => d.blocker.id),
          blocked: blockedBy.some((d) => !d.blocker.archivedAt && !done.has(d.blocker.columnId)),
        };
      }),
    }));
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

  // --- Champs personnalisés du tableau ---
  const FIELD_TYPES = ['TEXT', 'NUMBER', 'DATE', 'SELECT', 'CHECKBOX'];
  const fieldBody = {
    name: { type: 'string', minLength: 1, maxLength: 40 },
    options: { type: 'array', maxItems: 30, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 40 } },
    position: { type: 'number' },
  };
  app.post('/boards/:id/fields', {
    ...auth,
    schema: { params: idParam, body: { type: 'object', required: ['name', 'type'], additionalProperties: false, properties: { ...fieldBody, type: { enum: FIELD_TYPES } } } },
  }, async (req, reply) => {
    await authz.check(req.user, 'board', req.params.id, 'EDITOR');
    if (await prisma.boardField.count({ where: { boardId: req.params.id } }) >= 20) throw badRequest('20 champs au plus par tableau');
    if (req.body.type === 'SELECT' && !req.body.options?.length) throw badRequest('Une liste de choix demande au moins une option');
    const last = await prisma.boardField.findFirst({ where: { boardId: req.params.id }, orderBy: { position: 'desc' } });
    const field = await prisma.boardField.create({
      data: {
        boardId: req.params.id, name: req.body.name.trim(), type: req.body.type,
        options: req.body.type === 'SELECT' ? req.body.options.map((o) => o.trim()) : [],
        position: req.body.position ?? (last?.position ?? 0) + 1000,
      },
    });
    realtime.boardChanged(req.params.id, 'field', req);
    return reply.code(201).send({ field });
  });

  // Renommer, réordonner, modifier les options (une option retirée efface les valeurs qui l'utilisaient)
  app.patch('/fields/:id', {
    ...auth,
    schema: { params: idParam, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: fieldBody } },
  }, async (req) => {
    await authz.check(req.user, 'boardField', req.params.id, 'EDITOR');
    const current = await prisma.boardField.findUnique({ where: { id: req.params.id } });
    const data = { ...req.body, ...(req.body.name ? { name: req.body.name.trim() } : {}) };
    if (req.body.options) {
      if (current.type !== 'SELECT') throw badRequest('Seule une liste de choix a des options');
      if (!req.body.options.length) throw badRequest('Une liste de choix demande au moins une option');
      data.options = req.body.options.map((o) => o.trim());
      const removed = current.options.filter((o) => !data.options.includes(o));
      for (const o of removed) await prisma.taskFieldValue.deleteMany({ where: { fieldId: current.id, value: { equals: o } } });
    }
    const field = await prisma.boardField.update({ where: { id: current.id }, data });
    realtime.boardChanged(field.boardId, 'field', req);
    return { field };
  });

  app.delete('/fields/:id', { ...auth, schema: { params: idParam } }, async (req) => {
    await authz.check(req.user, 'boardField', req.params.id, 'EDITOR');
    const field = await prisma.boardField.delete({ where: { id: req.params.id } });
    realtime.boardChanged(field.boardId, 'field', req);
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
      include: { column: { select: { title: true } }, assignees: assigneesSel, labels: { select: { label: { select: { name: true } } } }, fieldValues: true },
      orderBy: [{ column: { position: 'asc' } }, { position: 'asc' }],
    });
    const fields = await prisma.boardField.findMany({ where: { boardId: req.params.id }, orderBy: { position: 'asc' } });
    // Neutralisation de l'injection de formules (=, +, -, @) à l'ouverture dans un tableur
    const safe = (v) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
    const rows = tasks.map((t) => ({
      Colonne: safe(t.column.title), Titre: safe(t.title), Assignes: safe(t.assignees.map((a) => a.user.displayName).join(', ')),
      Priorite: PRIORITY_LABEL[t.priority], Etiquettes: safe(t.labels.map((l) => l.label.name).join(', ')),
      Debut: t.startDate?.toISOString().slice(0, 10) ?? '',
      Echeance: t.dueDate?.toISOString().slice(0, 10) ?? '', Estimation: t.estimate ?? '',
      Creation: t.createdAt.toISOString(), MiseAJour: t.updatedAt.toISOString(),
      ...Object.fromEntries(fields.map((f) => {
        const v = t.fieldValues.find((x) => x.fieldId === f.id)?.value;
        return [`f_${f.id}`, v === undefined || v === null ? '' : f.type === 'CHECKBOX' ? (v ? 'oui' : 'non') : safe(String(v))];
      })),
    }));
    const columns = ['Colonne', 'Titre', 'Assignes', 'Priorite', 'Etiquettes', 'Debut', 'Echeance', 'Estimation', 'Creation', 'MiseAJour'];
    const csv = new Parser({ fields: [...columns, ...fields.map((f) => ({ label: safe(f.name), value: `f_${f.id}` }))], delimiter: ';' }).parse(rows);
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
