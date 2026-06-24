import { prisma } from "@brandai/db";
import type { BrandRule } from "@brandai/contracts";

/**
 * The workspace's confirmed brand rule library (M2 output, read by M3).
 *
 * Returns every `BrandRule` with `status = CONFIRMED` for the workspace,
 * shaped to the frozen `@brandai/contracts` `BrandRule` schema (dates
 * serialised to ISO strings, `evidence` always an array). M3 should call
 * this to assemble generation parameters — do not read the table directly.
 * Newer revisions are emitted first so newly enabled content takes precedence
 * when the generation prompt is assembled.
 *
 * @param workspaceId owning workspace id (callers must enforce ownership)
 */
export async function getConfirmedRules(
  workspaceId: string,
): Promise<BrandRule[]> {
  const rows = await prisma.brandRule.findMany({
    where: { workspaceId, status: "CONFIRMED" },
    orderBy: { updatedAt: "desc" },
  });
  return rows.map(serializeRule);
}

/** Normalise a Prisma BrandRule row to the contracts BrandRule shape. */
export function serializeRule(row: {
  id: string;
  workspaceId: string;
  type: string;
  strength: string;
  status: string;
  summary: string;
  value: unknown;
  structured?: unknown;
  evidence: unknown;
  createdAt: Date;
  updatedAt: Date;
}): BrandRule & { structured?: Record<string, unknown> | null } {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    type: row.type as BrandRule["type"],
    strength: row.strength as BrandRule["strength"],
    status: row.status as BrandRule["status"],
    summary: row.summary,
    value: (row.value ?? {}) as BrandRule["value"],
    // P1.1 — return strong-typed payload alongside legacy `value`. Frozen
    // contract doesn't declare it, but additional keys are forward-compatible.
    structured: (row.structured ?? null) as Record<string, unknown> | null,
    evidence: (Array.isArray(row.evidence)
      ? row.evidence
      : []) as BrandRule["evidence"],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
