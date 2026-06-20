import { z } from "zod";
import { prisma, Prisma } from "@brandai/db";
import { RuleStrength, RuleType } from "@brandai/contracts";
import { handleError, ok, parse, requireUser } from "@/lib/api";
import { requireOwnedWorkspace, requireWorkspaceRole } from "@/lib/workspace";

/**
 * Lightweight manual brand-rule entry (M1). Deep AI recognition is M2.
 * Always created as DRAFT. `value` shape depends on `type`
 * (e.g. { colors: string[] } for color, { fonts: string[] } for font).
 */
const CreateRuleInput = z.object({
  type: RuleType,
  strength: RuleStrength.default("WEAK"),
  summary: z.string().min(1),
  value: z.record(z.unknown()).default({}),
});

export async function GET(
  req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    await requireOwnedWorkspace(wsId, user.id);
    const url = new URL(req.url);
    const type = url.searchParams.get("type");
    const parsedType = type && RuleType.safeParse(type).success ? type : null;
    const rules = await prisma.brandRule.findMany({
      where: {
        workspaceId: wsId,
        ...(parsedType ? { type: parsedType as RuleType } : {}),
      },
      orderBy: { createdAt: "desc" },
    });
    return ok(rules);
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    await requireWorkspaceRole(wsId, user.id, "EDITOR");
    const input = parse(CreateRuleInput, await req.json());
    const rule = await prisma.brandRule.create({
      data: {
        workspaceId: wsId,
        type: input.type,
        strength: input.strength,
        status: "DRAFT",
        summary: input.summary,
        value: (input.value ?? {}) as Prisma.InputJsonValue,
        evidence: [] as Prisma.InputJsonValue,
      },
    });
    return ok(rule, { status: 201 });
  } catch (err) {
    return handleError(err);
  }
}
