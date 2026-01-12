import fetch from 'node-fetch'; // Assurez-vous d'avoir node-fetch dans package.json

/**
 * Exécute les règles définies pour une colonne donnée.
 * @param {PrismaClient} prisma - Instance du client BDD.
 * @param {string} taskId - ID de la tâche déplacée.
 * @param {string} targetColumnId - ID de la colonne de destination.
 */
export async function runAutomations(prisma, taskId, targetColumnId) {
  // 1. Récupérer la tâche et les règles associées à la colonne cible
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  const rules = await prisma.rule.findMany({ where: { triggerId: targetColumnId } });

  if (!task || rules.length === 0) return;

  console.log(`🤖 Vérification des automatisations pour la tâche ${taskId}...`);

  for (const rule of rules) {
    try {
      // Action 1: Changer la couleur de la carte
      if (rule.action === 'CHANGE_COLOR') {
        await prisma.task.update({
          where: { id: taskId },
          data: { color: rule.value }
        });
        console.log(`   ✅ Couleur changée en ${rule.value}`);
      }

      // Action 2: Envoyer un Webhook (Slack, Discord, Zapier)
      if (rule.action === 'SEND_WEBHOOK') {
        const payload = {
          event: 'TASK_MOVED',
          task: {
            id: task.id,
            content: task.content,
            movedAt: new Date().toISOString()
          },
          targetColumn: targetColumnId
        };

        const response = await fetch(rule.value, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (!response.ok) throw new Error(`Status ${response.status}`);
        console.log(`   ✅ Webhook envoyé à ${rule.value}`);
      }
    } catch (err) {
      console.error(`   ❌ Erreur sur la règle ${rule.id}:`, err.message);
    }
  }
}