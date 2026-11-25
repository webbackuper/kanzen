// Authentification Active Directory via LDAPS.
// 1. bind avec le compte de service (lecture seule)  2. recherche de l'utilisateur
// 3. contrôle d'appartenance (récursive) aux groupes  4. bind avec le DN de l'utilisateur et son mot de passe.
import fs from 'node:fs';
import { Client, escapeFilter } from 'ldapts';

// LDAP_MATCHING_RULE_IN_CHAIN : appartenance récursive (groupes imbriqués), spécifique AD.
const IN_CHAIN = '1.2.840.113556.1.4.1941';

function guidToString(buf) {
  if (!Buffer.isBuffer(buf) || buf.length !== 16) return null;
  const h = buf.toString('hex');
  // objectGUID est stocké en little-endian sur les 3 premiers blocs
  const le = (s) => s.match(/../g).reverse().join('');
  return `${le(h.slice(0, 8))}-${le(h.slice(8, 12))}-${le(h.slice(12, 16))}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const first = (v) => (Array.isArray(v) ? v[0] : v);

export function createLdapAuthenticator(ldapCfg, log) {
  const tlsOptions = {
    minVersion: 'TLSv1.2',
    ...(ldapCfg.caFile ? { ca: [fs.readFileSync(ldapCfg.caFile)] } : {}),
  };

  async function withClient(fn) {
    let lastErr;
    for (const url of ldapCfg.urls) { // bascule sur le contrôleur de domaine suivant en cas d'échec réseau
      const client = new Client({ url, timeout: ldapCfg.timeoutMs, connectTimeout: ldapCfg.timeoutMs, tlsOptions });
      try {
        if (ldapCfg.startTls) await client.startTLS(tlsOptions);
        return await fn(client);
      } catch (err) {
        if (err?.code === 49 || err?.constructor?.name === 'InvalidCredentialsError') throw err;
        if (err?.kzFinal) throw err;
        lastErr = err;
        log.warn({ url, err: err?.message }, 'contrôleur LDAP injoignable, essai du suivant');
      } finally {
        await client.unbind().catch(() => {});
      }
    }
    throw lastErr ?? new Error('Aucun serveur LDAP configuré');
  }

  const final = (reason) => Object.assign(new Error(reason), { kzFinal: true, reason });

  /**
   * @returns {Promise<{ok: true, profile} | {ok: false, reason}>}
   * reason : invalid_credentials | not_found | not_in_group | unavailable
   */
  async function authenticate(username, password) {
    // Un bind avec mot de passe vide est un « unauthenticated bind » qui RÉUSSIT : refus explicite.
    if (!username || !password) return { ok: false, reason: 'invalid_credentials' };
    try {
      return await withClient(async (client) => {
        await client.bind(ldapCfg.bindDn, ldapCfg.bindPassword);
        const filter = ldapCfg.userFilter.replaceAll('{{username}}', escapeFilter(username));
        const { searchEntries } = await client.search(ldapCfg.baseDn, {
          scope: 'sub',
          filter,
          sizeLimit: 2,
          attributes: ['dn', 'sAMAccountName', 'displayName', 'mail', 'objectGUID', 'userAccountControl'],
          explicitBufferAttributes: ['objectGUID'],
        });
        if (searchEntries.length !== 1) throw final('not_found');
        const entry = searchEntries[0];
        if (Number(first(entry.userAccountControl)) & 2) throw final('invalid_credentials'); // compte désactivé

        const isMember = async (groupDn) => {
          if (!groupDn) return false;
          const r = await client.search(entry.dn, {
            scope: 'base',
            filter: `(memberOf:${IN_CHAIN}:=${escapeFilter(groupDn)})`,
            attributes: ['dn'],
          });
          return r.searchEntries.length === 1;
        };
        const admin = await isMember(ldapCfg.groupAdmins);
        const member = admin || (await isMember(ldapCfg.groupUsers));
        if (!member) throw final('not_in_group');

        await client.bind(entry.dn, password); // vérification du mot de passe par l'AD lui-même
        return {
          ok: true,
          profile: {
            username: String(first(entry.sAMAccountName) ?? username).toLowerCase(),
            displayName: String(first(entry.displayName) ?? username),
            email: first(entry.mail) ? String(first(entry.mail)) : null,
            externalId: guidToString(first(entry.objectGUID)) ?? entry.dn,
            isAdmin: admin,
          },
        };
      });
    } catch (err) {
      if (err?.kzFinal) return { ok: false, reason: err.reason };
      if (err?.code === 49 || err?.constructor?.name === 'InvalidCredentialsError') {
        return { ok: false, reason: 'invalid_credentials' };
      }
      log.error({ err: err?.message }, 'erreur LDAP');
      return { ok: false, reason: 'unavailable' };
    }
  }

  return { authenticate };
}
