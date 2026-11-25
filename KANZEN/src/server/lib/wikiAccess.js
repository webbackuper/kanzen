// Accès restreint aux pages du wiki.
// Règle : un propriétaire de l'espace (ou un administrateur) voit tout. Les autres membres voient une page
// si, pour chaque page « restreinte » parmi elle-même et ses ancêtres, ils figurent dans la liste des membres
// autorisés. Les restrictions se cumulent donc en descendant dans l'arborescence.
import { notFound } from './errors.js';

export function createWikiAccess(prisma, authz) {
  /**
   * Visibilité des pages d'un espace pour un utilisateur.
   * Renvoie { role, canSee(pageId), restrictedChain(pageId) } ; role vaut null si l'utilisateur n'est pas membre.
   */
  async function forWorkspace(user, workspaceId) {
    const role = await authz.workspaceRole(user, workspaceId);
    if (!role) return { role: null, canSee: () => false, restrictedIds: new Set() };
    const pages = await prisma.wikiPage.findMany({ where: { workspaceId }, select: { id: true, parentId: true, restricted: true } });
    const byId = new Map(pages.map((p) => [p.id, p]));
    const restrictedIds = new Set(pages.filter((p) => p.restricted).map((p) => p.id));
    if (role === 'OWNER') return { role, canSee: (id) => byId.has(id), restrictedIds };
    const allowed = new Set(restrictedIds.size
      ? (await prisma.wikiPageMember.findMany({ where: { userId: user.id, pageId: { in: [...restrictedIds] } }, select: { pageId: true } })).map((m) => m.pageId)
      : []);
    const memo = new Map();
    const canSee = (id) => {
      if (memo.has(id)) return memo.get(id);
      const p = byId.get(id);
      let ok = false;
      if (p) {
        memo.set(id, false); // garde-fou contre un éventuel cycle
        ok = (!p.restricted || allowed.has(id)) && (!p.parentId || canSee(p.parentId));
      }
      memo.set(id, ok);
      return ok;
    };
    return { role, canSee, restrictedIds };
  }

  /**
   * Contrôle d'accès à une page : rôle minimal dans l'espace ET visibilité de la page.
   * Une page invisible répond 404, comme un objet d'un autre espace.
   */
  async function checkPage(user, pageId, minRole) {
    const { workspaceId, role } = await authz.check(user, 'wikiPage', pageId, minRole);
    if (role !== 'OWNER') {
      const access = await forWorkspace(user, workspaceId);
      if (!access.canSee(pageId)) throw notFound();
    }
    return { workspaceId, role };
  }

  return { forWorkspace, checkPage };
}
