import { loadConfig } from './config.js';
import { createPrisma } from './db.js';
import { buildApp } from './app.js';
import { syncDirectory } from './lib/adsync.js';

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

// Synchronisation AD périodique : départs (désactivation, révocation des sessions), retours, noms et rôles
let adsync = null;
if (cfg.auth.ldapEnabled && app.ldap && cfg.ldap.syncMinutes > 0) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { await syncDirectory({ prisma, ldap: app.ldap, audit: app.audit, log: app.log, onRevoke: app.realtime.disconnectUser }); } catch (err) { app.log.error({ err }, 'synchronisation AD'); } finally { running = false; }
  };
  setTimeout(run, 30_000).unref(); // premier passage peu après le démarrage
  adsync = setInterval(run, cfg.ldap.syncMinutes * 60_000);
  adsync.unref();
}

let stopping = false;
const shutdown = async (signal) => {
  if (stopping) return;
  stopping = true;
  app.log.info(`${signal} reçu, arrêt propre`);
  // Filet de sécurité : sortie forcée si une requête reste bloquée
  setTimeout(() => { app.log.warn('arrêt forcé après 10 s'); process.exit(1); }, 10_000).unref();
  clearInterval(purge);
  if (adsync) clearInterval(adsync);
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
