#!/usr/bin/env node
// Synchronisation AD immédiate (départs, retours, noms, rôles). Usage : kanzenctl ad-sync [--force]
// Le service la lance aussi tout seul toutes les AD_SYNC_INTERVAL_MINUTES minutes.
import { loadConfig } from '../src/server/config.js';
import { createPrisma } from '../src/server/db.js';
import { createLdapAuthenticator } from '../src/server/lib/ldap.js';
import { createAudit } from '../src/server/lib/audit.js';
import { syncDirectory } from '../src/server/lib/adsync.js';

const cfg = loadConfig();
if (!cfg.auth.ldapEnabled) { console.error('AD désactivé (AUTH_LDAP_ENABLED=false) : rien à synchroniser'); process.exit(1); }
const log = { info: () => {}, warn: (o, m) => console.warn(m ?? o), error: (o, m) => console.error(m ?? o) };
const prisma = createPrisma(cfg.databaseUrl);
try {
  const r = await syncDirectory({
    prisma, ldap: createLdapAuthenticator(cfg.ldap, log), audit: createAudit(prisma, log), log, force: process.argv.includes('--force'),
  });
  if (r.aborted) { console.error(`Interrompu : ${r.aborted}`); process.exitCode = 2; } else {
    console.log(`Comptes AD vérifiés : ${r.checked}`);
    console.log(`Désactivés (départ du groupe ou de l'AD) : ${r.disabled.length ? r.disabled.join(', ') : 'aucun'}`);
    console.log(`Réactivés (retour dans le groupe) : ${r.reenabled.length ? r.reenabled.join(', ') : 'aucun'}`);
    console.log(`Profils mis à jour : ${r.updated}`);
  }
} finally { await prisma.$disconnect(); }
