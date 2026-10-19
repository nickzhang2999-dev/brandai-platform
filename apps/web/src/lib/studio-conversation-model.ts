import { StudioConversationIntent, StudioConversationModelRequest, StudioConversationModelResponse, type StudioConversationInput, type StudioConversationReference } from "@brandai/contracts";
import { parseStudioConversationIntent, studioConversationNonActionable } from "./studio-conversation-intent";
import { studioConversationFeedback } from "./studio-conversation-feedback";
import { intentFromConversationOption, requireExactConversationReferences, validateConversationRewrite, withConversationChoices } from "./studio-conversation-choices";
import type { ConversationVisualContext } from "./studio-conversation-context";
import { getEffectiveAiSettings } from "./settings";
import { ai } from "./ai";
import { resolveAiService } from "./ai-service";

export async function studioConversationModelAvailable() {
  if (process.env.STUDIO_CONVERSATION_INTENT_ENABLED !== "1") return false;
  const settings = await getEffectiveAiSettings();
  if (!settings.vlm.provider.trim() || settings.vlm.provider.trim().toLowerCase() === "mock" || !settings.vlm.apiKey.trim()) return false;
  try { await resolveAiService({ requireStudioConversationIntent: true }); return true; }
  catch { return false; }
}
export function unknownStudioConversationIntent(input: StudioConversationInput) {
  const base = parseStudioConversationIntent(input);
  return StudioConversationIntent.parse({ ...base, action: "clarify", targetReferenceId: null, referenceIds: input.references.map(ref => ref.referenceId),
    clarification: "上一份模型意图请求的结果尚未确认，系统不会自动重试或开始生图。请先检查原消息状态。", parser: "structured-model-v2", modelStatus: "UNKNOWN", options: [], correctionOptions: [] });
}
export async function resolveStudioConversationModel(input: StudioConversationInput, previous: StudioConversationReference | undefined, signal: AbortSignal, context?: ConversationVisualContext) {
  if (studioConversationNonActionable(input) || studioConversationFeedback(input)) return parseStudioConversationIntent(input, previous);
  const request = StudioConversationModelRequest.parse({ schemaVersion: 2, text: input.text,
    references: context?.references ?? input.references.map(ref => ({ referenceId: ref.referenceId, name: ref.name, editable: !!ref.shapeId })),
    history: context?.history ?? [], selectedReferenceIds: context?.selectedReferenceIds ?? input.selectedReferenceIds ?? [],
    ...(context?.lastResultImage ? { lastResultImage: context.lastResultImage } : {}),
    quickEditTargetId: input.quickEditTargetId, previousResultReferenceId: previous?.referenceId ?? null, providerRetryPolicy: "never" });
  const response = StudioConversationModelResponse.parse(await ai.studioConversationIntent(request, { signal, maxResponseBytes: 96 * 1024 }));
  if (response.revision !== "structured-conversation-intent-r2") throw new Error("Planner revision mismatch");
  const decision = response.decision, allowed = new Set(input.references.map(ref => ref.referenceId));
  if (decision.action !== "clarify") requireExactConversationReferences(input, decision.targetReferenceId, decision.referenceIds);
  if (decision.referenceIds.some(id => !allowed.has(id)) || decision.targetReferenceId !== null && !allowed.has(decision.targetReferenceId)
    || decision.referenceIds.includes(decision.targetReferenceId ?? "")
    || decision.action === "modify" && !input.references.some(ref => ref.referenceId === decision.targetReferenceId && ref.shapeId)
    || input.quickEditTargetId && decision.action !== "clarify" && (decision.action !== "modify" || decision.targetReferenceId !== input.quickEditTargetId)) throw new Error("Untrusted structured intent");
  for (const option of decision.options) {
    intentFromConversationOption(input, option);
    if (input.quickEditTargetId && (option.action !== "modify" || option.targetReferenceId !== input.quickEditTargetId)) throw new Error("Option changed pinned target");
  }
  const provenance = { parser: "structured-model-v2" as const, modelStatus: "SUCCEEDED" as const, ...(response.usage ? { modelUsage: response.usage } : {}) };
  if (decision.confidence < .8 || decision.action === "clarify") {
    const base = parseStudioConversationIntent(input);
    return withConversationChoices(input, StudioConversationIntent.parse({ ...base, ...provenance, action: "clarify", targetReferenceId: null,
      referenceIds: input.references.map(ref => ref.referenceId), clarification: decision.clarification ?? "请选择这次要生成新图，还是修改已有图片。",
      options: decision.options.filter(option => intentFromConversationOption(input, option).action !== "clarify") }));
  }
  // Semantic heuristics cannot overrule r2; server size/EXACT checks still can.
  const intent = parseStudioConversationIntent(input, previous, { action: decision.action, targetReferenceId: decision.targetReferenceId });
  if (intent.action !== "clarify") {
    intent.referenceIds = decision.referenceIds;
    intent.imagePrompt = validateConversationRewrite(input.text, decision.imagePrompt!);
  }
  return withConversationChoices(input, StudioConversationIntent.parse({ ...intent, ...provenance }));
}
