import type { DecompositionTask } from "./owned-editor-api";

export const LAYER_COMPARISON_TIMEOUT_MS = 25_000;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_LAYER_PIXELS = 40_000_000;
const MAX_PREVIEW_EDGE = 1024;
export type LayerComparisonImages = {
  source: ImageBitmap; layers: { assetId: string; bitmap: ImageBitmap }[];
  width: number; height: number; dispose(): void;
};

function aborted(signal: AbortSignal) { if (signal.aborted) throw new DOMException("Comparison cancelled", "AbortError"); }
export function ownedLayerComparisonPlan(task: DecompositionTask, workspaceId: string, projectId: string) {
  const raw = (id: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(id)}/raw`;
  const validId = (id: string) => /^[A-Za-z0-9_-]{1,128}$/.test(id);
  const validSha = (sha: string) => /^[a-f0-9]{64}$/.test(sha);
  if (!validId(workspaceId) || !validId(projectId) || task.projectId !== projectId || task.status !== "SUCCEEDED"
    || !validId(task.assetId) || !validSha(task.assetSha256) || task.layers.length < 2 || task.layers.length > 10)
    throw new Error("对照任务与当前项目不一致，请重新读取任务。");
  const { sourceWidth: width, sourceHeight: height } = task;
  if (![width, height].every(value => Number.isInteger(value) && value > 0 && value <= 16384)
    || width * height * task.layers.length > MAX_LAYER_PIXELS)
    throw new Error("图片超出对照预览的内存预算，可下载 PSD 查看，原图仍保留。");
  const layers = [...task.layers].sort((a, b) => a.order - b.order);
  if (layers.some((layer, index) => layer.order !== index || layer.width !== width || layer.height !== height
    || !validId(layer.assetId) || !validSha(layer.assetSha256) || layer.url !== raw(layer.assetId))
    || new Set(layers.map(layer => layer.assetId)).size !== layers.length)
    throw new Error("图层来源、尺寸或顺序不完整，请重新读取任务。");
  const scale = Math.min(1, MAX_PREVIEW_EDGE / Math.max(width, height));
  return { sourceUrl: raw(task.assetId), layers, width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Bound the encoded response too: a missing/misleading Content-Length must not
 * let a stalled or oversized image fill browser memory. No external URL is used. */
async function imageBytes(response: Response, signal: AbortSignal) {
  if (!response.ok || !/^image\/(png|jpeg|webp)(?:;|$)/i.test(response.headers.get("content-type") ?? ""))
    throw new Error("对照图片暂时无法读取，请重试；原图和已保存图层不受影响。");
  if (Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES || !response.body)
    throw new Error("对照图片过大或响应不完整，可下载 PSD 查看。");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      aborted(signal);
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_IMAGE_BYTES) throw new Error("对照图片超过读取预算，可下载 PSD 查看。");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  aborted(signal);
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** Decode one native image at a time and retain only bounded preview bitmaps.
 * Caller owns cancellation/deadline and must dispose on close, retry or switch. */
export async function loadOwnedLayerComparison(task: DecompositionTask, workspaceId: string, projectId: string, userId: string, signal: AbortSignal): Promise<LayerComparisonImages> {
  const plan = ownedLayerComparisonPlan(task, workspaceId, projectId), images: ImageBitmap[] = [];
  let totalBytes = 0;
  const dispose = () => { for (const bitmap of images) bitmap.close(); images.length = 0; };
  async function load(url: string, sha: string) {
    aborted(signal);
    const response = await fetch(url, { signal, credentials: "same-origin", cache: "no-store", redirect: "error", headers: { "X-Novart-User": userId } });
    const bytes = await imageBytes(response, signal);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error("对照图片超过总读取预算，可下载 PSD 查看。");
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), value => value.toString(16).padStart(2, "0")).join("");
    aborted(signal);
    if (digest !== sha) throw new Error("对照图片与保存版本不一致，请重新读取任务；原图未改动。");
    const native = await createImageBitmap(new Blob([bytes]));
    let preview: ImageBitmap | null = null;
    try {
      aborted(signal);
      if (native.width !== task.sourceWidth || native.height !== task.sourceHeight)
        throw new Error("对照图片尺寸与保存版本不一致，请重新读取任务。");
      preview = await createImageBitmap(native, { resizeWidth: plan.width, resizeHeight: plan.height, resizeQuality: "high" });
      aborted(signal);
      images.push(preview); return preview;
    } catch (error) { preview?.close(); throw error; }
    finally { native.close(); }
  }
  try {
    const source = await load(plan.sourceUrl, task.assetSha256), layers = [];
    for (const layer of plan.layers) layers.push({ assetId: layer.assetId, bitmap: await load(layer.url, layer.assetSha256) });
    aborted(signal);
    return { source, layers, width: plan.width, height: plan.height, dispose };
  } catch (error) { dispose(); throw error; }
}
