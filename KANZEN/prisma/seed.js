import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Démarrage du Seed Multi-Tenant...');

  // Nettoyage (Ordre important pour Foreign Keys)
  await prisma.attachment.deleteMany();
  await prisma.rule.deleteMany();
  await prisma.task.deleteMany();
  await prisma.column.deleteMany();
  await prisma.board.deleteMany();
  await prisma.group.deleteMany();
  await prisma.workspaceMember.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();

  // 1. Utilisateurs
  const password = await bcrypt.hash('password123', 10);
  
  const admin = await prisma.user.create({
    data: { 
      email: 'admin@KanZen.io', name: 'Admin System', password, role: 'ADMIN',
      notifySlack: true, slackWebhook: 'https://hooks.slack.com/services/XXX'
    }
  });

  const manager = await prisma.user.create({
    data: { email: 'manager@KanZen.io', name: 'Chef de Projet', password }
  });

  // 2. Workspace & Membres
  const workspace = await prisma.workspace.create({
    data: { name: 'KanZen Corp', slug: 'KanZen-corp' }
  });

  await prisma.workspaceMember.create({
    data: { userId: admin.id, workspaceId: workspace.id, role: 'ADMIN' }
  });

  await prisma.workspaceMember.create({
    data: { userId: manager.id, workspaceId: workspace.id, role: 'USER' }
  });

  // 3. Groupes (Validation)
  const validationGroup = await prisma.group.create({
    data: {
      name: 'Comité de Validation',
      workspaceId: workspace.id,
      memberIds: JSON.stringify([admin.id, manager.id]) // Admin et Manager valident
    }
  });

  // 4. Board & Tâches
  const board = await prisma.board.create({
    data: { title: 'Q1 Roadmap', workspaceId: workspace.id }
  });

  const colTodo = await prisma.column.create({ data: { title: 'To Do', order: 0, boardId: board.id } });
  const colReview = await prisma.column.create({ data: { title: 'Review', order: 1, boardId: board.id } });

  // Tâche nécessitant validation
  await prisma.task.create({
    data: {
      content: 'Valider le Budget 2026',
      columnId: colTodo.id,
      color: 'red',
      validatorGroupId: validationGroup.id // Lié au groupe créé plus haut
    }
  });

  console.log('✅ Base de données initialisée avec structure Multi-Workspaces.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });