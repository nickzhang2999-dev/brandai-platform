import { prisma, Prisma } from "@brandai/db";
import { UpdateLayerSetInput } from "@brandai/contracts";
import { ApiException, handleError, ok, parse, requireUser } from "@/lib/api";
import { requireOwnedWorkspace, requireWorkspaceRole } from "@/lib/workspace";
import { isLayerVersion, serializeLayerSet } from "@/lib/layers";

/**
 * 一组图层的读写口。
 *
 * GET   — 读回这一组:每层的 URL / 序号 / 实墨包围盒 / 覆盖率 / 显隐 / 层序。
 * PATCH — 改显隐 / 不透明度 / 层序。
 *
 * 为什么摆位状态在服务端而不是画布 JSON:这些是"会被刷新、被分享、被另一台设备
 * 打开"的状态,只存客户端就是双事实源。prd_agent 那边显隐与层序在画布本地,
 * 于是出现过"面板里调过层序,导出的 PSD 却按另一个顺序排"——两个口径漂移。
 * 这里只有一个口径。
 */
async function loadSet(wsId: string, genId: string, setId: string) {
  const generation = await prisma.generation.findUnique({ where: { id: genId } });
  if (!generation || generation.workspaceId !== wsId) {
    throw new ApiException(404, "Generation not found");
  }
  const rows = await prisma.generationVersion.findMany({
    where: {
      generationId: genId,
      params: { path: ["layerSetId"], equals: setId },
    },
    select: {
      id: true,
      imageUrl: true,
      width: true,
      height: true,
      params: true,
      createdAt: true,
    },
    orderBy: { index: "asc" },
  });
  const view = serializeLayerSet(setId, genId, rows);
  if (!view) throw new ApiException(404, "Layer set not found");
  return view;
}

export async function GET(
  _req: Request,
  {
    params,
  }: { params: Promise<{ wsId: string; genId: string; setId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId, genId, setId } = await params;
    await requireOwnedWorkspace(wsId, user.id);
    return ok(await loadSet(wsId, genId, setId));
  } catch (err) {
    return handleError(err);
  }
}

export async function PATCH(
  req: Request,
  {
    params,
  }: { params: Promise<{ wsId: string; genId: string; setId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId, genId, setId } = await params;
    await requireOwnedWorkspace(wsId, user.id);
    await requireWorkspaceRole(wsId, user.id, "EDITOR");

    const input = parse(UpdateLayerSetInput, await req.json());
    const existing = await loadSet(wsId, genId, setId);
    const known = new Set(existing.layers.map((l) => l.versionId));
    for (const patch of input.layers) {
      // 跨组引用防护:只允许改本组成员,不然可以拿别的组的 versionId 混进来。
      if (!known.has(patch.versionId)) {
        throw new ApiException(400, "该图层不属于本图层组");
      }
    }

    for (const patch of input.layers) {
      const row = await prisma.generationVersion.findUnique({
        where: { id: patch.versionId },
      });
      if (!row || !isLayerVersion(row.params, setId)) continue;
      const current =
        row.params && typeof row.params === "object"
          ? (row.params as Record<string, unknown>)
          : {};
      await prisma.generationVersion.update({
        where: { id: patch.versionId },
        data: {
          params: {
            ...current,
            ...(patch.hidden !== undefined ? { layerHidden: patch.hidden } : {}),
            ...(patch.opacity !== undefined
              ? { layerOpacity: patch.opacity }
              : {}),
            ...(patch.z !== undefined ? { layerZ: patch.z } : {}),
          } as Prisma.InputJsonValue,
        },
      });
    }

    return ok(await loadSet(wsId, genId, setId));
  } catch (err) {
    return handleError(err);
  }
}
