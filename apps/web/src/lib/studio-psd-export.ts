import { z } from "zod";
import { prisma } from "@brandai/db";
import { StudioDecompositionLayer } from "../../../../packages/contracts/src/studio-decomposition";
import { ApiException } from "./api";
import { requireWorkspaceRole } from "./workspace";
import { readStudioLayerAsset } from "./studio-decomposition";
import { assertStudioPsdBudget, encodeStudioPsd, STUDIO_PSD_DEADLINE_MS, StudioPsdEncodingError } from "./studio-psd-codec";

const identity = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
// The image/memory budget is per process, including decoding, not just the
// writer thread. Concurrent large exports fail promptly rather than queue RAM.
let exporting = false;

export async function exportStudioDecompositionPsd(
  workspaceId: string, userId: string, projectId: string, requestId: string, callerSignal: AbortSignal,
) {
  z.object({ workspaceId: identity, userId: identity, projectId: identity, requestId: identity }).parse({ workspaceId, userId, projectId, requestId });
  await requireWorkspaceRole(workspaceId, userId, "VIEWER");
  const [user, project, row] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { isActive: true } }),
    prisma.project.findFirst({ where: { id: projectId, workspaceId }, select: { id: true } }),
    prisma.studioDecompositionRequest.findFirst({ where: { id: requestId, workspaceId, projectId }, select: {
      id: true, status: true, sourceWidth: true, sourceHeight: true, publishedLayers: true,
    } }),
  ]);
  if (!user?.isActive) throw new ApiException(403, "账号已被停用。");
  if (!project || !row) throw new ApiException(404, "当前项目的分层任务不存在。");
  if (row.status !== "SUCCEEDED") throw new ApiException(409, "图层尚未全部保存，暂不能下载可编辑 PSD。原图片仍保留。");
  const parsed = z.array(StudioDecompositionLayer).min(2).max(10).safeParse(row.publishedLayers);
  if (!parsed.success || parsed.data.some((layer, index) => layer.order !== index || layer.width !== row.sourceWidth || layer.height !== row.sourceHeight
    || layer.assetId !== `sdl_${row.id}_${index}` || layer.url !== `/api/workspaces/${workspaceId}/assets/${layer.assetId}/raw`)) {
    throw new ApiException(422, "图层回执不完整，未将整图或部分图层冒充可编辑 PSD。");
  }
  const layers = parsed.data;
  const assets = await prisma.asset.findMany({ where: { id: { in: layers.map(layer => layer.assetId) }, workspaceId, deprecatedAt: null,
    projectLinks: { some: { projectId, project: { workspaceId } } } }, select: { id: true, storageKey: true, mimeType: true, sizeBytes: true } });
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  if (layers.some(layer => {
    const asset = byId.get(layer.assetId);
    return !asset?.storageKey || asset.mimeType !== "image/png" || asset.sizeBytes !== layer.sizeBytes;
  })) throw new ApiException(404, "部分图层已不可用或不属于当前项目，未导出部分 PSD。");
  try { assertStudioPsdBudget(row.sourceWidth, row.sourceHeight, layers.length); }
  catch (error) { if (error instanceof StudioPsdEncodingError) throw new ApiException(error.status, error.message); throw error; }
  if (exporting) throw new ApiException(429, "另一个 PSD 正在导出，请稍后再试。");
  exporting = true;
  const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(STUDIO_PSD_DEADLINE_MS)]);
  try {
    const body = await encodeStudioPsd(row.sourceWidth, row.sourceHeight, layers, async (layer, operationSignal) => {
      const published = layers[layer.order]!;
      const asset = byId.get(published.assetId)!;
      return readStudioLayerAsset(workspaceId, { id: asset.id, storageKey: asset.storageKey! }, operationSignal);
    }, signal);
    // Recheck permissions after bounded I/O: membership/account revocation
    // during export must not hand out the prepared private document.
    await requireWorkspaceRole(workspaceId, userId, "VIEWER");
    const active = await prisma.user.findUnique({ where: { id: userId }, select: { isActive: true } });
    if (!active?.isActive) throw new ApiException(403, "账号已被停用。");
    signal.throwIfAborted();
    return { body, fileName: `Novart-layers-${requestId.slice(0, 32)}.psd`, layerCount: layers.length, width: row.sourceWidth, height: row.sourceHeight };
  } catch (error) {
    if (signal.aborted) throw new ApiException(504, "PSD 导出超时或已取消，原图与图层仍保留，请稍后重试。");
    if (error instanceof StudioPsdEncodingError) throw new ApiException(error.status, error.message);
    if (error instanceof ApiException) throw error;
    // Do not echo bucket keys, credentials or decoder errors in a download.
    throw new ApiException(503, "PSD 导出未完成，原图与图层仍保留，请稍后重试。");
  } finally { exporting = false; }
}
