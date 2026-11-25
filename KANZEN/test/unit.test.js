import { describe, it, expect } from 'vitest';
import { checkPasswordPolicy, hashPassword, verifyPassword } from '../src/server/lib/passwords.js';
import { loadConfig } from '../src/server/config.js';

describe('politique de mot de passe', () => {
  it('refuse les mots de passe faibles', () => {
    expect(checkPasswordPolicy('court')).not.toHaveLength(0);
    expect(checkPasswordPolicy('toutenminuscules')).not.toHaveLength(0);
    expect(checkPasswordPolicy('Jdupont-2026-secure', { username: 'jdupont' })).not.toHaveLength(0);
  });
  it('accepte un mot de passe robuste', () => {
    expect(checkPasswordPolicy('Correct-Horse-42', { username: 'alice' })).toEqual([]);
  });
  it('hache en argon2id et vérifie', async () => {
    const h = await hashPassword('Correct-Horse-42');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(h, 'Correct-Horse-42')).toBe(true);
    expect(await verifyPassword(h, 'autre')).toBe(false);
    expect(await verifyPassword(null, 'x')).toBe(false);
  });
});

describe('configuration', () => {
  const base = { databaseUrl: 'postgresql://x', publicUrl: 'https://k' };
  it('exige LDAPS quand l\'AD est activé', () => {
    expect(() => loadConfig({ ...base, auth: { localEnabled: true, ldapEnabled: true }, ldap: { urls: ['ldap://dc1'], startTls: false, bindDn: 'a', bindPassword: 'b', baseDn: 'c', groupUsers: 'd', userFilter: '(x={{username}})' } }))
      .toThrow(/LDAPS/);
  });
  it('ignore les secrets LDAP quand l\'AD est désactivé', () => {
    process.env.LDAP_BIND_PASSWORD_FILE = '/inexistant/ldap_bind_password';
    try { expect(loadConfig(base).auth.ldapEnabled).toBe(false); } finally { delete process.env.LDAP_BIND_PASSWORD_FILE; }
  });
  it('exige au moins une source d\'authentification', () => {
    expect(() => loadConfig({ ...base, auth: { localEnabled: false, ldapEnabled: false } })).toThrow(/source/);
  });
});
