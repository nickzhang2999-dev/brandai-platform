import { prisma } from "@brandai/db";
import { BrandWorkspace } from "@brandai/contracts";
import { handleError, ok, requireUser } from "@/lib/api";

/**
 * L2 / B5 / H14 · GET /api/brands/recommended
 *
 * "推荐品牌" waterfall source for the homepage. Returns REAL BrandWorkspace
 * rows the current user may see — i.e. brands they OWN or are a MEMBER of.
 * Phase-1 is a single-super-admin internal backend (1-2 brands), so this never
 * leaks other tenants' brands (multi-tenant isolation standard §1). Verified
 * brands float first; within a tier, newest first. No mock rows — an empty list
 * is returned honestly when the user has no brands yet.
 */
export async function GET() {
  try {
    const user = await requireUser();

    // Brands the user can see: owned OR has a Membership for. Both paths are
    // workspace-scoped to this user — no cross-tenant read.
    const memberships = await prisma.membership.findMany({
      where: { userId: user.id },
      select: { workspaceId: true },
    });
    const memberIds = memberships.map((m) => m.workspaceId);

    const rows = await prisma.brandWorkspace.findMany({
      where: {
        OR: [{ ownerId: user.id }, { id: { in: memberIds } }],
      },
      orderBy: [{ isVerified: "desc" }, { createdAt: "desc" }],
      take: 24,
    });

    const items = rows.map((r) =>
      BrandWorkspace.parse({
        id: r.id,
        ownerId: r.ownerId,
        name: r.name,
        industry: r.industry ?? undefined,
        websiteUrl: r.websiteUrl ?? undefined,
        createdAt: r.createdAt.toISOString(),
        subtitle: r.subtitle ?? undefined,
        description: r.description ?? undefined,
        coverImage: r.coverImage ?? undefined,
        tags: r.tags ?? undefined,
        isVerified: r.isVerified ?? undefined,
        positioning: r.positioning ?? undefined,
        targetAudience: r.targetAudience ?? undefined,
        slogan: r.slogan ?? undefined,
      }),
    );

    return ok(items);
  } catch (err) {
    return handleError(err);
  }
}
