import { prisma, Prisma } from "@brandai/db";
import { UpdateRuleInput } from "@brandai/contracts";
import { ApiException, handleError, ok, parse, requireUser } from "@/lib/api";
import { requireWorkspaceRole } from "@/lib/workspace";
import { serializeRule } from "@/lib/rules";
import { assertRuleAssetsInWorkspace, lockBrandKnowledgeWorkspace, validatedRuleStructured } from "@/lib/brand-knowledge-safety";

async function loadRule(wsId: string, ruleId: string, userId: string) {
  await requireWorkspaceRole(wsId, userId, "EDITOR");
  const rule = await prisma.brandRule.findUnique({ where: { id: ruleId } });
  if (!rule || rule.workspaceId !== wsId) {
    throw new ApiException(404, "Rule not found");
  }
  return rule;
}

/**
 * Rule confirmation workflow (M2 core): confirm / modify / reject and set
 * strength STRONG | WEAK | FORBIDDEN. Validated with the frozen
 * `UpdateRuleInput` contract. CONFIRMED rules form the brand rule library.
 *
 * P1.1: accepts an optional `structured` payload. We validate it against the
 * VI module schema matching the rule's `type` (legacy `value` stays as
 * fallback for unknown shapes).
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ wsId: string; ruleId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId, ruleId } = await params;
    await loadRule(wsId, ruleId, user.id);

    const input = parse(UpdateRuleInput, await req.json());

    const updated = await prisma.$transaction(async tx => {
      await lockBrandKnowledgeWorkspace(tx, wsId);
      const current = await tx.brandRule.findFirst({ where: { id: ruleId, workspaceId: wsId } });
      if (!current) throw new ApiException(404, "Rule not found");
      const structured = validatedRuleStructured(current.type, input.structured);
      const data = {
        ...(input.status ? { status: input.status } : {}),
        ...(input.strength ? { strength: input.strength } : {}),
        ...(input.summary ? { summary: input.summary } : {}),
        ...(input.value ? { value: input.value as Prisma.InputJsonValue } : {}),
        ...(structured !== undefined ? { structured } : {}),
      };
      // A broken old reference must not prevent the user from disabling a rule.
      // New reference edits and any rule remaining effective still need validation.
      if ((input.status ?? current.status) === "CONFIRMED" || structured !== undefined) {
        await assertRuleAssetsInWorkspace(tx, wsId, { evidence: current.evidence, structured: structured ?? current.structured });
      }
      if (input.status === "CONFIRMED") {
        await tx.brandRule.updateMany({
          where: {
            workspaceId: wsId,
            type: current.type,
            status: "CONFIRMED",
            NOT: { id: ruleId },
          },
          data: { status: "REJECTED" },
        });
      }
      return tx.brandRule.update({ where: { id: ruleId }, data });
    });
    return ok(serializeRule(updated));
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
    await prisma.$transaction(async tx => {
      await lockBrandKnowledgeWorkspace(tx, wsId);
      const current = await tx.brandRule.findFirst({ where: { id: ruleId, workspaceId: wsId } });
      if (!current) throw new ApiException(404, "Rule not found");
      await tx.brandRule.delete({ where: { id: ruleId } });
    });
    return ok({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
