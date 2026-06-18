import { prisma, type Prisma } from "@brandai/db";
import { ActivityResponse, type ActivityRow } from "@brandai/contracts";
import { handleError, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/admin";

/**
 * §2.3 · GET /api/admin/activity?limit=&cursor=&kind=&status=&hasImage=
 *
 * Admin-global, per-request AI activity log over `UsageLog` (one row per AI
 * call: generate / compliance / recognize / parse-manual / edit). Headline
 * info is TIME (latencyMs), TOKENS (totalTokens, best-effort) and "did an
 * image come back?" (imageCount > 0 + a thumbnail resolved from the soft
 * generationId reference).
 *
 * Filters (all optional, AND-combined):
 *   kind=GENERATE,EDIT       — comma list of kinds
 *   status=SUCCEEDED|FAILED
 *   hasImage=1|0             — imageCount > 0 vs == 0
 *
 * Pagination: Prisma id-cursor (orderBy [createdAt desc, id desc], cursor by
 * the last returned id, skip 1) — exact and tie-safe.
 */
export async function GET(req: Request) {
  try {
    await requireAdmin();
    const url = new URL(req.url);
    const raw = Number(url.searchParams.get("limit") ?? "50");
    const limit =
      Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 200) : 50;
    const cursor = url.searchParams.get("cursor");

    // --- filters ---
    const where: Prisma.UsageLogWhereInput = {};
    const kindParam = url.searchParams.get("kind");
    if (kindParam) {
      const kinds = kindParam.split(",").map((k) => k.trim()).filter(Boolean);
      if (kinds.length) where.kind = { in: kinds };
    }
    const statusParam = url.searchParams.get("status");
    if (statusParam === "SUCCEEDED" || statusParam === "FAILED") {
      where.status = statusParam;
    }
    const hasImage = url.searchParams.get("hasImage");
    if (hasImage === "1") where.imageCount = { gt: 0 };
    else if (hasImage === "0") where.imageCount = { lte: 0 };

    const rows = await prisma.usageLog.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    // Resolve one thumbnail per distinct generationId (soft ref → first
    // version's imageUrl). Batched so the page costs one extra query, not N.
    const genIds = [
      ...new Set(rows.map((r) => r.generationId).filter(Boolean) as string[]),
    ];
    const thumbByGen = new Map<string, string>();
    if (genIds.length) {
      const versions = await prisma.generationVersion.findMany({
        where: { generationId: { in: genIds } },
        orderBy: { index: "asc" },
        select: { generationId: true, imageUrl: true },
      });
      for (const v of versions) {
        if (!thumbByGen.has(v.generationId)) {
          thumbByGen.set(v.generationId, v.imageUrl);
        }
      }
    }

    const items: ActivityRow[] = rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      kind: r.kind,
      status: r.status as ActivityRow["status"],
      provider: r.provider ?? undefined,
      model: r.model ?? undefined,
      size: r.size ?? undefined,
      imageCount: r.imageCount,
      costUsd: r.costUsd ?? undefined,
      latencyMs: r.latencyMs ?? undefined,
      totalTokens: r.totalTokens ?? undefined,
      workspaceId: r.workspaceId,
      imageUrl: r.generationId
        ? thumbByGen.get(r.generationId) ?? undefined
        : undefined,
    }));
    const nextCursor =
      rows.length === limit ? rows[rows.length - 1]!.id : null;

    return ok(ActivityResponse.parse({ rows: items, nextCursor }));
  } catch (err) {
    return handleError(err);
  }
}
