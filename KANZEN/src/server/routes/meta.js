// Informations d'instance (version, fonctions activées) et boucle de retour utilisateur intégrée.
import fs from 'node:fs';
import { badRequest } from '../lib/errors.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version;

export default async function metaRoutes(app) {
  const { prisma, cfg, realtime, audit } = app;
  const auth = { onRequest: [app.requireUser] };

  const feedbackColumn = async () => {
    if (!cfg.feedbackBoardId) return null;
    return prisma.column.findFirst({ where: { boardId: cfg.feedbackBoardId, board: { archived: false } }, orderBy: { position: 'asc' }, select: { id: true, boardId: true } });
  };

  app.get('/meta', auth, async () => ({ version: VERSION, feedback: !!(await feedbackColumn()) }));

  // « Suggérer / signaler » : crée une carte dans le tableau des retours (FEEDBACK_BOARD_ID), même si l'auteur
  // n'en est pas membre. Contenu limité au texte saisi et au contexte (page, version) : aucune capture automatique.
  app.post('/feedback', {
    ...auth,
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    schema: {
      body: {
        type: 'object', required: ['message'], additionalProperties: false,
        properties: { message: { type: 'string', minLength: 3, maxLength: 4000 }, kind: { enum: ['idea', 'bug'] }, path: { type: 'string', maxLength: 300 } },
      },
    },
  }, async (req, reply) => {
    const col = await feedbackColumn();
    if (!col) throw badRequest('Aucun tableau de retours configuré (FEEDBACK_BOARD_ID)');
    const { message, kind = 'idea', path = '' } = req.body;
    const firstLine = message.trim().split('\n')[0].slice(0, 100);
    const last = await prisma.task.findFirst({ where: { columnId: col.id }, orderBy: { position: 'desc' }, select: { position: true } });
    const task = await prisma.task.create({
      data: {
        title: `${kind === 'bug' ? 'Anomalie' : 'Suggestion'} : ${firstLine}`,
        description: `${message.trim()}\n\n---\nAuteur : ${req.user.displayName} (${req.user.username})\nPage : ${path || '—'}\nVersion : ${VERSION}`,
        color: kind === 'bug' ? 'red' : 'blue',
        columnId: col.id,
        position: (last?.position ?? 0) + 1000,
        createdById: req.user.id,
      },
    });
    await prisma.taskEvent.create({ data: { taskId: task.id, toColumnId: col.id, actorId: req.user.id } });
    await audit(req, 'feedback.create', { target: task.id, details: { kind } });
    realtime.boardChanged(col.boardId, 'task', req);
    return reply.code(201).send({ ok: true });
  });
}
