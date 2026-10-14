import type { StudioConversationReference } from "@brandai/contracts";
import { ownedImageName, type OwnedCanvasDocument } from "../../lib/owned-canvas-model";
import { getSceneFlags } from "../../lib/owned-canvas-operations";
import type { PersistentImage } from "./owned-editor-api";

/** Receipts may normalize object keys. Only ordered arrays carry semantic order. */
export function ownedConversationDraftEqual(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value;
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

/** Selection alone never calls this. Explicit add freezes ordered trusted receipts. */
export function selectedOwnedConversationReferences(document: OwnedCanvasDocument, ids: readonly string[], materials: readonly PersistentImage[]): StudioConversationReference[] {
  const flags = getSceneFlags(document.items), seenAssets = new Set<string>(), result: StudioConversationReference[] = [];
  for (const id of ids) {
    const item = document.items.find(candidate => candidate.id === id);
    if (!item || item.kind !== "image" || flags.get(id)?.hidden || flags.get(id)?.locked) throw new Error("请明确选择可用的图片；隐藏或锁定图片不能加入对话。");
    const stored = materials.find(value => value.assetId === item.assetId && value.assetSha256 === item.assetSha256 && (!item.versionId || item.versionId === value.versionId));
    if (!stored) throw new Error(`${ownedImageName(item)}还未确认持久化，请读取最新素材后再加入对话。`);
    if (seenAssets.has(stored.assetId)) continue;
    seenAssets.add(stored.assetId);
    result.push({ referenceId: item.id, shapeId: item.id, name: ownedImageName(item), assetId: stored.assetId, assetSha256: stored.assetSha256,
      ...(stored.versionId ? { versionId: stored.versionId } : {}), width: stored.width, height: stored.height, purpose: "REFERENCE" });
  }
  if (result.length > 8) throw new Error("一次对话最多引用 8 张图片，请缩小选择范围。");
  return result;
}
export function mergeOwnedConversationReferences(current: readonly StudioConversationReference[], added: readonly StudioConversationReference[]): StudioConversationReference[] {
  const result = current.map(value => ({ ...value })), seen = new Set(result.map(value => value.assetId));
  for (const value of added) if (!seen.has(value.assetId)) { result.push({ ...value }); seen.add(value.assetId); }
  if (result.length > 8) throw new Error("一次对话最多引用 8 张图片，请先移除不需要的引用。");
  return result;
}
