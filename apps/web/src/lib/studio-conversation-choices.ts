import { StudioConversationIntent, type StudioConversationInput } from "@brandai/contracts";
import { parseStudioConversationIntent, studioConversationNonActionable } from "./studio-conversation-intent";
import { studioConversationFeedback } from "./studio-conversation-feedback";

export type ConversationOption = NonNullable<StudioConversationIntent["options"]>[number];

export function requireExactConversationReferences(input: StudioConversationInput, target: string | null, referenceIds: string[]) {
  if (input.references.some(ref => ref.purpose === "EXACT" && ref.referenceId !== target && !referenceIds.includes(ref.referenceId)))
    throw new Error("Planner omitted a strict preservation reference");
}

/** A rewrite may clarify language, but must not replace literal poster copy. */
export function validateConversationRewrite(text: string, prompt: string) {
  const literals = [...text.matchAll(/“([^”]+)”|"([^"]+)"|「([^」]+)」|『([^』]+)』|‘([^’]+)’/g)].map(match => match.slice(1).find(Boolean)!);
  if (literals.some(value => !prompt.includes(value))) throw new Error("Rewritten prompt changed literal copy");
  return prompt;
}

export function intentFromConversationOption(input: StudioConversationInput, option: ConversationOption) {
  requireExactConversationReferences(input, option.targetReferenceId, option.referenceIds);
  const allowed = new Set(input.references.map(ref => ref.referenceId));
  if (option.referenceIds.some(id => !allowed.has(id)) || option.referenceIds.includes(option.targetReferenceId ?? "")
    || option.action === "modify" && !input.references.some(ref => ref.referenceId === option.targetReferenceId && ref.shapeId)) throw new Error("Invalid conversation option target");
  const base = parseStudioConversationIntent({ ...input, quickEditTargetId: option.action === "modify" ? option.targetReferenceId : null }, undefined, option);
  if (base.action === "clarify") return base;
  return StudioConversationIntent.parse({ ...base, referenceIds: option.referenceIds, imagePrompt: validateConversationRewrite(input.text, option.imagePrompt) });
}

function candidates(input: StudioConversationInput): ConversationOption[] {
  const refs = [...input.references].sort((a, b) => Number(input.selectedReferenceIds?.includes(b.referenceId)) - Number(input.selectedReferenceIds?.includes(a.referenceId)));
  return [{ id: "new-image", label: "生成新图", action: "generate" as const, targetReferenceId: null,
    referenceIds: input.references.map(ref => ref.referenceId), imagePrompt: input.text },
  ...refs.filter(ref => ref.shapeId).slice(0, 2).map(ref => ({ id: `edit-${input.references.indexOf(ref)}`, label: `修改${ref.name}`.slice(0, 80), action: "modify" as const,
    targetReferenceId: ref.referenceId, referenceIds: input.references.filter(other => other !== ref).map(other => other.referenceId), imagePrompt: input.text }))];
}

/** UI options never bypass server dimensions/EXACT/target checks, nor turn a
 * question or an uncertain paid request into a second paid call. */
export function conversationChoiceOptions(input: StudioConversationInput, intent: StudioConversationIntent, correction = false) {
  if (intent.modelStatus === "UNKNOWN" || studioConversationNonActionable(input) || studioConversationFeedback(input)) return [];
  return candidates(input).filter(option => (!correction || option.action !== intent.action)
    && (correction || !input.quickEditTargetId || option.action === "modify" && option.targetReferenceId === input.quickEditTargetId)
    && intentFromConversationOption(input, option).action !== "clarify");
}

export function withConversationChoices(input: StudioConversationInput, intent: StudioConversationIntent) {
  if (intent.modelStatus === "UNKNOWN") return StudioConversationIntent.parse({ ...intent, options: [], correctionOptions: [] });
  if (intent.action === "clarify") return StudioConversationIntent.parse({ ...intent,
    options: intent.options?.length ? intent.options : conversationChoiceOptions(input, intent), correctionOptions: [] });
  return StudioConversationIntent.parse({ ...intent, options: [], correctionOptions: conversationChoiceOptions(input, intent, true) });
}
