import { dummyVerify, verifyPassword, hashPassword, checkPasswordPolicy } from '../lib/passwords.js';
import { badRequest, unauthorized } from '../lib/errors.js';

export const publicUser = (u) => ({
  id: u.id, username: u.username, displayName: u.displayName, email: u.email,
  role: u.role, authSource: u.authSource, mustChangePassword: u.mustChangePassword,
});

const GENERIC_FAIL = 'Identifiant ou mot de passe incorrect';

export default async function authRoutes(app) {
  const { prisma, cfg, sessions, audit, ldap } = app;

  app.get('/auth/config', async () => ({ local: cfg.auth.localEnabled, ldap: cfg.auth.ldapEnabled }));

  app.post('/auth/login', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, // par IP
    schema: {
      body: {
        type: 'object', required: ['username', 'password'], additionalProperties: false,
        properties: { username: { type: 'string', minLength: 1, maxLength: 128 }, password: { type: 'string', minLength: 1, maxLength: 256 } },
      },
    },
  }, async (req, reply) => {
    // « DOMAINE\jdupont » ou « jdupont@corp.local » -> « jdupont »
    const username = req.body.username.trim().toLowerCase().replace(/^.*\\/, '').replace(/@.*$/, '');
    const { password } = req.body;
    const fail = async (reason, user) => {
      await audit(req, 'auth.login', { outcome: 'failure', target: username, details: { reason }, actor: user ?? null });
      throw unauthorized(reason === 'locked' ? 'Compte temporairement verrouillé' : reason === 'unavailable' ? 'Annuaire indisponible, réessayez plus tard' : GENERIC_FAIL);
    };

    let user = await prisma.user.findUnique({ where: { username } });
    if (user?.lockedUntil && user.lockedUntil > new Date()) return fail('locked', user);

    if (user?.authSource === 'LOCAL' || (!user && !cfg.auth.ldapEnabled)) {
      if (!cfg.auth.localEnabled) { await dummyVerify(password); return fail('local_disabled', user); }
      if (!user) { await dummyVerify(password); return fail('unknown_user'); }
      const ok = await verifyPassword(user.passwordHash, password);
      if (!ok) {
        const failed = user.failedLogins + 1;
        const lock = failed >= cfg.login.maxAttempts;
        await prisma.user.update({
          where: { id: user.id },
          data: { failedLogins: lock ? 0 : failed, lockedUntil: lock ? new Date(Date.now() + cfg.login.lockMinutes * 60_000) : undefined },
        });
        if (lock) await audit(req, 'auth.lockout', { outcome: 'success', target: username, actor: user });
        return fail('bad_password', user);
      }
      if (user.disabled) return fail('disabled', user);
    } else {
      // Compte AD (déjà provisionné ou inconnu)
      if (!cfg.auth.ldapEnabled || !ldap) return fail('ldap_disabled', user);
      const r = await ldap.authenticate(username, password);
      if (!r.ok) {
        if (r.reason === 'not_in_group' && user) await sessions.destroyAllForUser(user.id); // retrait du groupe = perte d'accès
        return fail(r.reason, user);
      }
      const p = r.profile;
      const data = { username: p.username, displayName: p.displayName, email: p.email, role: p.isAdmin ? 'ADMIN' : 'USER' };
      const existing = await prisma.user.findFirst({ where: { OR: [{ externalId: p.externalId }, { username: p.username }] } });
      if (existing && existing.authSource !== 'LDAP') return fail('username_conflict', existing); // pas d'usurpation d'un compte local
      if (existing?.disabled) return fail('disabled', existing);
      user = existing
        ? await prisma.user.update({ where: { id: existing.id }, data })
        : await prisma.user.create({ data: { ...data, authSource: 'LDAP', externalId: p.externalId } });
      if (!existing) await audit(req, 'user.provision', { target: user.username, actor: user, details: { source: 'LDAP' } });
    }

    user = await prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } });
    const token = await sessions.create(user.id, { ip: req.ip, userAgent: req.headers['user-agent'] });
    reply.setCookie(cfg.session.cookieName, token, sessions.cookieOptions());
    await audit(req, 'auth.login', { actor: user, target: user.username, details: { source: user.authSource } });
    return { user: publicUser(user) };
  });

  app.post('/auth/logout', async (req, reply) => {
    const token = req.cookies[cfg.session.cookieName];
    if (token) await sessions.destroy(token);
    reply.clearCookie(cfg.session.cookieName, { path: '/' });
    if (req.user) await audit(req, 'auth.logout');
    return { ok: true };
  });

  app.get('/auth/me', { onRequest: [app.requireUser], config: { allowPasswordChange: true } }, async (req) => ({ user: publicUser(req.user) }));

  app.post('/auth/password', {
    onRequest: [app.requireUser],
    config: { allowPasswordChange: true, rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object', required: ['currentPassword', 'newPassword'], additionalProperties: false,
        properties: { currentPassword: { type: 'string', maxLength: 256 }, newPassword: { type: 'string', maxLength: 256 } },
      },
    },
  }, async (req, reply) => {
    if (req.user.authSource !== 'LOCAL') throw badRequest('Le mot de passe d\'un compte AD se change dans l\'annuaire');
    if (!(await verifyPassword(req.user.passwordHash, req.body.currentPassword))) {
      await audit(req, 'auth.password_change', { outcome: 'failure' });
      throw badRequest('Mot de passe actuel incorrect');
    }
    const problems = checkPasswordPolicy(req.body.newPassword, { username: req.user.username });
    if (req.body.newPassword === req.body.currentPassword) problems.push('doit être différent de l\'actuel');
    if (problems.length) throw badRequest(`Mot de passe refusé : ${problems.join(', ')}`);
    await prisma.user.update({ where: { id: req.user.id }, data: { passwordHash: await hashPassword(req.body.newPassword), mustChangePassword: false } });
    // Invalide toutes les sessions puis en rouvre une pour l'appareil courant
    await sessions.destroyAllForUser(req.user.id);
    const token = await sessions.create(req.user.id, { ip: req.ip, userAgent: req.headers['user-agent'] });
    reply.setCookie(cfg.session.cookieName, token, sessions.cookieOptions());
    await audit(req, 'auth.password_change');
    return { ok: true };
  });
}
