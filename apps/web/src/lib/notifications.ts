import { prisma } from "@brandai/db";
import type {
  NotificationItem,
  NotificationKind,
} from "@brandai/contracts";
import { BRAND_PREVIEW_PROJECT_NAME } from "./brand-preview";

/**
 * A3 / L3 — derive the in-app notification inbox from REAL server state. There
 * is no `Notification` table: notifications are projections of terminal
 * `Generation` rows (generate) and terminal `AsyncTask` rows (edit / recognize
 * / parse-manual / describe / ingest / summarize). Unread tracking is client-side (a
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
  // SUMMARIZE covers both brief-decompose (homepage 立项) and campaign AI
  // summary — both write a Campaign, so the inbox links to the Campaign list.
  SUMMARIZE: { kind: "SUMMARIZE", label: "AI 摘要", href: "/campaigns" },
  // 图层分解跑 12–110 秒，用户完全可能中途离开这一页。漏登记这一条的话，它的
  // 终态会被下面那句 `kind: { in: Object.keys(TASK_KIND_META) }` 直接滤掉——任务
  // 在服务端跑完了，收件箱里却什么都没有（§2.3 要求终态必须有通知）。
  DECOMPOSE: { kind: "DECOMPOSE", label: "图层分解", href: "/workspace" },
  STUDIO_UPLOAD: { kind: "STUDIO_UPLOAD", label: "图片上传", href: "/studio" },
};

/**
 * The most recent terminal events for a workspace, newest first, capped. Merges
 * the two real sources and sorts by terminal timestamp. `limit` bounds the
 * merged result (each source is over-fetched by `limit` then trimmed).
 */
export async function listWorkspaceNotifications(
  workspaceId: string,
  limit = 30,
  userId?: string,
): Promise<NotificationItem[]> {
  const [gens, tasks, uploads] = await Promise.all([
    prisma.generation.findMany({
      where: {
        workspaceId,
        status: { in: ["SUCCEEDED", "FAILED"] },
        // Exclude hidden D10 brand-preview runs — they use the same generate
        // pipeline but are internal, not user "出图完成" events.
        project: { name: { not: BRAND_PREVIEW_PROJECT_NAME } },
      },
      orderBy: { finishedAt: "desc" },
      take: limit,
      select: {
        id: true,
        projectId: true,
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
        // Upload tasks are private to their initiator. They are queried below
        // through the durable ownership record, never this shared task list.
        kind: { in: Object.keys(TASK_KIND_META).filter(kind => kind !== "STUDIO_UPLOAD") },
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
    userId ? prisma.studioMaterialUpload.findMany({
      where: { workspaceId, userId, task: { workspaceId, kind: "STUDIO_UPLOAD", status: { in: ["SUCCEEDED", "FAILED"] } } },
      orderBy: { task: { updatedAt: "desc" } }, take: limit,
      select: { taskId: true, projectId: true, fileName: true, task: { select: { status: true, error: true, updatedAt: true } } },
    }) : Promise.resolve([]),
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
      // E · 深链到具体那张出图 —— 点通知直接落到工作台对应 Campaign + 这次出图
      // (workspace 读 ?gen= 回填查看态),不再只停在空白工作台。
      href: `/workspace?gen=${g.id}&project=${g.projectId}`,
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

  // The staging record keeps a soft Project id for eventual object cleanup.
  // Deleted/foreign projects must not produce a misleading or unscoped link.
  const projects = uploads.length ? await prisma.project.findMany({
    where: { workspaceId, id: { in: uploads.map(upload => upload.projectId) } }, select: { id: true },
  }) : [];
  const visibleProjects = new Set(projects.map(project => project.id));
  for (const upload of uploads) {
    if (!visibleProjects.has(upload.projectId)) continue;
    const succeeded = upload.task.status === "SUCCEEDED";
    items.push({
      id: `task:${upload.taskId}`, kind: "STUDIO_UPLOAD", status: succeeded ? "SUCCEEDED" : "FAILED",
      title: succeeded ? "图片上传完成" : "图片上传失败",
      detail: succeeded ? `${upload.fileName} 已保存，可返回画布查看或加入图片。` : (upload.task.error ?? "请返回画布重新选择图片上传。"),
      href: `/canvas?workspaceId=${encodeURIComponent(workspaceId)}&projectId=${encodeURIComponent(upload.projectId)}`,
      createdAt: upload.task.updatedAt.toISOString(),
    });
  }

  items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return items.slice(0, limit);
}
