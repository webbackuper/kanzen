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

const shutdown = async (signal) => {
  app.log.info(`${signal} reçu, arrêt propre`);
  clearInterval(purge);
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

try {
  await app.listen({ host: cfg.host, port: cfg.port });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
