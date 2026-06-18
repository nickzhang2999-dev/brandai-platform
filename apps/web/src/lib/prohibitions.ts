import { prisma } from "@brandai/db";
import type { ReferenceImage, VI } from "@brandai/contracts";

/**
 * Normalise a Prisma `ProhibitionRule` row to the contracts shape (ISO
 * timestamps, defaults applied). Mirrors `lib/rules.ts#serializeRule`.
 */
export function serializeProhibition(row: {
  id: string;
  workspaceId: string;
  severity: string;
  affectsGeneration: boolean;
  affectsValidation: boolean;
  description: string;
  scope: string[];
  positiveExampleAssetId: string | null;
  negativeExampleAssetId: string | null;
  alternativeSuggestion: string | null;
  applicableChannels: string[];
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): VI.ProhibitionRule {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    severity: row.severity as VI.ProhibitionSeverity,
    affectsGeneration: row.affectsGeneration,
    affectsValidation: row.affectsValidation,
    description: row.description,
    scope: row.scope,
    positiveExampleAssetId: row.positiveExampleAssetId ?? undefined,
    negativeExampleAssetId: row.negativeExampleAssetId ?? undefined,
    alternativeSuggestion: row.alternativeSuggestion ?? undefined,
    applicableChannels: row.applicableChannels,
    status: row.status as VI.ProhibitionStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * D5 — resolve the given asset ids to their stored URLs (`{ id → url }`).
 * Used by the generation path to turn a prohibition's positive/negative
 * example asset ids into fetchable URLs before compiling AIConstraints. Ids
 * with no matching asset are simply absent from the map.
 */
export async function loadAssetUrlMap(
  assetIds: Array<string | null | undefined>,
): Promise<Record<string, string>> {
  const ids = [...new Set(assetIds.filter((x): x is string => !!x))];
  if (ids.length === 0) return {};
  const assets = await prisma.asset.findMany({
    where: { id: { in: ids } },
    select: { id: true, url: true },
  });
  return Object.fromEntries(assets.map((a) => [a.id, a.url]));
}

/**
 * D5 — the workspace's ACTIVE prohibition example assets shaped as
 * `ReferenceImage[]` for the compliance/recognition pass (the VLM compares a
 * generated image against these). `gate` selects which prohibitions count:
 * `validation` (affectsValidation, used by visual recheck) or `generation`
 * (affectsGeneration). Returns `[]` when nothing is configured.
 */
export async function loadProhibitionReferenceImages(
  workspaceId: string,
  gate: "validation" | "generation",
): Promise<ReferenceImage[]> {
  const rows = await prisma.prohibitionRule.findMany({
    where: {
      workspaceId,
      status: "ACTIVE",
      ...(gate === "validation"
        ? { affectsValidation: true }
        : { affectsGeneration: true }),
    },
    orderBy: { createdAt: "asc" },
  });
  const urlById = await loadAssetUrlMap(
    rows.flatMap((r) => [r.positiveExampleAssetId, r.negativeExampleAssetId]),
  );
  const refs: ReferenceImage[] = [];
  for (const r of rows) {
    const note = r.description?.trim() || undefined;
    const posUrl = r.positiveExampleAssetId
      ? urlById[r.positiveExampleAssetId]
      : undefined;
    if (posUrl) {
      refs.push({
        url: posUrl,
        polarity: "positive",
        source: `prohibition:${r.id}`,
        ...(note ? { note } : {}),
      });
    }
    const negUrl = r.negativeExampleAssetId
      ? urlById[r.negativeExampleAssetId]
      : undefined;
    if (negUrl) {
      refs.push({
        url: negUrl,
        polarity: "negative",
        source: `prohibition:${r.id}`,
        ...(note ? { note } : {}),
      });
    }
  }
  return refs;
}
