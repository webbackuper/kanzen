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

/** GUID texte (format de guidToString) -> filtre LDAP binaire échappé (\\xx par octet, ordre de stockage AD). */
export function guidToFilter(guid) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(guid ?? '')) return null;
  const h = guid.replace(/-/g, '').toLowerCase();
  const le = (x) => x.match(/../g).reverse().join('');
  const bytes = le(h.slice(0, 8)) + le(h.slice(8, 12)) + le(h.slice(12, 16)) + h.slice(16);
  return bytes.match(/../g).map((b) => `\\${b}`).join('');
}

const USER_ATTRS = ['dn', 'sAMAccountName', 'displayName', 'mail', 'objectGUID', 'userAccountControl'];
const DISABLED = '(userAccountControl:1.2.840.113556.1.4.803:=2)'; // bit ACCOUNTDISABLE

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
          attributes: USER_ATTRS,
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

  /** Diagnostic (kanzenctl check) : bind de service, recherche et groupes, sans mot de passe utilisateur. */
  async function diagnose(username) {
    return withClient(async (client) => {
      await client.bind(ldapCfg.bindDn, ldapCfg.bindPassword);
      const out = { serviceBind: 'ok' };
      for (const [k, dn] of [['groupUsers', ldapCfg.groupUsers], ['groupAdmins', ldapCfg.groupAdmins]]) {
        if (!dn) continue;
        const r = await client.search(dn, { scope: 'base', filter: '(objectClass=group)', attributes: ['dn'] }).catch(() => ({ searchEntries: [] }));
        out[k] = r.searchEntries.length === 1 ? 'trouvé' : 'INTROUVABLE';
      }
      if (username) {
        const filter = ldapCfg.userFilter.replaceAll('{{username}}', escapeFilter(username));
        const { searchEntries } = await client.search(ldapCfg.baseDn, { scope: 'sub', filter, sizeLimit: 2, attributes: ['dn'] });
        out.user = searchEntries.length === 1 ? searchEntries[0].dn : `${searchEntries.length} résultat(s)`;
        if (searchEntries.length === 1) {
          const inGroup = async (g) => g && (await client.search(searchEntries[0].dn, { scope: 'base', filter: `(memberOf:${IN_CHAIN}:=${escapeFilter(g)})`, attributes: ['dn'] })).searchEntries.length === 1;
          out.memberOfUsers = await inGroup(ldapCfg.groupUsers);
          out.memberOfAdmins = await inGroup(ldapCfg.groupAdmins);
        }
      }
      return out;
    });
  }

  // --- Annuaire : recherche (ajout de membres) et synchronisation (arrivées / départs) ---
  const inGroups = () => {
    const parts = [ldapCfg.groupUsers, ldapCfg.groupAdmins].filter(Boolean).map((g) => `(memberOf:${IN_CHAIN}:=${escapeFilter(g)})`);
    return parts.length === 1 ? parts[0] : `(|${parts.join('')})`;
  };
  const toProfile = (entry, isAdmin = false) => ({
    username: String(first(entry.sAMAccountName) ?? '').toLowerCase(),
    displayName: String(first(entry.displayName) ?? first(entry.sAMAccountName) ?? ''),
    email: first(entry.mail) ? String(first(entry.mail)) : null,
    externalId: guidToString(first(entry.objectGUID)) ?? entry.dn,
    isAdmin,
  });
  const ACTIVE_PERSON = `(objectCategory=person)(objectClass=user)(!${DISABLED})`;

  /** Comptes AD actifs, membres du groupe d'accès, dont l'identifiant ou le nom contient « q » (20 au plus). */
  async function searchUsers(q) {
    const e = escapeFilter(q);
    return withClient(async (client) => {
      await client.bind(ldapCfg.bindDn, ldapCfg.bindPassword);
      const { searchEntries } = await client.search(ldapCfg.baseDn, {
        scope: 'sub',
        filter: `(&${ACTIVE_PERSON}${inGroups()}(|(sAMAccountName=*${e}*)(displayName=*${e}*)(mail=*${e}*)))`,
        sizeLimit: 20,
        attributes: USER_ATTRS,
        explicitBufferAttributes: ['objectGUID'],
      });
      return searchEntries.map((x) => toProfile(x)).filter((p) => p.username);
    });
  }

  /** Profil d'un compte AD actif ET membre du groupe d'accès, par objectGUID ; null sinon. */
  async function findByGuid(guid) {
    const g = guidToFilter(guid);
    if (!g) return null;
    return withClient(async (client) => {
      await client.bind(ldapCfg.bindDn, ldapCfg.bindPassword);
      const { searchEntries } = await client.search(ldapCfg.baseDn, {
        scope: 'sub', filter: `(&${ACTIVE_PERSON}(objectGUID=${g})${inGroups()})`, sizeLimit: 2, attributes: USER_ATTRS, explicitBufferAttributes: ['objectGUID'],
      });
      if (searchEntries.length !== 1) return null;
      const admins = ldapCfg.groupAdmins ? (await client.search(searchEntries[0].dn, { scope: 'base', filter: `(memberOf:${IN_CHAIN}:=${escapeFilter(ldapCfg.groupAdmins)})`, attributes: ['dn'] })).searchEntries.length === 1 : false;
      return toProfile(searchEntries[0], admins);
    });
  }

  /**
   * Tous les comptes AD actifs autorisés (groupe d'accès ou groupe admin, appartenance récursive), indexés par objectGUID.
   * Lève une exception si l'annuaire est injoignable : l'appelant ne doit alors rien désactiver.
   */
  async function listAuthorized() {
    return withClient(async (client) => {
      await client.bind(ldapCfg.bindDn, ldapCfg.bindPassword);
      const opts = { scope: 'sub', paged: { pageSize: 500 }, attributes: USER_ATTRS, explicitBufferAttributes: ['objectGUID'] };
      const admins = new Set();
      if (ldapCfg.groupAdmins) {
        const r = await client.search(ldapCfg.baseDn, { ...opts, filter: `(&${ACTIVE_PERSON}(memberOf:${IN_CHAIN}:=${escapeFilter(ldapCfg.groupAdmins)}))` });
        for (const x of r.searchEntries) admins.add(toProfile(x).externalId);
      }
      const r = await client.search(ldapCfg.baseDn, { ...opts, filter: `(&${ACTIVE_PERSON}${inGroups()})` });
      const out = new Map();
      for (const x of r.searchEntries) { const p = toProfile(x); out.set(p.externalId, { ...p, isAdmin: admins.has(p.externalId) }); }
      return out;
    });
  }

  return { authenticate, diagnose, searchUsers, findByGuid, listAuthorized };
}
