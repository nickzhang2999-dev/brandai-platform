import { validateOwnedCanvasItems, type OwnedCanvasDocument, type OwnedCanvasItem } from "./owned-canvas-model";
import { getSceneFlags } from "./owned-canvas-operations";

type SourceIdentity = { sourceShapeId: string; assetId: string; assetSha256: string };
export type OwnedLayerImage = {
  assetId: string; assetSha256: string; url: string; width: number; height: number; order: number;
};
export type OwnedLayerResult = SourceIdentity & { requestId: string; status: string; layers: OwnedLayerImage[] };

/** Both intake and placement use the saved source identity, not a preview URL. */
export function requireOwnedLayerSource(document: OwnedCanvasDocument, input: SourceIdentity): OwnedCanvasItem {
  if (document.warnings.length) throw new Error("原画布有暂不兼容内容，请先保留原稿，不能提交分层。");
  const source = document.items.find(item => item.id === input.sourceShapeId);
  if (!source || source.kind !== "image" || source.parentId !== document.pageId
    || source.assetId !== input.assetId || source.assetSha256 !== input.assetSha256
    || !/^[a-f0-9]{64}$/.test(input.assetSha256)) throw new Error("原图片已变化或不属于当前画布，请重新选择图片。");
  const flags = getSceneFlags(document.items).get(source.id);
  if (!flags || flags.hidden || flags.locked) throw new Error("请先显示并解锁原图片及所在画框，再使用 AI 分层。");
  // Applying partial opacity independently to overlapping layers is not the
  // same composite as applying it once to the original flattened image.
  if (source.opacity !== 1) throw new Error("请先将原图片不透明度设为 100%，再使用 AI 分层。");
  return source;
}

export async function ownedLayerIds(requestId: string, orders: number[]) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) throw new Error("分层任务标识无效。");
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(requestId))), value => value.toString(16).padStart(2, "0")).join("");
  return { groupId: "group:layers-" + hash, itemIds: orders.map(order => "shape:layer-" + hash + "-" + order) };
}

/** One scene mutation hides the immutable source and adds all full-frame RGBA
 * layers. Repeating the insertion preserves edits to an already placed group. */
export async function placeOwnedLayers(document: OwnedCanvasDocument, result: OwnedLayerResult, workspaceId: string) {
  if (result.status !== "SUCCEEDED" || !result.layers.length || result.layers.length > 20) throw new Error("图层尚未全部保存，原图片仍保留。");
  const layers = [...result.layers].sort((a, b) => a.order - b.order);
  const orders = layers.map(layer => layer.order);
  if (new Set(orders).size !== orders.length || orders.some(order => !Number.isInteger(order) || order < 0 || order > 19)) throw new Error("图层顺序无效。");
  const width = layers[0]!.width, height = layers[0]!.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error("图层尺寸无效。");
  for (const layer of layers) {
    if (layer.width !== width || layer.height !== height || !/^[a-f0-9]{64}$/.test(layer.assetSha256)
      || !/^[A-Za-z0-9_-]{1,128}$/.test(layer.assetId)
      || layer.url !== `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(layer.assetId)}/raw`) throw new Error("图层回执不完整或不属于当前品牌。");
  }
  const { groupId, itemIds } = await ownedLayerIds(result.requestId, orders);
  const existing = itemIds.map(id => document.items.find(item => item.id === id));
  if (existing.some(Boolean)) {
    if (!existing.every((item, index) => item?.kind === "image" && item.assetId === layers[index]!.assetId && item.assetSha256 === layers[index]!.assetSha256)) throw new Error("图层组已有部分内容，请先检查现有图层，避免覆盖修改。");
    return { document, itemIds, replayed: true };
  }
  const source = requireOwnedLayerSource(document, result);
  const images: OwnedCanvasItem[] = layers.map((layer, index) => ({
    id: itemIds[index]!, kind: "image", x: source.x, y: source.y, w: source.w, h: source.h,
    rotation: source.rotation, opacity: 1, parentId: document.pageId, groupId,
    ...(source.frameId ? { frameId: source.frameId } : {}),
    ...(source.crop ? { crop: { ...source.crop } } : {}),
    ...(source.flipX !== undefined ? { flipX: source.flipX } : {}),
    ...(source.flipY !== undefined ? { flipY: source.flipY } : {}),
    assetId: layer.assetId, assetSha256: layer.assetSha256, url: layer.url,
  }));
  const index = document.items.indexOf(source);
  const items = [...document.items.slice(0, index), { ...source, hidden: true }, ...images, ...document.items.slice(index + 1)];
  validateOwnedCanvasItems(items);
  return { document: { ...document, items }, itemIds, replayed: false };
}
