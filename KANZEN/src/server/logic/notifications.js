// Simule l'envoi réel (pourrait utiliser nodemailer ou axios)
async function sendSlack(webhookUrl, message) {
  console.log(`[SLACK] Envoi vers ${webhookUrl}: ${message}`);
  // await fetch(webhookUrl, { method: 'POST', body: JSON.stringify({ text: message }) });
}

async function sendEmail(email, subject, body) {
  console.log(`[EMAIL] Envoi vers ${email} | Sujet: ${subject}`);
}

export async function notifyValidators(prisma, task) {
  if (!task.validatorGroupId) return;

  // 1. Récupérer le groupe de validateurs
  const group = await prisma.group.findUnique({ where: { id: task.validatorGroupId } });
  if (!group) return;

  const memberIds = JSON.parse(group.memberIds); // Parsing du JSON array

  // 2. Récupérer les préférences des membres
  const validators = await prisma.user.findMany({
    where: { id: { in: memberIds } }
  });

  // 3. Dispatcher selon les préférences
  const message = `Validation requise pour la tâche : "${task.content}"`;

  for (const user of validators) {
    if (user.notifySlack && user.slackWebhook) {
      await sendSlack(user.slackWebhook, message);
    } else if (user.notifyEmail) {
      await sendEmail(user.email, "Action requise : Validation", message);
    }
  }
}