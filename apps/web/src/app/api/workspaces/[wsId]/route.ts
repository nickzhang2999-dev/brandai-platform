import { prisma } from "@brandai/db";
import { z } from "zod";
import { handleError, ok, parse, requireUser } from "@/lib/api";
import { requireOwnedWorkspace, requireWorkspaceRole } from "@/lib/workspace";

const KB_DISABLED_TAG = "__kb_disabled";

const UpdateWorkspaceInput = z.object({
  name: z.string().min(1).max(80).optional(),
  industry: z.string().max(80).optional(),
  disabled: z.boolean().optional(),
});

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

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    const { workspace } = await requireWorkspaceRole(wsId, user.id, "EDITOR");
    const input = parse(UpdateWorkspaceInput, await req.json());
    const tags = new Set(workspace.tags ?? []);
    if (input.disabled === true) tags.add(KB_DISABLED_TAG);
    if (input.disabled === false) tags.delete(KB_DISABLED_TAG);

    const updated = await prisma.brandWorkspace.update({
      where: { id: wsId },
      data: {
        ...(input.name != null ? { name: input.name } : {}),
        ...(input.industry != null ? { industry: input.industry || null } : {}),
        ...(input.disabled != null ? { tags: Array.from(tags) } : {}),
      },
    });
    return ok(updated);
  } catch (err) {
    return handleError(err);
  }
}
