import { prisma } from "@brandai/db";
import { VI } from "@brandai/contracts";
import { ApiException, handleError, ok, parse, requireUser } from "@/lib/api";
import { requireWorkspaceRole } from "@/lib/workspace";
import { serializeProhibition } from "@/lib/prohibitions";

async function loadRule(wsId: string, ruleId: string, userId: string) {
  await requireWorkspaceRole(wsId, userId, "EDITOR");
  const row = await prisma.prohibitionRule.findUnique({ where: { id: ruleId } });
  if (!row || row.workspaceId !== wsId) {
    throw new ApiException(404, "Prohibition rule not found");
  }
  return row;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ wsId: string; ruleId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId, ruleId } = await params;
    await loadRule(wsId, ruleId, user.id);
    const input = parse(VI.UpdateProhibitionRuleInput, await req.json());
    const row = await prisma.prohibitionRule.update({
      where: { id: ruleId },
      data: input,
    });
    return ok(serializeProhibition(row));
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ wsId: string; ruleId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId, ruleId } = await params;
    await loadRule(wsId, ruleId, user.id);
    await prisma.prohibitionRule.delete({ where: { id: ruleId } });
    return ok({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
