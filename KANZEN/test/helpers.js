import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig } from '../src/server/config.js';
import { createPrisma } from '../src/server/db.js';
import { buildApp } from '../src/server/app.js';
import { hashPassword } from '../src/server/lib/passwords.js';

export const PASSWORD = 'Test-Password-2026!';
const DB = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

export async function setup({ ldap, env = {} } = {}) {
  if (!DB) throw new Error('TEST_DATABASE_URL (ou DATABASE_URL) requis pour les tests d\'intégration');
  const cfg = loadConfig({
    env: 'test', isProd: false, databaseUrl: DB, logLevel: 'silent', publicUrl: 'https://kanzen.test',
    upload: { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'kz-up-')), maxMb: 1, allowedMime: ['application/pdf', 'text/plain'] },
    ...env,
  });
  const prisma = createPrisma(DB);
  await prisma.$executeRawUnsafe('TRUNCATE "AuditLog", "Session", "Workspace", "User" RESTART IDENTITY CASCADE');
  const app = await buildApp({ cfg, prisma, ldap, logger: false });
  await app.ready();
  return { app, prisma, cfg };
}

export function migrate() {
  execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: DB }, stdio: 'ignore' });
}

export async function createUser(prisma, username, { role = 'USER', ...rest } = {}) {
  return prisma.user.create({
    data: { username, displayName: username, role, authSource: 'LOCAL', passwordHash: await hashPassword(PASSWORD), ...rest },
  });
}

/** Client HTTP qui garde le cookie de session et envoie l'en-tête anti-CSRF. */
export function client(app) {
  let cookie = '';
  const call = async (method, url, body, headers = {}) => {
    const res = await app.inject({
      method, url,
      headers: { 'x-requested-with': 'KanZen', ...(cookie ? { cookie } : {}), ...headers },
      ...(body !== undefined ? { payload: body } : {}),
    });
    const set = res.cookies.find((c) => c.name === app.cfg.session.cookieName);
    if (set) cookie = set.value ? `${set.name}=${set.value}` : '';
    return res;
  };
  return {
    get: (u, h) => call('GET', u, undefined, h),
    post: (u, b, h) => call('POST', u, b ?? {}, h),
    patch: (u, b) => call('PATCH', u, b),
    put: (u, b) => call('PUT', u, b),
    del: (u) => call('DELETE', u),
    raw: call,
    login: (username, password = PASSWORD) => call('POST', '/api/auth/login', { username, password }),
  };
}
