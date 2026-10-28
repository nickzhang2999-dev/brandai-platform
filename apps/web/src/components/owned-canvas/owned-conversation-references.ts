import { StudioConversationReference, resolveGenerationSize, type StudioConversationDraftInput } from "@brandai/contracts";
import { ownedImageName, type OwnedCanvasDocument } from "../../lib/owned-canvas-model";
import { getSceneFlags } from "../../lib/owned-canvas-operations";
import { parseStudioConversationIntent } from "../../lib/studio-conversation-intent";
import type { PersistentImage } from "./owned-editor-api";

/** Receipts may normalize object keys. Only ordered arrays carry semantic order. */
export function ownedConversationDraftEqual(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value;
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

/** Resolve a canvas selection to persisted receipts; this never submits work. */
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

export function requireOwnedConversationTargetEditable(state: { ready: boolean; readOnly: boolean; submitting: boolean; uncertain: boolean }) {
  if (!state.ready) throw new Error("对话还在恢复，恢复完成后再选择修改对象。");
  if (state.readOnly) throw new Error("当前项目只读，不能更换修改对象。");
  if (state.submitting) throw new Error("本轮正在提交，修改对象已固定；提交确认后再选择下一张。");
  if (state.uncertain) throw new Error("上次提交结果尚未确认，请先检查原任务；现在不能更换修改对象。");
}

/** Only an automatically added target is removed when switching targets.
 * Independently selected references (including a promoted reference) survive.
 * On restored drafts ownership is unknown: preserve references conservatively. */
export function chooseOwnedConversationTarget(
  current: Pick<StudioConversationDraftInput, "references" | "quickEditTargetId">,
  reference: StudioConversationReference | null,
  ownedTargetId: string | null,
) {
  const chosen = reference ? StudioConversationReference.parse(reference) : null;
  if (chosen && !chosen.shapeId) throw new Error("请先把这张素材放入画布，再设为修改对象。");
  const existing = chosen ? current.references.find(value => value.assetId === chosen.assetId) : undefined;
  if (chosen?.purpose === "EXACT" || existing?.purpose === "EXACT") throw new Error("这张图片设置了严格保留，不能直接改为修改对象；请先在素材用途里明确调整规则。");
  if (chosen && existing && (chosen.assetSha256 !== existing.assetSha256 || chosen.versionId && existing.versionId && chosen.versionId !== existing.versionId)) throw new Error("这张图片的保存版本已变化，请先核对原引用后再选择；原引用未改动。");
  const references = current.references.filter(value => !(value.referenceId === current.quickEditTargetId && value.referenceId === ownedTargetId && value.purpose === "REFERENCE")).map(value => ({ ...value }));
  if (!chosen) return { references, quickEditTargetId: null, ownedTargetId: null };
  const target = existing ? { ...chosen, purpose: existing.purpose, ...(chosen.versionId ?? existing.versionId ? { versionId: chosen.versionId ?? existing.versionId } : {}) } : { ...chosen };
  const index = references.findIndex(value => value.assetId === target.assetId);
  if (index >= 0) references[index] = target; else references.push(target);
  if (references.length > 8) throw new Error("本轮最多使用 8 张图片，请先明确移除一张参考图；已有参考不会自动删除。");
  if (new Set(references.map(value => value.referenceId)).size !== references.length) throw new Error("图片引用标识发生冲突，请重新读取素材。");
  return { references, quickEditTargetId: target.referenceId,
    ownedTargetId: !existing || existing.referenceId === ownedTargetId ? target.referenceId : null };
}

/** Preview the exact existing rules, without an API/model call or changing the
 * accepted request. The structured planner and server still validate submission. */
export function ownedConversationSizePreview(draft: Omit<StudioConversationDraftInput, "revision">, outputFrameId?: string) {
  try {
    if (!draft.text.trim()) {
      const target = draft.references.find(value => value.referenceId === draft.quickEditTargetId);
      const size = target ?? resolveGenerationSize(draft.sizeSelection);
      return { source: target ? "target" : "control", text: `${target ? "修改默认保留原图" : "下拉默认"}：${size.width} × ${size.height} 像素` };
    }
    const intent = parseStudioConversationIntent({ ...draft, mutationId: "00000000-0000-4000-8000-000000000000", documentRevision: 0, workflowRevision: 0,
      ...(outputFrameId ? { outputFrameId } : {}) });
    if (!intent.requestedSize) return { source: "clarify", text: `发送前待确认：${intent.clarification ?? "请明确需求和尺寸。"}` };
    const labels = { "dialog-pixels": "文字指定像素", "dialog-ratio": "文字指定比例 / 清晰度", control: "下拉默认", target: "保留修改对象原图", default: "默认尺寸" };
    return { source: intent.sizeSource, text: `${labels[intent.sizeSource]}：${intent.requestedSize.width} × ${intent.requestedSize.height} 像素` };
  } catch { return { source: "clarify", text: "当前尺寸无效，请检查比例、清晰度和自定义宽高。" }; }
}
