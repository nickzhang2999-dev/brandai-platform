import { prisma } from "@brandai/db";
import { CreateWorkspaceInput } from "@brandai/contracts";
import { handleError, ok, parse, requireUser } from "@/lib/api";
import { assertCanCreateWorkspace } from "@/lib/quota";

export async function GET() {
  try {
    const user = await requireUser();
    // G6 — list workspaces the user OWNS or is a MEMBER of (collaboration).
    const memberships = await prisma.membership.findMany({
      where: { userId: user.id },
      select: { workspaceId: true },
    });
    const memberWsIds = memberships.map((m) => m.workspaceId);
    const workspaces = await prisma.brandWorkspace.findMany({
      where: {
        OR: [{ ownerId: user.id }, { id: { in: memberWsIds } }],
      },
      orderBy: { createdAt: "desc" },
    });
    // Lovart-style kit rail: the card cover is not an independently managed
    // field. It always mirrors the first (newest, matching the kit page order)
    // Logo rule image. Keep the stored cover only as a legacy fallback.
    const logoRules = workspaces.length
      ? await prisma.brandRule.findMany({
          where: {
            workspaceId: { in: workspaces.map((workspace) => workspace.id) },
            type: "logo",
          },
          orderBy: { createdAt: "desc" },
          select: { workspaceId: true, evidence: true },
        })
      : [];
    const logoAssetByWorkspace = new Map<string, string>();
    for (const rule of logoRules) {
      if (logoAssetByWorkspace.has(rule.workspaceId)) continue;
      const evidence = Array.isArray(rule.evidence) ? rule.evidence : [];
      const assetId = evidence.find(
        (item): item is { assetId: string } =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as { assetId?: unknown }).assetId === "string",
      )?.assetId;
      if (assetId) logoAssetByWorkspace.set(rule.workspaceId, assetId);
    }

    return ok(
      workspaces.map((workspace) => {
        const logoAssetId = logoAssetByWorkspace.get(workspace.id);
        return {
          ...workspace,
          coverImage: logoAssetId
            ? `/api/workspaces/${workspace.id}/assets/${logoAssetId}/raw`
            : workspace.coverImage,
        };
      }),
    );
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const input = parse(CreateWorkspaceInput, await req.json());
    // K1 — enforce the plan's maxWorkspaces (tenant cap). Unlimited (-1, the
    // default/owner/admin plan) is a no-op, so phase-1 single-brand creation is
    // untouched; only a finite plan that's already at its cap throws 402.
    await assertCanCreateWorkspace(user.id);
    const workspace = await prisma.brandWorkspace.create({
      data: {
        ownerId: user.id,
        name: input.name,
        industry: input.industry,
        websiteUrl: input.websiteUrl,
      },
    });
    // G6 — the owner is also a Membership(OWNER) so the member-aware access
    // gate + member list treat them uniformly. (Membership has no relation to
    // BrandWorkspace, so it's a separate create.)
    await prisma.membership.create({
      data: { userId: user.id, workspaceId: workspace.id, role: "OWNER" },
    });
    return ok(workspace, { status: 201 });
  } catch (err) {
    return handleError(err);
  }
}
