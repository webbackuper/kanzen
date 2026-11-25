import { hashPassword, checkPasswordPolicy } from '../lib/passwords.js';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { provisionFromDirectory } from '../lib/adsync.js';
import { publicUser } from './auth.js';

const USERNAME = { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{1,63}$' };
const idParam = { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] };

const adminView = (u) => ({ ...publicUser(u), disabled: u.disabled, disabledReason: u.disabledReason, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt, lockedUntil: u.lockedUntil });

export default async function userRoutes(app) {
  const { prisma, audit, sessions, cfg, ldap } = app;

  // Recherche d'utilisateurs (ajout de membres, assignation) : champs minimaux, tout utilisateur connecté
  app.get('/users/lookup', {
    onRequest: [app.requireUser],
    schema: { querystring: { type: 'object', properties: { q: { type: 'string', maxLength: 64 } } } },
  }, async (req) => {
    const q = (req.query.q ?? '').trim();
    const users = await prisma.user.findMany({
      where: { disabled: false, ...(q ? { OR: [{ username: { contains: q, mode: 'insensitive' } }, { displayName: { contains: q, mode: 'insensitive' } }] } : {}) },
      select: { id: true, username: true, displayName: true },
      orderBy: { displayName: 'asc' },
      take: 20,
    });
    // AD actif : on complète avec les membres du groupe d'accès qui ne se sont encore jamais connectés.
    // Ils sont renvoyés sans « id » ; POST /users/provision crée leur compte au moment de l'ajout.
    let directory = [];
    let directoryError = false;
    if (ldap && cfg.auth.ldapEnabled && q.length >= 3) {
      try {
        const known = await prisma.user.findMany({ where: { authSource: 'LDAP', externalId: { not: null } }, select: { externalId: true } });
        const knownIds = new Set(known.map((k) => k.externalId));
        const localNames = new Set(users.map((u) => u.username));
        directory = (await ldap.searchUsers(q))
          .filter((p) => !knownIds.has(p.externalId) && !localNames.has(p.username))
          .slice(0, 20 - Math.min(users.length, 10))
          .map((p) => ({ id: null, externalId: p.externalId, username: p.username, displayName: p.displayName, source: 'LDAP' }));
      } catch (err) {
        directoryError = true;
        req.log.warn({ err: err?.message }, 'recherche AD indisponible');
      }
    }
    return { users: [...users, ...directory], directoryError };
  });

  // Création à la demande d'un compte AD jamais connecté (ajout à un espace, affectation).
  // Réservé aux administrateurs et aux propriétaires d'au moins un espace ; le compte doit être actif ET
  // membre du groupe d'accès dans l'AD au moment de la demande (contrôle refait côté serveur).
  app.post('/users/provision', {
    onRequest: [app.requireUser],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { body: { type: 'object', required: ['externalId'], additionalProperties: false, properties: { externalId: { type: 'string', format: 'uuid' } } } },
  }, async (req, reply) => {
    if (!ldap || !cfg.auth.ldapEnabled) throw badRequest('Annuaire AD non activé');
    if (req.user.role !== 'ADMIN' && !(await prisma.workspaceMember.count({ where: { userId: req.user.id, role: 'OWNER' } }))) throw forbidden();
    let profile;
    try { profile = await ldap.findByGuid(req.body.externalId); } catch { throw new HttpError(503, 'Annuaire AD injoignable', 'UNAVAILABLE'); }
    if (!profile) throw notFound();
    const r = await provisionFromDirectory(app, req, profile);
    if (r.conflict) throw conflict('Un compte local porte déjà cet identifiant');
    if (r.user.disabled) throw badRequest('Compte désactivé dans KanZen');
    return reply.code(201).send({ user: { id: r.user.id, username: r.user.username, displayName: r.user.displayName } });
  });

  app.get('/users', { onRequest: [app.requireAdmin] }, async () => {
    const users = await prisma.user.findMany({ orderBy: { username: 'asc' } });
    return { users: users.map(adminView) };
  });

  // Création d'un compte LOCAL
  app.post('/users', {
    onRequest: [app.requireAdmin],
    schema: {
      body: {
        type: 'object', required: ['username', 'displayName', 'password'], additionalProperties: false,
        properties: {
          username: USERNAME, displayName: { type: 'string', minLength: 1, maxLength: 128 },
          email: { type: 'string', format: 'email', maxLength: 254 }, password: { type: 'string', maxLength: 256 },
          role: { enum: ['ADMIN', 'USER'] },
        },
      },
    },
  }, async (req, reply) => {
    if (!cfg.auth.localEnabled) throw badRequest('Les comptes locaux sont désactivés');
    const b = req.body;
    const problems = checkPasswordPolicy(b.password, { username: b.username });
    if (problems.length) throw badRequest(`Mot de passe refusé : ${problems.join(', ')}`);
    if (await prisma.user.findUnique({ where: { username: b.username } })) throw conflict('Identifiant déjà utilisé');
    const user = await prisma.user.create({
      data: {
        username: b.username, displayName: b.displayName, email: b.email ?? null, role: b.role ?? 'USER',
        authSource: 'LOCAL', passwordHash: await hashPassword(b.password), mustChangePassword: true,
      },
    });
    await audit(req, 'user.create', { target: user.username, details: { role: user.role } });
    return reply.code(201).send({ user: adminView(user) });
  });

  app.patch('/users/:id', {
    onRequest: [app.requireAdmin],
    schema: {
      params: idParam,
      body: {
        type: 'object', additionalProperties: false, minProperties: 1,
        properties: {
          displayName: { type: 'string', minLength: 1, maxLength: 128 }, email: { type: ['string', 'null'], maxLength: 254 },
          role: { enum: ['ADMIN', 'USER'] }, disabled: { type: 'boolean' }, unlock: { type: 'boolean' },
        },
      },
    },
  }, async (req) => {
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) throw notFound();
    const { unlock, ...rest } = req.body;
    if (target.id === req.user.id && (rest.disabled === true || rest.role === 'USER')) throw badRequest('Impossible de se retirer ses propres droits');
    if (target.authSource === 'LDAP' && rest.role) throw badRequest('Le rôle d\'un compte AD découle de ses groupes');
    // Décision d'un administrateur : prévaut sur la synchronisation AD (plus de réactivation automatique)
    const data = { ...rest, ...(rest.disabled !== undefined ? { disabledReason: null } : {}), ...(unlock ? { lockedUntil: null, failedLogins: 0 } : {}) };
    const user = await prisma.user.update({ where: { id: target.id }, data });
    if (rest.disabled) await sessions.destroyAllForUser(user.id);
    await audit(req, 'user.update', { target: user.username, details: req.body });
    return { user: adminView(user) };
  });

  app.post('/users/:id/reset-password', {
    onRequest: [app.requireAdmin],
    schema: { params: idParam, body: { type: 'object', required: ['password'], additionalProperties: false, properties: { password: { type: 'string', maxLength: 256 } } } },
  }, async (req) => {
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) throw notFound();
    if (target.authSource !== 'LOCAL') throw badRequest('Compte AD : réinitialisation dans l\'annuaire');
    const problems = checkPasswordPolicy(req.body.password, { username: target.username });
    if (problems.length) throw badRequest(`Mot de passe refusé : ${problems.join(', ')}`);
    await prisma.user.update({ where: { id: target.id }, data: { passwordHash: await hashPassword(req.body.password), mustChangePassword: true, failedLogins: 0, lockedUntil: null } });
    await sessions.destroyAllForUser(target.id);
    await audit(req, 'user.reset_password', { target: target.username });
    return { ok: true };
  });

  app.delete('/users/:id/sessions', { onRequest: [app.requireAdmin], schema: { params: idParam } }, async (req) => {
    const { count } = await sessions.destroyAllForUser(req.params.id);
    await audit(req, 'user.revoke_sessions', { target: req.params.id, details: { count } });
    return { revoked: count };
  });
}
