export default async function adminRoutes(app) {
  const { prisma } = app;

  app.get('/admin/audit', {
    onRequest: [app.requireAdmin],
    schema: {
      querystring: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 }, before: { type: 'integer', minimum: 1 }, action: { type: 'string', maxLength: 64 } },
      },
    },
  }, async (req) => {
    const { limit, before, action } = req.query;
    const rows = await prisma.auditLog.findMany({
      where: { ...(before ? { id: { lt: BigInt(before) } } : {}), ...(action ? { action: { startsWith: action } } : {}) },
      orderBy: { id: 'desc' },
      take: limit,
    });
    return { entries: rows.map((r) => ({ ...r, id: Number(r.id) })) };
  });

  app.get('/admin/overview', { onRequest: [app.requireAdmin] }, async () => {
    const [users, activeSessions, workspaces, boards, tasks] = await Promise.all([
      prisma.user.groupBy({ by: ['authSource'], _count: true }),
      prisma.session.count({ where: { expiresAt: { gt: new Date() } } }),
      prisma.workspace.count(),
      prisma.board.count(),
      prisma.task.count(),
    ]);
    return { users: Object.fromEntries(users.map((u) => [u.authSource, u._count])), activeSessions, workspaces, boards, tasks };
  });
}
