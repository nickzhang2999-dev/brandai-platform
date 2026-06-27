import { prisma } from "@brandai/db";
import type { BrandRule } from "@brandai/contracts";

/**
 * The workspace's confirmed brand rule library (M2 output, read by M3).
 *
 * Returns every `BrandRule` with `status = CONFIRMED` for the workspace,
 * shaped to the frozen `@brandai/contracts` `BrandRule` schema (dates
 * serialised to ISO strings, `evidence` always an array). M3 should call
 * this to assemble generation parameters — do not read the table directly.
 *
 * Ordering is a deliberate, explicit choice — do NOT flip the default:
 *  - `"created"` (default, `createdAt asc`) is **deterministic** and is what
 *    snapshot freezing (`rule-snapshots`), compliance checks, export manifests
 *    and the synchronous hard-block gates depend on. A stable order keeps
 *    snapshot contents and 422 blocker lists reproducible.
 *  - `"recency"` (`updatedAt desc`) puts newly created / just re-enabled rules
 *    first so they take precedence when an **AI generation prompt** is
 *    assembled. Only the image-output paths (generate worker / brand preview)
 *    opt into this; flipping the shared default would silently re-order
 *    snapshots and compliance (V0.02 did exactly that — see docs/10 #4).
 *
 * @param workspaceId owning workspace id (callers must enforce ownership)
 * @param options.order `"created"` (deterministic, default) | `"recency"`
 *   (latest-first, generation prompt assembly only)
 */
export async function getConfirmedRules(
  workspaceId: string,
  options: { order?: "created" | "recency" } = {},
): Promise<BrandRule[]> {
  const rows = await prisma.brandRule.findMany({
    where: { workspaceId, status: "CONFIRMED" },
    orderBy:
      options.order === "recency"
        ? { updatedAt: "desc" }
        : { createdAt: "asc" },
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
