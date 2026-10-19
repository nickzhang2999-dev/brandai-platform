import { StudioConversationIntent, StudioConversationModelRequest, StudioConversationModelResponse, type StudioConversationInput, type StudioConversationReference } from "@brandai/contracts";
import { parseStudioConversationIntent, studioConversationNonActionable } from "./studio-conversation-intent";
import { studioConversationFeedback } from "./studio-conversation-feedback";
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
    clarification: "上一份模型意图请求的结果尚未确认，系统不会自动重试或开始生图。请明确图片目标和需求后重新发送。", parser: "structured-model-v1", modelStatus: "UNKNOWN" });
}
export async function resolveStudioConversationModel(input: StudioConversationInput, previous: StudioConversationReference | undefined, signal: AbortSignal) {
  if (studioConversationNonActionable(input) || studioConversationFeedback(input)) return parseStudioConversationIntent(input, previous);
  const request = StudioConversationModelRequest.parse({ schemaVersion: 1, text: input.text,
    references: input.references.map(ref => ({ referenceId: ref.referenceId, name: ref.name, editable: !!ref.shapeId })),
    quickEditTargetId: input.quickEditTargetId, previousResultReferenceId: previous?.referenceId ?? null, providerRetryPolicy: "never" });
  const response = StudioConversationModelResponse.parse(await ai.studioConversationIntent(request, { signal, maxResponseBytes: 16 * 1024 }));
  const decision = response.decision, allowed = new Set(input.references.map(ref => ref.referenceId));
  if (decision.referenceIds.some(id => !allowed.has(id)) || decision.targetReferenceId !== null && !allowed.has(decision.targetReferenceId)
    || decision.referenceIds.includes(decision.targetReferenceId ?? "")
    || decision.action === "modify" && !input.references.some(ref => ref.referenceId === decision.targetReferenceId && ref.shapeId)
    || input.quickEditTargetId && (decision.action !== "modify" || decision.targetReferenceId !== input.quickEditTargetId)) throw new Error("Untrusted structured intent");
  const continued = /(?:继续|上一张|刚才那张|上张|last\s+(?:image|result))/i.test(input.text);
  if (continued && !input.quickEditTargetId) {
    const baseline = parseStudioConversationIntent(input, previous);
    if (baseline.action === "clarify") return StudioConversationIntent.parse({ ...baseline, parser: "structured-model-v1", modelStatus: "SUCCEEDED" });
    if (previous && baseline.targetReferenceId === previous.referenceId && decision.targetReferenceId !== previous.referenceId)
      return StudioConversationIntent.parse({ ...baseline, action: "clarify", targetReferenceId: null, clarification: "上一张结果与本次目标不一致，请明确要继续修改的图片。", parser: "structured-model-v1", modelStatus: "SUCCEEDED" });
  }
  if (decision.confidence < 0.8 || decision.action === "clarify") {
    const base = parseStudioConversationIntent(input);
    return StudioConversationIntent.parse({ ...base, action: "clarify", targetReferenceId: null, referenceIds: input.references.map(ref => ref.referenceId),
      clarification: decision.clarification ?? "请明确要生成新图，还是修改哪张图片；其他引用将作为参考。", parser: "structured-model-v1", modelStatus: "SUCCEEDED" });
  }
  // The model decides semantics only. Server rules retain explicit size priority,
  // unit/EXACT limits and pinned source constraints. Keep user text unchanged.
  const intent = parseStudioConversationIntent(input, previous, { action: decision.action, targetReferenceId: decision.targetReferenceId });
  if (intent.action !== "clarify") {
    const selected = new Set(decision.referenceIds);
    intent.referenceIds = input.references.filter(ref => selected.has(ref.referenceId) && ref.referenceId !== intent.targetReferenceId).map(ref => ref.referenceId);
  }
  return StudioConversationIntent.parse({ ...intent, parser: "structured-model-v1", modelStatus: "SUCCEEDED" });
}
