import crypto from 'node:crypto';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function createSessionStore(prisma, cfg) {
  const ttlMs = cfg.session.ttlHours * 3600_000;
  const idleMs = cfg.session.idleMinutes * 60_000;

  return {
    async create(userId, { ip, userAgent } = {}) {
      const token = crypto.randomBytes(32).toString('base64url');
      await prisma.session.create({
        data: {
          tokenHash: sha256(token),
          userId,
          expiresAt: new Date(Date.now() + ttlMs),
          ip,
          userAgent: userAgent?.slice(0, 255),
        },
      });
      return token;
    },

    /** Renvoie l'utilisateur de la session, ou null (expirée, inactive, compte désactivé). */
    async resolve(token) {
      if (!token || typeof token !== 'string' || token.length > 100) return null;
      const s = await prisma.session.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
      if (!s) return null;
      const now = Date.now();
      if (s.expiresAt.getTime() < now || s.lastSeenAt.getTime() + idleMs < now || s.user.disabled) {
        await prisma.session.delete({ where: { id: s.id } }).catch(() => {});
        return null;
      }
      if (now - s.lastSeenAt.getTime() > 60_000) {
        await prisma.session.update({ where: { id: s.id }, data: { lastSeenAt: new Date() } }).catch(() => {});
      }
      return { sessionId: s.id, user: s.user };
    },

    destroy: (token) => prisma.session.deleteMany({ where: { tokenHash: sha256(token ?? '') } }),
    destroyAllForUser: (userId) => prisma.session.deleteMany({ where: { userId } }),
    purgeExpired: () => prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } }),
    cookieOptions: () => ({
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: cfg.session.secure,
      maxAge: cfg.session.ttlHours * 3600,
    }),
  };
}
