// Contrôle d'accès aux objets : chaque ressource est rattachée à un espace de travail,
// et chaque action exige un rôle minimal dans cet espace.
import { forbidden, notFound, unauthorized } from './errors.js';

const RANK = { VIEWER: 1, EDITOR: 2, OWNER: 3 };

export function createAuthz(prisma) {
  async function workspaceRole(user, workspaceId) {
    if (user.role === 'ADMIN') return 'OWNER'; // l'administrateur de l'instance a tous les droits
    const m = await prisma.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId: user.id, workspaceId } },
    });
    return m?.role ?? null;
  }

  async function require(user, workspaceId, minRole) {
    if (!user) throw unauthorized();
    if (!workspaceId) throw notFound();
    const role = await workspaceRole(user, workspaceId);
    // Non-membre : 404 plutôt que 403, pour ne pas révéler l'existence de l'objet.
    if (!role) throw notFound();
    if (RANK[role] < RANK[minRole]) throw forbidden();
    return role;
  }

  // Résolution ressource -> espace de travail
  const wsOf = {
    workspace: async (id) => (await prisma.workspace.findUnique({ where: { id }, select: { id: true } }))?.id,
    board: async (id) => (await prisma.board.findUnique({ where: { id }, select: { workspaceId: true } }))?.workspaceId,
    column: async (id) => (await prisma.column.findUnique({ where: { id }, select: { board: { select: { workspaceId: true } } } }))?.board.workspaceId,
    task: async (id) => (await prisma.task.findUnique({ where: { id }, select: { column: { select: { board: { select: { workspaceId: true } } } } } }))?.column.board.workspaceId,
    subtask: async (id) => (await prisma.subTask.findUnique({ where: { id }, select: { task: { select: { column: { select: { board: { select: { workspaceId: true } } } } } } } }))?.task.column.board.workspaceId,
    comment: async (id) => (await prisma.comment.findUnique({ where: { id }, select: { task: { select: { column: { select: { board: { select: { workspaceId: true } } } } } } } }))?.task.column.board.workspaceId,
    attachment: async (id) => (await prisma.attachment.findUnique({ where: { id }, select: { task: { select: { column: { select: { board: { select: { workspaceId: true } } } } } } } }))?.task.column.board.workspaceId,
    boardField: async (id) => (await prisma.boardField.findUnique({ where: { id }, select: { board: { select: { workspaceId: true } } } }))?.board.workspaceId,
    label: async (id) => (await prisma.label.findUnique({ where: { id }, select: { board: { select: { workspaceId: true } } } }))?.board.workspaceId,
    wikiComment: async (id) => (await prisma.wikiComment.findUnique({ where: { id }, select: { page: { select: { workspaceId: true } } } }))?.page.workspaceId,
    wikiTemplate: async (id) => (await prisma.wikiTemplate.findUnique({ where: { id }, select: { workspaceId: true } }))?.workspaceId,
    wikiPage: async (id) => (await prisma.wikiPage.findUnique({ where: { id }, select: { workspaceId: true } }))?.workspaceId,
    wikiRevision: async (id) => (await prisma.wikiRevision.findUnique({ where: { id }, select: { page: { select: { workspaceId: true } } } }))?.page.workspaceId,
    wikiFile: async (id) => (await prisma.wikiFile.findUnique({ where: { id }, select: { page: { select: { workspaceId: true } } } }))?.page.workspaceId,
  };

  /** Vérifie l'accès à une ressource et renvoie { workspaceId, role }. */
  async function check(user, kind, id, minRole) {
    const workspaceId = await wsOf[kind](id);
    const role = await require(user, workspaceId, minRole);
    return { workspaceId, role };
  }

  return { workspaceRole, require, check, RANK };
}
