// Journal d'audit : écrit en base ET émis en JSON (logger) pour collecte journald / syslog / SIEM.
export function createAudit(prisma, log) {
  return async function audit(req, action, { outcome = 'success', target, details, actor } = {}) {
    const u = actor ?? req?.user;
    const entry = {
      actorId: u?.id ?? null,
      actorName: u?.username ?? null,
      action,
      target: target ?? null,
      outcome,
      ip: req?.ip ?? null,
      details: details ?? undefined,
    };
    log.info({ audit: entry }, `audit ${action} ${outcome}`);
    try {
      await prisma.auditLog.create({ data: entry });
    } catch (err) {
      log.error({ err }, 'écriture du journal d\'audit impossible');
    }
  };
}
