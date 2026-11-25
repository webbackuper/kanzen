#!/usr/bin/env node
// Diagnostic d'installation : configuration, base, stockage, annuaire. Usage : kanzenctl check [identifiant AD]
import fs from 'node:fs';
import { loadConfig } from '../src/server/config.js';
import { createPrisma } from '../src/server/db.js';
import { createLdapAuthenticator } from '../src/server/lib/ldap.js';

let failed = 0;
const ok = (m) => console.log(`  [OK]   ${m}`);
const ko = (m) => { failed++; console.log(`  [KO]   ${m}`); };
const info = (m) => console.log(`  [info] ${m}`);

console.log('KanZen - diagnostic');
let cfg;
try { cfg = loadConfig(); ok(`configuration valide (sources : ${[cfg.auth.localEnabled && 'locale', cfg.auth.ldapEnabled && 'AD'].filter(Boolean).join(' + ')})`); } catch (err) { ko(err.message); process.exit(1); }

const prisma = createPrisma(cfg.databaseUrl);
try {
  const [{ version }] = await prisma.$queryRaw`SELECT version()`;
  ok(`PostgreSQL joignable : ${version.split(' ').slice(0, 2).join(' ')}`);
  const migs = await prisma.$queryRaw`SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`;
  ok(`${migs[0].n} migration(s) appliquée(s)`);
  const admins = await prisma.user.count({ where: { role: 'ADMIN', disabled: false } });
  if (admins) ok(`${admins} administrateur(s) actif(s)`); else info('aucun administrateur : kanzenctl create-admin <id>');
} catch (err) { ko(`base de données : ${err.message.split('\n')[0]}`); }
await prisma.$disconnect().catch(() => {});

try { fs.accessSync(cfg.upload.dir, fs.constants.W_OK); ok(`stockage des pièces jointes inscriptible : ${cfg.upload.dir}`); } catch { ko(`stockage non inscriptible : ${cfg.upload.dir}`); }
if (cfg.staticDir && fs.existsSync(`${cfg.staticDir}/index.html`)) ok('interface web présente'); else ko(`interface absente : ${cfg.staticDir}`);
if (cfg.isProd && !cfg.publicUrl.startsWith('https://')) ko('PUBLIC_URL doit être en https:// en production');

if (cfg.auth.ldapEnabled) {
  if (cfg.ldap.caFile && !fs.existsSync(cfg.ldap.caFile)) ko(`LDAP_CA_FILE introuvable : ${cfg.ldap.caFile}`);
  try {
    const log = { warn: (o, m) => info(`${m} (${o.url})`), error: () => {} };
    const r = await createLdapAuthenticator(cfg.ldap, log).diagnose(process.argv[2]);
    ok(`bind du compte de service (${cfg.ldap.bindDn})`);
    for (const k of ['groupUsers', 'groupAdmins']) if (r[k]) (r[k] === 'trouvé' ? ok : ko)(`${k} : ${r[k]}`);
    if (process.argv[2]) {
      info(`utilisateur ${process.argv[2]} : ${r.user}`);
      if ('memberOfUsers' in r) (r.memberOfUsers || r.memberOfAdmins ? ok : ko)(`accès KanZen : ${r.memberOfAdmins ? 'ADMIN' : r.memberOfUsers ? 'USER' : 'hors des groupes'}`);
    }
  } catch (err) { ko(`LDAP : ${err.message} (vérifier DNS, port 636, certificat/CA, compte de service)`); }
}
console.log(failed ? `\n${failed} problème(s) détecté(s).` : '\nTout est conforme.');
process.exit(failed ? 1 : 0);
