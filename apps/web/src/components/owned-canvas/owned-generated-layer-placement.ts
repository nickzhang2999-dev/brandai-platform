import { ownedLayerIds, placeOwnedLayers, requireOwnedLayerSource } from "../../lib/owned-canvas-decomposition";
import type { OwnedCanvasDocument, OwnedCanvasItem } from "../../lib/owned-canvas-model";
import type { DecompositionTask, PersistentImage } from "./owned-editor-api";

/** Mirrors the worker identity without importing Node crypto into the browser. */
export async function generatedOwnedSourceShapeId(assetId: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(assetId)) throw new Error("生成原图标识无效。");
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(assetId)));
  return "shape:generated-" + Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("").slice(0, 40);
}

/** The automatic worker can finish before its original image is on the canvas.
 * Stage the authenticated original and every layer in one scene mutation. An
 * existing valid source is reused; already edited layer identities are replayed
 * unchanged. Ordinary manual requests never gain a missing-source bypass. */
export async function placeGeneratedOwnedLayers(document: OwnedCanvasDocument, task: DecompositionTask, workspaceId: string, source?: PersistentImage, selectedIds: string[] = []) {
  const identities = await ownedLayerIds(task.requestId, task.layers.map(layer => layer.order));
  if (identities.itemIds.some(id => document.items.some(item => item.id === id))) return placeOwnedLayers(document, task, workspaceId);
  const automaticSourceId = await generatedOwnedSourceShapeId(task.assetId);
  if (task.sourceShapeId !== automaticSourceId) return placeOwnedLayers(document, task, workspaceId);
  const candidates = document.items.filter(item => item.kind === "image" && item.assetId === task.assetId && item.assetSha256 === task.assetSha256)
    .sort((left, right) => Number(selectedIds.includes(right.id)) - Number(selectedIds.includes(left.id)) || Number(right.id === task.sourceShapeId) - Number(left.id === task.sourceShapeId));
  for (const item of candidates) {
    try { requireOwnedLayerSource(document, { ...task, sourceShapeId: item.id }); }
    catch { continue; }
    return placeOwnedLayers(document, { ...task, sourceShapeId: item.id }, workspaceId);
  }
  if (candidates.length || document.items.some(item => item.id === automaticSourceId)) throw new Error("原图片已有隐藏、锁定或不兼容修改，请先显示、解锁并恢复 100% 不透明度，避免重复插入。");
  if (!source || source.assetId !== task.assetId || source.assetSha256 !== task.assetSha256 || source.width !== task.sourceWidth || source.height !== task.sourceHeight
    || source.url !== `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(source.assetId)}/raw`) throw new Error("生成原图身份尚未核对，图层仍保存在任务中，请刷新后重试。");
  const longest = Math.max(source.width, source.height), scale = Math.min(900 / longest, Math.max(1, 100 / longest));
  const w = source.width * scale, h = source.height * scale;
  const center = { x: (360 - document.camera.x) / document.camera.zoom, y: (260 - document.camera.y) / document.camera.zoom };
  const original: OwnedCanvasItem = { id: automaticSourceId, kind: "image", x: center.x - w / 2, y: center.y - h / 2, w, h,
    rotation: 0, opacity: 1, parentId: document.pageId, assetId: source.assetId, assetSha256: source.assetSha256, url: source.url,
    ...(source.versionId ? { versionId: source.versionId } : {}) };
  return placeOwnedLayers({ ...document, items: [...document.items, original] }, task, workspaceId);
}
