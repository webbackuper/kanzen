// Jeu de données de DÉVELOPPEMENT uniquement : purge toutes les tables.
import { createPrisma } from '../src/server/db.js';
import { hashPassword } from '../src/server/lib/passwords.js';

if (process.env.NODE_ENV === 'production' && process.env.KANZEN_ALLOW_SEED !== 'yes') {
  console.error('Seed refusé en production (il efface toutes les données). Définir KANZEN_ALLOW_SEED=yes pour forcer.');
  process.exit(1);
}

const prisma = createPrisma(process.env.DATABASE_URL);
await prisma.$executeRawUnsafe('TRUNCATE "AuditLog", "Session", "Workspace", "User" RESTART IDENTITY CASCADE');

const pwd = await hashPassword('KanZen-Dev-2026!');
const admin = await prisma.user.create({ data: { username: 'admin', displayName: 'Admin (dev)', role: 'ADMIN', authSource: 'LOCAL', passwordHash: pwd } });
const alice = await prisma.user.create({ data: { username: 'alice', displayName: 'Alice Martin', authSource: 'LOCAL', passwordHash: pwd } });
const bob = await prisma.user.create({ data: { username: 'bob', displayName: 'Bob Durand', authSource: 'LOCAL', passwordHash: pwd } });

const ws = await prisma.workspace.create({
  data: {
    name: 'Équipe Infra', slug: 'equipe-infra',
    members: { create: [{ userId: admin.id, role: 'OWNER' }, { userId: alice.id, role: 'EDITOR' }, { userId: bob.id, role: 'VIEWER' }] },
  },
});
const board = await prisma.board.create({ data: { title: 'Migration datacenter', workspaceId: ws.id } });
const cols = [];
for (const [i, title] of ['À faire', 'En cours', 'En revue', 'Terminé'].entries()) {
  cols.push(await prisma.column.create({ data: { title, position: (i + 1) * 1000, boardId: board.id } }));
}
const tasks = [
  ['Inventaire des VM', 0, 'blue'], ['Plan d\'adressage IP', 0, 'white'], ['Renouveler certificats PKI', 1, 'red'],
  ['Configurer les sauvegardes', 2, 'yellow'], ['Durcissement CIS des hôtes', 3, 'green'],
];
for (const [j, [title, c, color]] of tasks.entries()) {
  const t = await prisma.task.create({
    data: { title, color, columnId: cols[c].id, position: (j + 1) * 1000, createdById: admin.id, dueDate: new Date(Date.now() + (j + 2) * 86400_000),
      assignees: { create: j % 2 ? [{ userId: alice.id }, ...(j === 3 ? [{ userId: admin.id }] : [])] : [] } },
  });
  await prisma.taskEvent.create({ data: { taskId: t.id, toColumnId: t.columnId, actorId: admin.id } });
}
console.log('Seed de développement OK. Comptes admin / alice / bob, mot de passe : KanZen-Dev-2026!');
await prisma.$disconnect();
