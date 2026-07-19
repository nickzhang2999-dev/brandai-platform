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
    return Response.json(
      state.success ? state.data : { items: [], removedVersionIds: [] },
    );
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

    // 归属校验（多租户隔离标准 #2，Codex P2）：items 引用的 version/asset 必须
    // 属于本 workspace。跨空间注入或已失效（删除/弃用）的引用直接剔除后落库——
    // 自愈而非 400，避免一条陈旧引用把自动保存永久打死。
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
            },
            select: { id: true },
          })
        : Promise.resolve([]),
    ]);
    const versionUrlById = new Map(
      okVersionRows.map((v) => [v.id, v.imageUrl]),
    );
    const okAssets = new Set(okAssetRows.map((a) => a.id));
    const items = rawItems
      .filter((it) => {
        if (it.kind !== "image") return true;
        if (it.versionId && !versionUrlById.has(it.versionId)) return false;
        if (it.assetId && !okAssets.has(it.assetId)) return false;
        return true;
      })
      .map((it) => {
        // 归一 imageUrl（Codex P2）：id 合法但 URL 被陈旧标签页/构造保存改写时，
        // 画布显示的图与工具条/对话动作实际操作的 id 会指向两张不同的图。落库
        // 前用 DB 权威值改写——版本 tile 用行上 imageUrl，素材 tile 统一走
        // workspace 代理路径（与上传/chatContext 的口径一致）。
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
