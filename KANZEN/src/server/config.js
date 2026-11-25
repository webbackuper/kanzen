// Chargement et validation de la configuration (variables d'environnement).
// Toute variable secrète XXX peut être fournie via XXX_FILE (systemd credentials, secrets Docker).
import fs from 'node:fs';

function read(name, fallback) {
  const file = process.env[`${name}_FILE`];
  if (file) {
    try { return fs.readFileSync(file, 'utf8').trim(); } catch (err) {
      throw Object.assign(new Error(`${name}_FILE illisible (${file}) : ${err.code ?? err.message}`), { code: 'KZ_CONFIG' });
    }
  }
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}
const bool = (name, fallback) => {
  const v = read(name);
  if (v === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};
const int = (name, fallback) => {
  const v = read(name);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`${name} doit être un entier`);
  return n;
};
const list = (name, fallback = []) => {
  const v = read(name);
  return v === undefined ? fallback : v.split(',').map((s) => s.trim()).filter(Boolean);
};

export function loadConfig(overrides = {}) {
  const env = read('NODE_ENV', 'production');
  const ldapEnabled = bool('AUTH_LDAP_ENABLED', false);
  const isProd = env === 'production';
  const cfg = {
    env,
    isProd,
    host: read('HOST', '127.0.0.1'),
    port: int('PORT', 3000),
    publicUrl: read('PUBLIC_URL'), // ex. https://kanzen.corp.local : sert au contrôle d'Origin
    trustProxy: read('TRUST_PROXY', '127.0.0.1'), // IP du reverse proxy
    databaseUrl: read('DATABASE_URL'),
    logLevel: read('LOG_LEVEL', 'info'),
    staticDir: read('STATIC_DIR'),
    session: {
      cookieName: read('SESSION_COOKIE', isProd ? '__Host-kz_sid' : 'kz_sid'),
      secure: bool('SESSION_COOKIE_SECURE', isProd),
      ttlHours: int('SESSION_TTL_HOURS', 8),
      idleMinutes: int('SESSION_IDLE_MINUTES', 60),
    },
    login: {
      maxAttempts: int('LOGIN_MAX_ATTEMPTS', 5),
      lockMinutes: int('LOGIN_LOCK_MINUTES', 15),
    },
    upload: {
      dir: read('UPLOAD_DIR', './uploads'),
      maxMb: int('UPLOAD_MAX_MB', 20),
      allowedMime: list('UPLOAD_ALLOWED_MIME', [
        'application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain', 'text/csv',
        'application/zip', 'application/x-7z-compressed',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/vnd.oasis.opendocument.text', 'application/vnd.oasis.opendocument.spreadsheet',
        'application/vnd.oasis.opendocument.presentation',
      ]),
    },
    auth: {
      localEnabled: bool('AUTH_LOCAL_ENABLED', true),
      ldapEnabled,
    },
    // Paramètres (et secrets) LDAP lus uniquement si l'AD est activé
    ldap: !ldapEnabled ? { urls: [], userFilter: '{{username}}' } : {
      urls: list('LDAP_URL'), // ldaps://dc1.corp.local:636,ldaps://dc2.corp.local:636
      bindDn: read('LDAP_BIND_DN'),
      bindPassword: read('LDAP_BIND_PASSWORD'),
      baseDn: read('LDAP_BASE_DN'),
      userFilter: read('LDAP_USER_FILTER',
        '(&(objectCategory=person)(objectClass=user)(sAMAccountName={{username}}))'),
      groupUsers: read('LDAP_GROUP_USERS'), // DN du groupe d'accès
      groupAdmins: read('LDAP_GROUP_ADMINS'), // DN du groupe admin (optionnel)
      caFile: read('LDAP_CA_FILE'), // chaîne de la PKI interne (PEM)
      startTls: bool('LDAP_STARTTLS', false),
      timeoutMs: int('LDAP_TIMEOUT_MS', 5000),
      // Synchronisation des départs (désactivation + révocation des sessions) : période en minutes, 0 = désactivée
      syncMinutes: int('AD_SYNC_INTERVAL_MINUTES', 15),
    },
    ...overrides,
  };
  validate(cfg);
  return cfg;
}

function validate(cfg) {
  const errors = [];
  if (!cfg.databaseUrl) errors.push('DATABASE_URL est obligatoire');
  if (cfg.isProd && !cfg.publicUrl) errors.push('PUBLIC_URL est obligatoire en production');
  if (!cfg.auth.localEnabled && !cfg.auth.ldapEnabled) errors.push('Au moins une source d\'authentification doit être active');
  if (cfg.auth.ldapEnabled) {
    const l = cfg.ldap;
    if (!l.urls.length) errors.push('LDAP_URL est obligatoire');
    for (const u of l.urls) {
      if (!u.startsWith('ldaps://') && !l.startTls) errors.push(`LDAP_URL ${u} : LDAPS ou LDAP_STARTTLS=true obligatoire`);
    }
    for (const k of ['bindDn', 'bindPassword', 'baseDn', 'groupUsers']) {
      if (!l[k]) errors.push(`Paramètre LDAP manquant : ${k}`);
    }
    if (!l.userFilter.includes('{{username}}')) errors.push('LDAP_USER_FILTER doit contenir {{username}}');
  }
  if (errors.length) {
    const e = new Error(`Configuration invalide :\n - ${errors.join('\n - ')}`);
    e.code = 'KZ_CONFIG';
    throw e;
  }
}
