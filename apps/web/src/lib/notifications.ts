import { prisma } from "@brandai/db";
import type {
  NotificationItem,
  NotificationKind,
} from "@brandai/contracts";

/**
 * A3 / L3 — derive the in-app notification inbox from REAL server state. There
 * is no `Notification` table: notifications are projections of terminal
 * `Generation` rows (generate) and terminal `AsyncTask` rows (edit / recognize
 * / parse-manual / describe / ingest). Unread tracking is client-side (a
 * localStorage `lastSeenAt` marker compared to `createdAt`), so no migration is
 * needed. Callers must enforce workspace membership before calling.
 *
 * Consistent with the §2.3 queue widget but complementary: the queue widget
 * shows LIVE in-flight progress; this inbox is the persistent TERMINAL-event
 * history (succeeded/failed) with a readable reason + a link back to the source.
 */

const SCENE_LABELS: Record<string, string> = {
  SOCIAL_POSTER: "社交海报",
  ECOM_MAIN: "电商主图",
  SCENE: "场景图",
  CAMPAIGN_KV: "Campaign KV",
  SELLING_POINT: "卖点图",
};

const TASK_KIND_META: Record<
  string,
  { kind: NotificationKind; label: string; href: string }
> = {
  EDIT: { kind: "EDIT", label: "改图", href: "/workspace" },
  RECOGNIZE: { kind: "RECOGNIZE", label: "素材识别", href: "/brand-knowledge" },
  PARSE_MANUAL: {
    kind: "PARSE_MANUAL",
    label: "VI 手册解析",
    href: "/brand-knowledge",
  },
  DESCRIBE: { kind: "DESCRIBE", label: "素材智能描述", href: "/assets" },
  INGEST: { kind: "INGEST", label: "网站素材采集", href: "/assets" },
};

/**
 * The most recent terminal events for a workspace, newest first, capped. Merges
 * the two real sources and sorts by terminal timestamp. `limit` bounds the
 * merged result (each source is over-fetched by `limit` then trimmed).
 */
export async function listWorkspaceNotifications(
  workspaceId: string,
  limit = 30,
): Promise<NotificationItem[]> {
  const [gens, tasks] = await Promise.all([
    prisma.generation.findMany({
      where: { workspaceId, status: { in: ["SUCCEEDED", "FAILED"] } },
      orderBy: { finishedAt: "desc" },
      take: limit,
      select: {
        id: true,
        status: true,
        sceneType: true,
        error: true,
        finishedAt: true,
        createdAt: true,
        _count: { select: { versions: true } },
      },
    }),
    prisma.asyncTask.findMany({
      where: {
        workspaceId,
        status: { in: ["SUCCEEDED", "FAILED"] },
        // EDIT is the only generate-adjacent task surfaced; the others are KB /
        // asset events. All five map in TASK_KIND_META.
        kind: { in: Object.keys(TASK_KIND_META) },
      },
      orderBy: { updatedAt: "desc" },
      take: limit,
      select: {
        id: true,
        kind: true,
        status: true,
        error: true,
        refCount: true,
        updatedAt: true,
      },
    }),
  ]);

  const items: NotificationItem[] = [];

  for (const g of gens) {
    const succeeded = g.status === "SUCCEEDED";
    const sceneLabel = SCENE_LABELS[g.sceneType] ?? g.sceneType;
    items.push({
      id: `gen:${g.id}`,
      kind: "GENERATE",
      status: succeeded ? "SUCCEEDED" : "FAILED",
      title: succeeded
        ? `出图完成 · ${sceneLabel}`
        : `出图失败 · ${sceneLabel}`,
      detail: succeeded
        ? g._count.versions > 0
          ? `生成 ${g._count.versions} 个变体`
          : null
        : (g.error ?? "AI 出图失败"),
      href: "/workspace",
      createdAt: (g.finishedAt ?? g.createdAt).toISOString(),
    });
  }

  for (const t of tasks) {
    const meta = TASK_KIND_META[t.kind];
    if (!meta) continue;
    const succeeded = t.status === "SUCCEEDED";
    const countNote =
      succeeded && t.refCount > 0
        ? meta.kind === "RECOGNIZE" || meta.kind === "PARSE_MANUAL"
          ? `新增 ${t.refCount} 条规则草稿`
          : null
        : null;
    items.push({
      id: `task:${t.id}`,
      kind: meta.kind,
      status: succeeded ? "SUCCEEDED" : "FAILED",
      title: succeeded ? `${meta.label}完成` : `${meta.label}失败`,
      detail: succeeded ? countNote : (t.error ?? `${meta.label}失败`),
      href: meta.href,
      createdAt: t.updatedAt.toISOString(),
    });
  }

  items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return items.slice(0, limit);
}
