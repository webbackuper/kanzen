// Synchronisation avec l'Active Directory (arrivées / mutations / départs).
// - Compte AD retiré du groupe d'accès, désactivé ou supprimé dans l'AD : compte KanZen désactivé
//   (disabledReason = AD_SYNC) et sessions révoquées immédiatement.
// - Compte revenu dans le groupe : réactivé (uniquement s'il avait été désactivé par la synchronisation).
// - Nom, e-mail et rôle (groupe admin) mis à jour.
// Garde-fous : rien n'est désactivé si l'annuaire est injoignable, s'il ne renvoie aucun membre, ou si la
// synchronisation désactiverait plus de la moitié des comptes AD actifs (erreur de groupe ou de base DN probable),
// sauf « force ».

export async function syncDirectory({ prisma, ldap, audit, log, force = false }) {
  const report = { checked: 0, disabled: [], reenabled: [], updated: 0, aborted: null };
  let authorized;
  try {
    authorized = await ldap.listAuthorized();
  } catch (err) {
    report.aborted = `annuaire injoignable : ${err?.message ?? err}`;
    log.error({ err: err?.message }, 'synchronisation AD interrompue');
    return report;
  }
  const users = await prisma.user.findMany({ where: { authSource: 'LDAP' } });
  report.checked = users.length;
  const active = users.filter((u) => !u.disabled);
  const leaving = active.filter((u) => !authorized.has(u.externalId));
  if (!force && active.length > 0 && (authorized.size === 0 || (leaving.length > 5 && leaving.length > active.length / 2))) {
    report.aborted = `garde-fou : ${leaving.length} désactivation(s) sur ${active.length} compte(s) AD actifs, ${authorized.size} membre(s) trouvés dans l'annuaire. Vérifier LDAP_GROUP_USERS / LDAP_BASE_DN, puis relancer avec --force si c'est voulu.`;
    log.error(report.aborted);
    await audit(null, 'directory.sync', { outcome: 'failure', details: { reason: 'safety', leaving: leaving.length, active: active.length, members: authorized.size } });
    return report;
  }

  for (const u of users) {
    const p = authorized.get(u.externalId);
    if (!p) {
      if (u.disabled) continue;
      await prisma.user.update({ where: { id: u.id }, data: { disabled: true, disabledReason: 'AD_SYNC' } });
      const { count } = await prisma.session.deleteMany({ where: { userId: u.id } });
      report.disabled.push(u.username);
      await audit(null, 'user.deprovision', { target: u.username, details: { source: 'AD_SYNC', sessionsRevoked: count } });
      continue;
    }
    const data = {};
    if (p.displayName && p.displayName !== u.displayName) data.displayName = p.displayName;
    if ((p.email ?? null) !== (u.email ?? null)) data.email = p.email ?? null;
    const role = p.isAdmin ? 'ADMIN' : 'USER';
    if (role !== u.role) data.role = role;
    if (u.disabled && u.disabledReason === 'AD_SYNC') { data.disabled = false; data.disabledReason = null; report.reenabled.push(u.username); }
    if (Object.keys(data).length) {
      await prisma.user.update({ where: { id: u.id }, data });
      report.updated += 1;
      if (data.role) await audit(null, 'user.role_sync', { target: u.username, details: { role } });
      if (data.disabled === false) await audit(null, 'user.reprovision', { target: u.username, details: { source: 'AD_SYNC' } });
    }
  }
  if (report.disabled.length || report.reenabled.length) log.info({ adsync: report }, 'synchronisation AD');
  return report;
}

/** Création (ou mise à jour) d'un compte KanZen à partir d'un profil AD. Refuse d'écraser un compte local. */
export async function provisionFromDirectory({ prisma, audit }, req, p) {
  const data = { username: p.username, displayName: p.displayName, email: p.email, role: p.isAdmin ? 'ADMIN' : 'USER' };
  const existing = await prisma.user.findFirst({ where: { OR: [{ externalId: p.externalId }, { username: p.username }] } });
  if (existing && existing.authSource !== 'LDAP') return { conflict: existing };
  if (existing) return { user: existing };
  const user = await prisma.user.create({ data: { ...data, authSource: 'LDAP', externalId: p.externalId } });
  await audit(req, 'user.provision', { target: user.username, details: { source: 'LDAP', by: req?.user?.username ?? null } });
  return { user };
}
