import { loadConfig } from './config.js';
import { createPrisma } from './db.js';
import { buildApp } from './app.js';

let cfg;
try {
  cfg = loadConfig();
} catch (err) {
  console.error(err.message);
  process.exit(78); // EX_CONFIG : systemd n'insiste pas en boucle
}

const prisma = createPrisma(cfg.databaseUrl);
const app = await buildApp({ cfg, prisma });

// Purge horaire des sessions expirées
const purge = setInterval(() => app.sessions.purgeExpired().catch((err) => app.log.warn({ err }, 'purge sessions')), 3600_000);
purge.unref();

let stopping = false;
const shutdown = async (signal) => {
  if (stopping) return;
  stopping = true;
  app.log.info(`${signal} reçu, arrêt propre`);
  // Filet de sécurité : sortie forcée si une requête reste bloquée
  setTimeout(() => { app.log.warn('arrêt forcé après 10 s'); process.exit(1); }, 10_000).unref();
  clearInterval(purge);
  try {
    await app.close();
    await prisma.$disconnect();
  } finally {
    process.exit(0);
  }
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

try {
  await app.listen({ host: cfg.host, port: cfg.port });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
