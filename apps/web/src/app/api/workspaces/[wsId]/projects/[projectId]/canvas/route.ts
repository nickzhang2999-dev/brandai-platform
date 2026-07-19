import { prisma, Prisma } from "@brandai/db";
import { CanvasStateSchema, UpsertCanvasInputSchema } from "@brandai/contracts";
import { ApiException, handleError, parse, requireUser } from "@/lib/api";
import { requireWorkspaceRole } from "@/lib/workspace";
import { getProject } from "@/lib/generations";

/**
 * V0.0.13d · 工作台画布服务端持久化（对齐 prd_agent image_master_canvases）。
 * GET  = 恢复画布（items + camera + removedVersionIds）；无记录返回空态。
 * PUT  = 整份状态 upsert（last-writer-wins；只存引用与布局，data:/blob: 被契约拒绝）。
 * 纯 DB 读写、无慢调用（§2 天然满足）；workspace 归属 + project IDOR 双守卫。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 归属校验 + URL 归一（GET/PUT 共用，Codex P2）：items 引用的 version/asset
 * 必须现存且属于本 Campaign（版本）/本 workspace（素材，未弃用）。跨空间注入、
 * 已失效（删除/弃用/regenerate dropStaleRoots 清掉的旧根版本）的引用直接剔除
 * ——写侧防注入自愈，读侧防「恢复出工具条/对话动作解析不了的死 tile」（存量
 * 死引用可能停留到下一次无关自动保存才被 PUT 过滤）。imageUrl 一律以 DB 权威
 * 值改写，杜绝「显示一张图、操作另一张」。
 */
async function filterAndNormalizeCanvasItems<
  T extends {
    kind: string;
    versionId?: string | null;
    assetId?: string | null;
    imageUrl?: string;
  },
>(wsId: string, projectId: string, rawItems: T[]): Promise<T[]> {
  const versionIds = new Set<string>();
  const assetIds = new Set<string>();
  for (const it of rawItems) {
    if (it.kind !== "image") continue;
    if (it.versionId) versionIds.add(it.versionId);
    if (it.assetId) assetIds.add(it.assetId);
  }
  const [okVersionRows, okAssetRows] = await Promise.all([
    versionIds.size > 0
      ? prisma.generationVersion.findMany({
          where: {
            id: { in: [...versionIds] },
            // 画布按 Campaign 归属：版本 tile 必须属于本项目的 generation，
            // 只卡 workspace 拦不住陈旧标签页/构造保存把 A 项目的出图
            // 持久化进 B 项目画布（Codex P2）。素材是 workspace 级共享库，
            // 维持 workspace 作用域不变。
            generation: { workspaceId: wsId, projectId },
          },
          select: { id: true, imageUrl: true },
        })
      : Promise.resolve([]),
    assetIds.size > 0
      ? prisma.asset.findMany({
          where: {
            id: { in: [...assetIds] },
            workspaceId: wsId,
            deprecatedAt: null,
            // 只收图片素材（Codex P2）：PDF/VI_DOC 等非图片素材经陈旧/构造
            // 保存落进画布后，<img> 渲染裂图、点选提交又被 /generations 的
            // mimeType image/ 闸拒掉——留下无法使用的服务端权威 tile。与
            // 对话 chip 校验同口径在源头剔除。
            mimeType: { startsWith: "image/" },
          },
          select: { id: true },
        })
      : Promise.resolve([]),
  ]);
  const versionUrlById = new Map(okVersionRows.map((v) => [v.id, v.imageUrl]));
  const okAssets = new Set(okAssetRows.map((a) => a.id));
  return rawItems
    .filter((it) => {
      if (it.kind !== "image") return true;
      if (it.versionId && !versionUrlById.has(it.versionId)) return false;
      if (it.assetId && !okAssets.has(it.assetId)) return false;
      return true;
    })
    .map((it) => {
      if (it.kind !== "image") return it;
      if (it.versionId) {
        const url = versionUrlById.get(it.versionId);
        return url && url !== it.imageUrl ? { ...it, imageUrl: url } : it;
      }
      if (it.assetId) {
        const url = `/api/workspaces/${wsId}/assets/${it.assetId}/raw`;
        return url !== it.imageUrl ? { ...it, imageUrl: url } : it;
      }
      return it;
    });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ wsId: string; projectId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId, projectId } = await params;
    await requireWorkspaceRole(wsId, user.id, "VIEWER");
    const project = await getProject(wsId, projectId);
    if (!project) throw new ApiException(404, "Project not found");

    const row = await prisma.projectCanvas.findUnique({
      where: { projectId },
    });
    if (!row || row.workspaceId !== wsId) {
      return Response.json({ items: [], removedVersionIds: [] });
    }
    // 出参也过契约：DB 里的历史脏数据（若有）被归一而不是原样外泄。
    const state = CanvasStateSchema.safeParse({
      items: row.items,
      camera: row.camera ?? undefined,
      removedVersionIds: row.removedVersionIds,
    });
    if (!state.success) {
      return Response.json({ items: [], removedVersionIds: [] });
    }
    // 读侧同一道归属/存活校验（Codex P2）：存盘后被删除的版本（如 regenerate
    // 的 dropStaleRoots）会让画布恢复出无法操作的死 tile。只过滤响应、不回写
    // 存储——GET 对 VIEWER 开放，读操作不做写；剪掉的引用由下一次 PUT 落库。
    const items = await filterAndNormalizeCanvasItems(
      wsId,
      projectId,
      state.data.items,
    );
    return Response.json({ ...state.data, items });
  } catch (e) {
    return handleError(e);
  }
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ wsId: string; projectId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId, projectId } = await params;
    await requireWorkspaceRole(wsId, user.id, "EDITOR");
    const project = await getProject(wsId, projectId);
    if (!project) throw new ApiException(404, "Project not found");

    const body = parse(UpsertCanvasInputSchema, await req.json());
    const rawItems = body.items ?? [];

    // 写侧归属校验 + 归一（多租户隔离标准 #2，Codex P2）：剔除而非 400，
    // 避免一条陈旧引用把自动保存永久打死。逻辑与 GET 共用一口井。
    const items = await filterAndNormalizeCanvasItems(wsId, projectId, rawItems);

    const data = {
      workspaceId: wsId,
      items: items as object[],
      camera: body.camera ?? Prisma.JsonNull,
      removedVersionIds: body.removedVersionIds,
    };
    await prisma.projectCanvas.upsert({
      where: { projectId },
      create: { projectId, ...data },
      update: data,
    });
    return Response.json({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}
