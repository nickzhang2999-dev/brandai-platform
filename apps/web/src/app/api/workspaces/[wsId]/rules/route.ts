import { z } from "zod";
import { prisma, Prisma } from "@brandai/db";
import { RuleStrength, RuleType } from "@brandai/contracts";
import { handleError, ok, parse, requireUser } from "@/lib/api";
import { requireOwnedWorkspace, requireWorkspaceRole } from "@/lib/workspace";
import { lockBrandKnowledgeWorkspace } from "@/lib/brand-knowledge-safety";

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
    // PDF/manual evidence is not an image. Resolve authoritative MIME types in
    // the same workspace instead of trusting legacy/model-supplied metadata.
    const evidenceItems = (value: Prisma.JsonValue) =>
      Array.isArray(value) ? value.filter((item): item is Prisma.JsonObject =>
        item !== null && typeof item === "object" && !Array.isArray(item)) : [];
    const assetIds = [...new Set(rules.flatMap(rule => evidenceItems(rule.evidence)
      .flatMap(item => typeof item.assetId === "string" ? [item.assetId] : [])))];
    const assets = assetIds.length ? await prisma.asset.findMany({
      where: { workspaceId: wsId, id: { in: assetIds } },
      select: { id: true, mimeType: true },
    }) : [];
    const mimeById = new Map(assets.map(asset => [asset.id, asset.mimeType]));
    return ok(rules.map(rule => ({ ...rule, evidence: evidenceItems(rule.evidence).map(item => {
      const { mimeType: _untrustedMime, ...evidence } = item;
      const mimeType = typeof item.assetId === "string" ? mimeById.get(item.assetId) : undefined;
      return { ...evidence, ...(mimeType ? { mimeType } : {}) };
    }) })));
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
    const rule = await prisma.$transaction(async tx => {
      await lockBrandKnowledgeWorkspace(tx, wsId);
      return tx.brandRule.create({
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
    });
    return ok(rule, { status: 201 });
  } catch (err) {
    return handleError(err);
  }
}
