import { prisma } from "@brandai/db";
import type { MemberSummary } from "@brandai/contracts";

/**
 * G6 — list a workspace's members (owner + invited). The owner always carries
 * an OWNER Membership (created on workspace create / backfilled), so listing
 * memberships covers everyone; `isOwner` flags the row that can't be
 * demoted/removed.
 */
export async function listMembers(workspaceId: string): Promise<MemberSummary[]> {
  const [ws, rows] = await Promise.all([
    prisma.brandWorkspace.findUnique({
      where: { id: workspaceId },
      select: { ownerId: true },
    }),
    prisma.membership.findMany({
      where: { workspaceId },
      include: { user: { select: { email: true, name: true } } },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const ownerId = ws?.ownerId;
  return rows.map((m) => ({
    userId: m.userId,
    email: m.user.email,
    ...(m.user.name ? { name: m.user.name } : {}),
    role: m.role as MemberSummary["role"],
    isOwner: m.userId === ownerId,
    createdAt: m.createdAt.toISOString(),
  }));
}
