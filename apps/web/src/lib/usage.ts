import { prisma } from "@brandai/db";
import type { AdminUsageResponse, GenerateUsage } from "@brandai/contracts";

/**
 * T-conn-b — usage/cost logging + the admin dashboard aggregation.
 *
 * `recordUsage` is best-effort: a logging failure must never sink a generation,
 * so it swallows errors. `getUsageSummary` aggregates the append-only UsageLog
 * over a recent window (default 30d), grouped by UTC day × model.
 */

export interface RecordUsageInput {
  workspaceId: string;
  userId?: string;
  kind: string; // "GENERATE" | "COMPLIANCE" | "RECOGNIZE" | "PARSE_MANUAL" | "EDIT"
  status: "SUCCEEDED" | "FAILED";
  provider?: string;
  model?: string;
  size?: string;
  imageCount?: number;
  costUsd?: number;
  latencyMs?: number;
  totalTokens?: number;
  /** Soft reference to the owning generation (no FK) so the activity log can
   *  resolve a thumbnail on read. */
  generationId?: string;
}

export async function recordUsage(input: RecordUsageInput): Promise<void> {
  try {
    await prisma.usageLog.create({
      data: {
        workspaceId: input.workspaceId,
        userId: input.userId ?? null,
        kind: input.kind,
        status: input.status,
        provider: input.provider ?? null,
        model: input.model ?? null,
        size: input.size ?? null,
        imageCount: input.imageCount ?? 0,
        costUsd: input.costUsd ?? null,
        latencyMs: input.latencyMs ?? null,
        totalTokens: input.totalTokens ?? null,
        generationId: input.generationId ?? null,
      },
    });
  } catch (err) {
    // Never let usage logging break the metered action.
    console.error("[usage] recordUsage failed:", err);
  }
}

/** Map the AI service's GenerateUsage onto recordUsage fields. */
export function fromGenerateUsage(
  u: GenerateUsage | undefined,
): Pick<
  RecordUsageInput,
  | "provider"
  | "model"
  | "size"
  | "imageCount"
  | "costUsd"
  | "latencyMs"
  | "totalTokens"
> {
  if (!u) return {};
  return {
    provider: u.provider,
    model: u.model,
    size: u.size,
    imageCount: u.imageCount,
    costUsd: u.costUsd,
    latencyMs: u.latencyMs,
    totalTokens: u.totalTokens,
  };
}

function dayUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function getUsageSummary(
  sinceDays = 30,
): Promise<AdminUsageResponse> {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
  const rows = await prisma.usageLog.findMany({
    where: { createdAt: { gte: since } },
    select: {
      status: true,
      model: true,
      imageCount: true,
      costUsd: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  // Aggregate by (UTC date, model) in JS — volume is low and date_trunc isn't
  // expressible in Prisma groupBy.
  const map = new Map<
    string,
    { date: string; model: string; calls: number; failures: number; imageCount: number; costUsd: number }
  >();
  const totals = { calls: 0, failures: 0, imageCount: 0, costUsd: 0 };

  for (const r of rows) {
    const date = dayUTC(r.createdAt);
    const model = r.model ?? "(default)";
    const key = `${date}|${model}`;
    const cell =
      map.get(key) ??
      { date, model, calls: 0, failures: 0, imageCount: 0, costUsd: 0 };
    cell.calls += 1;
    if (r.status === "FAILED") cell.failures += 1;
    cell.imageCount += r.imageCount ?? 0;
    cell.costUsd += r.costUsd ?? 0;
    map.set(key, cell);

    totals.calls += 1;
    if (r.status === "FAILED") totals.failures += 1;
    totals.imageCount += r.imageCount ?? 0;
    totals.costUsd += r.costUsd ?? 0;
  }

  const round = (n: number) => Math.round(n * 10000) / 10000;
  const out = [...map.values()]
    .map((c) => ({ ...c, costUsd: round(c.costUsd) }))
    .sort((a, b) =>
      a.date === b.date ? a.model.localeCompare(b.model) : b.date.localeCompare(a.date),
    );

  return {
    sinceDays,
    rows: out,
    totals: { ...totals, costUsd: round(totals.costUsd) },
  };
}
