import { StudioConversationInput, type StudioConversationMessage, type StudioConversationReference, type StudioConversationOption } from "@brandai/contracts";
import type { OwnedCanvasDocument } from "../../lib/owned-canvas-model";
import { ownedConversationDraftEqual } from "./owned-conversation-references";
import { getSceneFlags } from "../../lib/owned-canvas-operations";

export type ConversationDecisionKind = "clarification" | "correction";

/** A reference is selected only if the current canvas still selects the same
 * persisted image. Adding references alone never selects them for the model. */
export function ownedConversationSelectedIds(document: OwnedCanvasDocument | null, selectedIds: readonly string[], references: readonly StudioConversationReference[]): string[] {
  if (!document) return [];
  const flags = getSceneFlags(document.items), result: string[] = [];
  for (const shapeId of selectedIds) {
    const item = document.items.find(value => value.id === shapeId);
    if (!item || item.kind !== "image" || flags.get(shapeId)?.hidden || flags.get(shapeId)?.locked) continue;
    const reference = references.find(value => value.shapeId === shapeId && value.assetId === item.assetId && value.assetSha256 === item.assetSha256);
    if (reference && !result.includes(reference.referenceId)) result.push(reference.referenceId);
  }
  return result;
}

export function ownedConversationChoices(message: StudioConversationMessage, kind: ConversationDecisionKind): StudioConversationOption[] {
  const intent = message.intent;
  if (!intent || intent.modelStatus === "UNKNOWN" || !message.originalInput) return [];
  if (kind === "clarification" ? message.status !== "CLARIFICATION" || intent.action !== "clarify"
    : message.status !== "SUCCEEDED" || !message.generation || message.generation.status !== "SUCCEEDED" || message.generation.resultState !== "READY") return [];
  return (kind === "clarification" ? intent.options : intent.correctionOptions)?.filter(option =>
    option.referenceIds.every(id => message.references.some(ref => ref.referenceId === id))
    && (option.action === "generate" ? option.targetReferenceId === null : message.references.some(ref => ref.referenceId === option.targetReferenceId && ref.shapeId))) ?? [];
}

/** Decisions replay the source message's frozen input, not the live composer.
 * New document revisions are checked by the server; no client option payload
 * can rewrite its authoritative model decision. */
export function ownedConversationDecisionInput(message: StudioConversationMessage, optionId: string, kind: ConversationDecisionKind,
  prepared: { documentRevision: number; workflowRevision: number }, mutationId: string, selectedReferenceIds: string[]) {
  if (!ownedConversationChoices(message, kind).some(option => option.id === optionId) || !message.originalInput) throw new Error("这个选项暂不可用，请检查原任务；历史需求可重新选择图片后提交。");
  const original = structuredClone(message.originalInput);
  if (original.text !== message.text || !ownedConversationDraftEqual(original.references, message.references)) throw new Error("原需求和引用信息不一致，请读取最新任务。");
  delete original.homeStart;
  return StudioConversationInput.parse({ ...original, documentRevision: prepared.documentRevision, workflowRevision: prepared.workflowRevision,
    mutationId, selectedReferenceIds, decision: { sourceMessageId: message.messageId, optionId, kind } });
}

/** A repeated explicit choice can return the already-created child message.
 * Only the same source, kind and option can acknowledge a different mutation. */
export function ownedConversationAcknowledges(input: StudioConversationInput, message: StudioConversationMessage): boolean {
  if (message.text !== input.text || !ownedConversationDraftEqual(message.references, input.references)) return false;
  if (message.originalInput?.projectContextRevision !== input.projectContextRevision) return false;
  if (message.mutationId === input.mutationId) return true;
  return Boolean(input.decision && message.intent?.modelStatus !== "UNKNOWN" && message.originalInput?.decision
    && ownedConversationDraftEqual(input.decision, message.originalInput.decision));
}
