import { prisma } from "@brandai/db";
import { WorkbenchSession } from "@brandai/contracts";
import { ApiException } from "./api";

/** No writes on GET. A user without a workspace explicitly creates a brand. */
export async function getWorkbenchSession(
  user: { id: string; name?: string | null },
  preferredWorkspaceId?: string,
  explicitSelection = false,
): Promise<WorkbenchSession> {
  const memberships = await prisma.membership.findMany({ where: { userId: user.id }, select: { workspaceId: true, role: true } });
  const rows = await prisma.brandWorkspace.findMany({
    where: { OR: [{ ownerId: user.id }, { id: { in: memberships.map(m => m.workspaceId) } }] },
    select: { id: true, name: true, ownerId: true }, orderBy: { createdAt: "asc" },
  });
  const roles = new Map(memberships.map(m => [m.workspaceId, m.role]));
  const workspaces = rows.map(row => ({ id: row.id, name: row.name, role: row.ownerId === user.id ? "OWNER" : roles.get(row.id) }));
  const selected = workspaces.find(w => w.id === preferredWorkspaceId);
  if (preferredWorkspaceId && !selected && explicitSelection) throw new ApiException(404, "Brand not found");
  return WorkbenchSession.parse({ user: { id: user.id, name: user.name ?? "" }, workspaces,
    activeWorkspaceId: selected?.id ?? workspaces[0]?.id ?? null });
}
