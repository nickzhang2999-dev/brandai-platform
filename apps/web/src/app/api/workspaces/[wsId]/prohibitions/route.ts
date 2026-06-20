import { prisma } from "@brandai/db";
import { VI } from "@brandai/contracts";
import { handleError, ok, parse, requireUser } from "@/lib/api";
import { requireOwnedWorkspace, requireWorkspaceRole } from "@/lib/workspace";
import {
  assertExampleAssetsInWorkspace,
  serializeProhibition,
} from "@/lib/prohibitions";

/**
 * P1.1 — Prohibition rule (禁用规范) CRUD. Distinct from word-level
 * `ComplianceTerm`: this captures rule-level constraints (visual / structural
 * / contextual) with severity, scope, channels, and positive/negative example
 * assets. Both surfaces are surfaced on the compliance page as sibling tabs.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    await requireOwnedWorkspace(wsId, user.id);
    const rows = await prisma.prohibitionRule.findMany({
      where: { workspaceId: wsId },
      orderBy: { createdAt: "desc" },
    });
    return ok(rows.map(serializeProhibition));
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
    const input = parse(VI.CreateProhibitionRuleInput, await req.json());
    await assertExampleAssetsInWorkspace(wsId, [
      input.positiveExampleAssetId,
      input.negativeExampleAssetId,
    ]);
    const row = await prisma.prohibitionRule.create({
      data: {
        workspaceId: wsId,
        severity: input.severity,
        affectsGeneration: input.affectsGeneration,
        affectsValidation: input.affectsValidation,
        description: input.description,
        scope: input.scope,
        positiveExampleAssetId: input.positiveExampleAssetId,
        negativeExampleAssetId: input.negativeExampleAssetId,
        alternativeSuggestion: input.alternativeSuggestion,
        applicableChannels: input.applicableChannels,
        status: input.status,
      },
    });
    return ok(serializeProhibition(row), { status: 201 });
  } catch (err) {
    return handleError(err);
  }
}
