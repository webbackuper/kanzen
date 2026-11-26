import path from 'node:path';
import fs from 'node:fs';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { createAudit } from './lib/audit.js';
import { createSessionStore } from './lib/sessions.js';
import { createAuthz } from './lib/authz.js';
import { createLdapAuthenticator } from './lib/ldap.js';
import { HttpError, unauthorized, forbidden } from './lib/errors.js';
import { attachRealtime } from './realtime.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import workspaceRoutes from './routes/workspaces.js';
import boardRoutes from './routes/boards.js';
import taskRoutes from './routes/tasks.js';
import attachmentRoutes from './routes/attachments.js';
import adminRoutes from './routes/admin.js';
import wikiRoutes from './routes/wiki.js';

export async function buildApp({ cfg, prisma, ldap, logger } = {}) {
  const app = Fastify({
    logger: logger ?? {
      level: cfg.logLevel,
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    },
    trustProxy: cfg.trustProxy,
    // À l'arrêt, ferme aussi les connexions HTTP keep-alive inactives
    forceCloseConnections: 'idle',
    bodyLimit: 1024 * 1024,
    // Validation stricte : un champ inconnu est refusé (et non silencieusement supprimé)
    ajv: { customOptions: { removeAdditional: false, coerceTypes: 'array', useDefaults: true, allErrors: false } },
  });

  const sessions = createSessionStore(prisma, cfg);
  const authz = createAuthz(prisma);
  const audit = createAudit(prisma, app.log);
  ldap ??= cfg.auth.ldapEnabled ? createLdapAuthenticator(cfg.ldap, app.log) : null;
  const uploadDir = path.resolve(cfg.upload.dir);
  fs.mkdirSync(uploadDir, { recursive: true, mode: 0o750 });

  app.decorate('cfg', cfg);
  app.decorate('prisma', prisma);
  app.decorate('sessions', sessions);
  app.decorate('authz', authz);
  app.decorate('audit', audit);
  app.decorate('ldap', ldap);
  app.decorate('uploadDir', uploadDir);
  app.decorateRequest('user', null);
  app.decorate('removeStoredFiles', async (names) => {
    for (const n of names) {
      if (/^[0-9a-f-]{36}$/.test(n)) await fs.promises.rm(path.join(uploadDir, n), { force: true });
    }
  });
  // Noms de stockage des fichiers rattachés à un espace, un tableau ou une colonne, à effacer du disque
  // après la suppression en cascade en base (sinon ils resteraient orphelins dans le stockage).
  app.decorate('storedFilesOf', async ({ workspaceId, boardId, columnId }) => {
    const column = columnId ? { id: columnId } : boardId ? { boardId } : { board: { workspaceId } };
    const attachments = await prisma.attachment.findMany({ where: { task: { column } }, select: { storageName: true } });
    const wiki = workspaceId ? await prisma.wikiFile.findMany({ where: { page: { workspaceId } }, select: { storageName: true } }) : [];
    return [...attachments, ...wiki].map((f) => f.storageName);
  });

  await app.register(fastifyCookie);
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"], // styles inline générés par dnd-kit / recharts
        'img-src': ["'self'", 'data:', 'blob:'],
        'connect-src': ["'self'"],
        'object-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'upgrade-insecure-requests': cfg.session.secure ? [] : null,
      },
    },
    hsts: cfg.session.secure ? { maxAge: 31536000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false,
  });
  await app.register(fastifyRateLimit, { global: true, max: 600, timeWindow: '1 minute' });
  await app.register(fastifyMultipart, {
    limits: { fileSize: cfg.upload.maxMb * 1024 * 1024, files: 1, fields: 5 },
  });

  // --- Authentification de chaque requête API par le cookie de session ---
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    const token = req.cookies[cfg.session.cookieName];
    if (!token) return;
    const s = await sessions.resolve(token);
    if (s) req.user = s.user;
  });

  // --- Protection CSRF : en-tête personnalisé obligatoire + contrôle d'Origin sur les requêtes d'écriture ---
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/') || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    if (req.headers['x-requested-with'] !== 'KanZen') throw forbidden('En-tête X-Requested-With manquant');
    const origin = req.headers.origin;
    if (origin && cfg.publicUrl && origin !== new URL(cfg.publicUrl).origin) throw forbidden('Origine refusée');
  });

  app.decorate('requireUser', async (req) => {
    if (!req.user) throw unauthorized();
    if (req.user.mustChangePassword && !req.routeOptions.config?.allowPasswordChange) {
      throw forbidden('Changement de mot de passe obligatoire');
    }
  });
  app.decorate('requireAdmin', async (req) => {
    await app.requireUser(req);
    if (req.user.role !== 'ADMIN') throw forbidden();
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message, code: err.code });
    if (err.validation) return reply.code(400).send({ error: 'Requête invalide', details: err.validation.map((v) => `${v.instancePath} ${v.message}`) });
    if (err.code === 'P2025') return reply.code(404).send({ error: 'Introuvable', code: 'NOT_FOUND' });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message, code: err.code });
    req.log.error({ err }, 'erreur interne');
    return reply.code(500).send({ error: 'Erreur interne', code: 'INTERNAL' }); // pas de détail interne exposé
  });

  app.get('/api/health', { config: { rateLimit: false } }, async () => {
    await prisma.$queryRaw`SELECT 1`;
    return { status: 'ok' };
  });

  const realtime = attachRealtime(app, { sessions, authz, cfg });
  app.decorate('realtime', realtime);

  await app.register(authRoutes, { prefix: '/api' });
  await app.register(userRoutes, { prefix: '/api' });
  await app.register(workspaceRoutes, { prefix: '/api' });
  await app.register(boardRoutes, { prefix: '/api' });
  await app.register(taskRoutes, { prefix: '/api' });
  await app.register(attachmentRoutes, { prefix: '/api' });
  await app.register(adminRoutes, { prefix: '/api' });
  await app.register(wikiRoutes, { prefix: '/api' });

  // --- Interface web (build Vite) : les routes inconnues hors /api renvoient l'index (SPA) ---
  if (cfg.staticDir && fs.existsSync(cfg.staticDir)) {
    await app.register(fastifyStatic, { root: path.resolve(cfg.staticDir), wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/socket.io')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'Introuvable', code: 'NOT_FOUND' });
    });
  }

  // Les websockets maintiennent le serveur HTTP ouvert : on les ferme AVANT l'arrêt de Fastify
  app.addHook('preClose', async () => {
    realtime.io.disconnectSockets(true);
    await new Promise((resolve) => realtime.io.close(() => resolve()));
  });

  return app;
}
