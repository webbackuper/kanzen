// Jeu de données de DÉVELOPPEMENT uniquement : purge toutes les tables.
import { createPrisma } from '../src/server/db.js';
import { hashPassword } from '../src/server/lib/passwords.js';
import { docText } from '../src/server/lib/wikidoc.js';

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
// Wiki de démonstration
const t = (text, marks) => ({ type: 'text', text, ...(marks ? { marks } : {}) });
const para = (...c) => ({ type: 'paragraph', content: c });
const h = (level, text) => ({ type: 'heading', attrs: { level }, content: [t(text)] });
const li = (...c) => ({ type: 'listItem', content: [para(...c)] });
const wikiPage = async (title, content, parentId = null, position = 1000) => {
  const doc = { type: 'doc', content };
  const page = await prisma.wikiPage.create({ data: { workspaceId: ws.id, parentId, title, content: doc, text: docText(doc), position, createdById: admin.id, updatedById: admin.id } });
  await prisma.wikiRevision.create({ data: { pageId: page.id, version: 1, title, content: doc, authorId: admin.id } });
  return page;
};
const home = await wikiPage('Accueil de l\'équipe Infra', [
  para(t('Bienvenue dans le wiki de l\'équipe. Chaque page peut avoir des sous-pages : utilisez le '), t('+', [{ type: 'bold' }]), t(' dans l\'arborescence.')),
  h(2, 'Contacts'),
  { type: 'bulletList', content: [li(t('Astreinte : poste 4242')), li(t('Supervision : '), t('https://supervision.corp.local', [{ type: 'link', attrs: { href: 'https://supervision.corp.local' } }]))] },
]);
await wikiPage('Procédure de sauvegarde', [
  para(t('Les sauvegardes PostgreSQL et les pièces jointes sont réalisées chaque nuit à 02h30 par '), t('kanzen-backup.timer', [{ type: 'code' }]), t('.')),
  h(2, 'Restauration'),
  { type: 'orderedList', content: [li(t('Arrêter le service : '), t('systemctl stop kanzen', [{ type: 'code' }])), li(t('Restaurer : '), t('kanzenctl restore <archive>', [{ type: 'code' }])), li(t('Redémarrer et contrôler '), t('/api/health', [{ type: 'code' }]))] },
  { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [para(t('Test de restauration trimestriel'))] }, { type: 'taskItem', attrs: { checked: false }, content: [para(t('Copie hors site'))] }] },
], home.id, 1000);
await wikiPage('Architecture réseau', [
  para(t('Plan d\'adressage et flux autorisés.')),
  { type: 'table', content: [
    { type: 'tableRow', content: ['Zone', 'Réseau', 'Passerelle'].map((x) => ({ type: 'tableHeader', content: [para(t(x))] })) },
    { type: 'tableRow', content: ['Serveurs', '10.10.0.0/24', '10.10.0.1'].map((x) => ({ type: 'tableCell', content: [para(t(x))] })) },
    { type: 'tableRow', content: ['Administration', '10.99.0.0/24', '10.99.0.1'].map((x) => ({ type: 'tableCell', content: [para(t(x))] })) },
  ] },
], home.id, 2000);

console.log('Seed de développement OK. Comptes admin / alice / bob, mot de passe : KanZen-Dev-2026!');
await prisma.$disconnect();
