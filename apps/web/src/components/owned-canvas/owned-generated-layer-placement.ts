import { ownedLayerIds, placeOwnedLayers, requireOwnedLayerSource } from "../../lib/owned-canvas-decomposition";
import type { OwnedCanvasDocument, OwnedCanvasItem } from "../../lib/owned-canvas-model";
import type { DecompositionTask, PersistentImage } from "./owned-editor-api";
import { bounds } from "./geometry";
import { nextOwnedImagePosition } from "./owned-image-placement";
import { validateOwnedCanvasItems } from "../../lib/owned-canvas-model";

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
export async function placeGeneratedOwnedLayers(document: OwnedCanvasDocument, task: DecompositionTask, workspaceId: string, source?: PersistentImage, selectedIds: string[] = [], options: { besideSource?: boolean } = {}) {
  const place = async (before: OwnedCanvasDocument, result: DecompositionTask) => {
    const placed = await placeOwnedLayers(before, result, workspaceId);
    if (!options.besideSource || placed.replayed) return placed;
    const original = before.items.find(item => item.id === result.sourceShapeId)!;
    const group = placed.document.items.filter(item => placed.itemIds.includes(item.id));
    const box = bounds(group)!;
    const center = nextOwnedImagePosition(before, box.w, box.h, original.id);
    const dx = center.x - box.w / 2 - box.x, dy = center.y - box.h / 2 - box.y;
    const items = placed.document.items.map(item => {
      if (item.id === original.id) return original;
      if (!placed.itemIds.includes(item.id)) return item;
      // The comparison group is outside the original output frame.
      const { frameId: _frame, ...layer } = item;
      return { ...layer, x: item.x + dx, y: item.y + dy };
    });
    validateOwnedCanvasItems(items);
    return { ...placed, document: { ...placed.document, items } };
  };
  const identities = await ownedLayerIds(task.requestId, task.layers.map(layer => layer.order));
  if (identities.itemIds.some(id => document.items.some(item => item.id === id))) return placeOwnedLayers(document, task, workspaceId);
  const automaticSourceId = await generatedOwnedSourceShapeId(task.assetId);
  if (task.sourceShapeId !== automaticSourceId) return place(document, task);
  const candidates = document.items.filter(item => item.kind === "image" && item.assetId === task.assetId && item.assetSha256 === task.assetSha256)
    .sort((left, right) => Number(selectedIds.includes(right.id)) - Number(selectedIds.includes(left.id)) || Number(right.id === task.sourceShapeId) - Number(left.id === task.sourceShapeId));
  for (const item of candidates) {
    try { requireOwnedLayerSource(document, { ...task, sourceShapeId: item.id }); }
    catch { continue; }
    return place(document, { ...task, sourceShapeId: item.id });
  }
  if (candidates.length || document.items.some(item => item.id === automaticSourceId)) throw new Error("原图片已有隐藏、锁定或不兼容修改，请先显示、解锁并恢复 100% 不透明度，避免重复插入。");
  if (!source || source.assetId !== task.assetId || source.assetSha256 !== task.assetSha256 || source.width !== task.sourceWidth || source.height !== task.sourceHeight
    || source.url !== `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(source.assetId)}/raw`) throw new Error("生成原图身份尚未核对，图层仍保存在任务中，请刷新后重试。");
  const longest = Math.max(source.width, source.height), scale = Math.min(900 / longest, Math.max(1, 100 / longest));
  const w = source.width * scale, h = source.height * scale;
  const center = options.besideSource ? nextOwnedImagePosition(document, w, h) : { x: (360 - document.camera.x) / document.camera.zoom, y: (260 - document.camera.y) / document.camera.zoom };
  const original: OwnedCanvasItem = { id: automaticSourceId, kind: "image", x: center.x - w / 2, y: center.y - h / 2, w, h,
    rotation: 0, opacity: 1, parentId: document.pageId, assetId: source.assetId, assetSha256: source.assetSha256, url: source.url,
    ...(source.versionId ? { versionId: source.versionId } : {}) };
  return place({ ...document, items: [...document.items, original] }, task);
}
