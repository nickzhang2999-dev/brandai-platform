import { prisma, Prisma } from "@brandai/db";
import { UpdateRuleInput, VI } from "@brandai/contracts";
import { ApiException, handleError, ok, parse, requireUser } from "@/lib/api";
import { requireWorkspaceRole } from "@/lib/workspace";
import { serializeRule } from "@/lib/rules";

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
    const existing = await loadRule(wsId, ruleId, user.id);

    const input = parse(UpdateRuleInput, await req.json());

    let structured: Prisma.InputJsonValue | undefined;
    if (input.structured) {
      const moduleName = VI.RULE_TYPE_TO_MODULE[existing.type];
      const schema = moduleName ? VI.MODULE_BY_NAME[moduleName] : undefined;
      if (!schema) {
        throw new ApiException(
          400,
          `no VI module bound to rule type '${existing.type}'`,
        );
      }
      const parsed = schema.safeParse({
        ...input.structured,
        module: moduleName,
      });
      if (!parsed.success) {
        throw new ApiException(400, "Invalid structured payload", {
          issues: parsed.error.issues,
        });
      }
      structured = parsed.data as unknown as Prisma.InputJsonValue;
    }

    const updated = await prisma.brandRule.update({
      where: { id: ruleId },
      data: {
        ...(input.status ? { status: input.status } : {}),
        ...(input.strength ? { strength: input.strength } : {}),
        ...(input.summary ? { summary: input.summary } : {}),
        ...(input.value
          ? { value: input.value as Prisma.InputJsonValue }
          : {}),
        ...(structured !== undefined ? { structured } : {}),
      },
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
    await prisma.brandRule.delete({ where: { id: ruleId } });
    return ok({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
