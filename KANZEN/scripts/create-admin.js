#!/usr/bin/env node
// Création (ou réinitialisation) d'un compte administrateur LOCAL de secours.
// Usage : node scripts/create-admin.js <identifiant> ["Nom affiché"]
// Le mot de passe est lu sur l'entrée standard (jamais en argument : il apparaîtrait dans `ps` et l'historique).
import readline from 'node:readline';
import { createPrisma } from '../src/server/db.js';
import { hashPassword, checkPasswordPolicy } from '../src/server/lib/passwords.js';

const [username, displayName] = process.argv.slice(2);
if (!username || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(username)) {
  console.error('Usage : create-admin.js <identifiant en minuscules> ["Nom affiché"]');
  process.exit(64);
}
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL non définie'); process.exit(78); }

async function readPassword() {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8').split('\n')[0];
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const ask = (q) => new Promise((res) => {
    rl.stdoutMuted = true;
    rl.question(q, (a) => { rl.stdoutMuted = false; process.stdout.write('\n'); res(a); });
  });
  rl._writeToOutput = function (s) { if (!rl.stdoutMuted || s.includes(':')) rl.output.write(s); };
  const a = await ask('Mot de passe : ');
  const b = await ask('Confirmation : ');
  rl.close();
  if (a !== b) { console.error('Les mots de passe ne correspondent pas'); process.exit(65); }
  return a;
}

const password = await readPassword();
const problems = checkPasswordPolicy(password, { username });
if (problems.length) { console.error(`Mot de passe refusé : ${problems.join(', ')}`); process.exit(65); }

const prisma = createPrisma(process.env.DATABASE_URL);
const existing = await prisma.user.findUnique({ where: { username } });
if (existing && existing.authSource !== 'LOCAL') { console.error(`${username} est un compte AD : choisissez un autre identifiant`); process.exit(65); }
const data = { passwordHash: await hashPassword(password), role: 'ADMIN', disabled: false, failedLogins: 0, lockedUntil: null, mustChangePassword: false };
const user = existing
  ? await prisma.user.update({ where: { id: existing.id }, data })
  : await prisma.user.create({ data: { ...data, username, displayName: displayName ?? username, authSource: 'LOCAL' } });
await prisma.auditLog.create({ data: { action: existing ? 'user.admin_reset_cli' : 'user.admin_create_cli', target: user.username, outcome: 'success', actorName: 'cli' } });
console.log(`Administrateur local « ${user.username} » ${existing ? 'réinitialisé' : 'créé'}.`);
await prisma.$disconnect();
