import { prisma } from "@brandai/db";
import type { WorkspaceRole } from "@brandai/contracts";
import { ApiException } from "@/lib/api";

/** Role rank for `requireWorkspaceRole` comparisons (higher = more access). */
const ROLE_RANK: Record<string, number> = {
  OWNER: 3,
  EDITOR: 2,
  REVIEWER: 1,
  VIEWER: 0,
};

/**
 * G6 — a user's effective role in a workspace: OWNER if they own it, else their
 * Membership.role, else null (no access). The owner is always OWNER even if a
 * Membership row is missing.
 */
export async function getWorkspaceRole(
  workspaceId: string,
  userId: string,
): Promise<WorkspaceRole | null> {
  const ws = await prisma.brandWorkspace.findUnique({
    where: { id: workspaceId },
    select: { ownerId: true },
  });
  if (!ws) return null;
  if (ws.ownerId === userId) return "OWNER";
  const m = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { role: true },
  });
  return (m?.role as WorkspaceRole) ?? null;
}

/**
 * Member-aware access gate. Any member (owner OR a Membership) may use the
 * workspace; non-members get 404 (ids stay non-enumerable). Kept under the
 * historical name so all existing call sites become collaboration-aware with a
 * single change. Returns the workspace row.
 */
export async function requireOwnedWorkspace(
  workspaceId: string,
  userId: string,
) {
  const workspace = await prisma.brandWorkspace.findUnique({
    where: { id: workspaceId },
  });
  if (!workspace) throw new ApiException(404, "Workspace not found");
  if (workspace.ownerId === userId) return workspace;
  const m = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { id: true },
  });
  if (!m) throw new ApiException(404, "Workspace not found");
  return workspace;
}

/**
 * Require at least `minRole` in the workspace. 404 when the caller isn't a
 * member (no enumeration), 403 when they're a member but under-privileged.
 * Returns `{ workspace, role }`.
 */
export async function requireWorkspaceRole(
  workspaceId: string,
  userId: string,
  minRole: WorkspaceRole,
) {
  const workspace = await prisma.brandWorkspace.findUnique({
    where: { id: workspaceId },
  });
  if (!workspace) throw new ApiException(404, "Workspace not found");
  let role: WorkspaceRole | null =
    workspace.ownerId === userId ? "OWNER" : null;
  if (!role) {
    const m = await prisma.membership.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
      select: { role: true },
    });
    role = (m?.role as WorkspaceRole) ?? null;
  }
  if (!role) throw new ApiException(404, "Workspace not found");
  if ((ROLE_RANK[role] ?? -1) < (ROLE_RANK[minRole] ?? 99)) {
    throw new ApiException(403, "权限不足");
  }
  return { workspace, role };
}
