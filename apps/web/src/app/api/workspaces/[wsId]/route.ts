import { prisma } from "@brandai/db";
import { handleError, ok, requireUser } from "@/lib/api";
import { requireOwnedWorkspace, requireWorkspaceRole } from "@/lib/workspace";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    const workspace = await requireOwnedWorkspace(wsId, user.id);
    const [assetCount, ruleCount, termCount, projectCount] = await Promise.all([
      prisma.asset.count({ where: { workspaceId: wsId } }),
      prisma.brandRule.count({ where: { workspaceId: wsId } }),
      prisma.complianceTerm.count({ where: { workspaceId: wsId } }),
      prisma.project.count({ where: { workspaceId: wsId } }),
    ]);
    return ok({
      workspace,
      stats: { assetCount, ruleCount, termCount, projectCount },
    });
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    await requireWorkspaceRole(wsId, user.id, "OWNER");
    await prisma.brandWorkspace.delete({ where: { id: wsId } });
    return ok({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
