import { prisma } from "@brandai/db";
import { CreateWorkspaceInput } from "@brandai/contracts";
import { handleError, ok, parse, requireUser } from "@/lib/api";

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
    return ok(workspaces);
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const input = parse(CreateWorkspaceInput, await req.json());
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
