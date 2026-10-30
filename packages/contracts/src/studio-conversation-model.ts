import { z } from "zod";
import { StudioProjectContextFacts, StudioProjectMaterialRole } from "./studio-project-context";

export const STUDIO_CONVERSATION_MODEL_REVISION = "structured-conversation-intent-r2";
export const STUDIO_CONVERSATION_THUMBNAIL_MAX_BYTES = 128 * 1024;
const refId = z.string().min(1).max(200);
const unique = (ids: string[]) => new Set(ids).size === ids.length;
export const StudioConversationThumbnail = z.object({
  dataUrl: z.string().max(174_800).regex(/^data:image\/(?:png|jpeg|webp);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
    .refine(value => { const payload = value.slice(value.indexOf(",") + 1); return payload.length > 0 && payload.length / 4 * 3 - (payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0) <= STUDIO_CONVERSATION_THUMBNAIL_MAX_BYTES; }, "Thumbnail exceeds byte budget"),
  width: z.number().int().min(1).max(512), height: z.number().int().min(1).max(512),
}).strict();
const reference = z.object({ referenceId: refId, name: z.string().min(1).max(255), editable: z.boolean() }).strict();
const baseRequest = { text: z.string().trim().min(1).max(4000), quickEditTargetId: refId.nullable(),
  previousResultReferenceId: refId.nullable(), providerRetryPolicy: z.literal("never").default("never") };
export const StudioConversationModelHistory = z.object({ role: z.enum(["user", "assistant"]), text: z.string().min(1).max(1000), resultReferenceId: refId.nullable() }).strict();
const requestV1 = z.object({ ...baseRequest, schemaVersion: z.literal(1), references: z.array(reference).max(8) }).strict();
export const StudioConversationProjectContext = z.object({ revision: z.number().int().min(0).max(2147483646), facts: StudioProjectContextFacts,
  materials: z.array(z.object({ name: z.string().min(1).max(255), role: StudioProjectMaterialRole, referenceId: refId.nullable() }).strict()).max(7),
  masterReferenceId: refId.nullable() }).strict();
const requestV2 = z.object({ ...baseRequest, schemaVersion: z.literal(2), references: z.array(reference.extend({ thumbnail: StudioConversationThumbnail.optional() })).max(8),
  history: z.array(StudioConversationModelHistory).max(6), selectedReferenceIds: z.array(refId).max(8),
  lastResultImage: z.object({ name: z.string().min(1).max(255), thumbnail: StudioConversationThumbnail }).strict().optional(),
  projectContext: StudioConversationProjectContext.optional(),
}).strict();
export const StudioConversationModelRequest = z.union([requestV1, requestV2]).superRefine((value, context) => {
  const ids = new Set(value.references.map(ref => ref.referenceId));
  if (ids.size !== value.references.length || value.quickEditTargetId !== null && !value.references.some(ref => ref.referenceId === value.quickEditTargetId && ref.editable)
    || value.previousResultReferenceId !== null && !ids.has(value.previousResultReferenceId)) context.addIssue({ code: "custom", message: "Targets must belong to unique frozen references" });
  if (value.schemaVersion === 2 && (value.references.filter(ref => ref.thumbnail).length + (value.lastResultImage ? 1 : 0) > 4 || !unique(value.selectedReferenceIds)
    || value.selectedReferenceIds.some(id => !ids.has(id)) || value.history.some(turn => turn.resultReferenceId !== null && !ids.has(turn.resultReferenceId))))
    context.addIssue({ code: "custom", message: "Invalid bounded history, selection or thumbnails" });
  if (value.schemaVersion === 2 && value.projectContext && (value.projectContext.masterReferenceId !== null && !ids.has(value.projectContext.masterReferenceId)
    || value.projectContext.materials.some(item => item.referenceId !== null && !ids.has(item.referenceId)))) context.addIssue({ code: "custom", message: "Project context references must be frozen references" });
});
export const StudioConversationOption = z.object({
  id: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/), label: z.string().trim().min(1).max(80),
  action: z.enum(["generate", "modify"]), targetReferenceId: refId.nullable(), referenceIds: z.array(refId).max(8),
  imagePrompt: z.string().trim().min(1).max(4000),
}).strict().superRefine((value, context) => {
  if ((value.action === "modify") !== (value.targetReferenceId !== null) || !unique(value.referenceIds) || value.targetReferenceId !== null && value.referenceIds.includes(value.targetReferenceId))
    context.addIssue({ code: "custom", message: "Invalid option action or reference list" });
});
const decisionFields = { action: z.enum(["generate", "modify", "clarify"]), targetReferenceId: refId.nullable(),
  referenceIds: z.array(refId).max(8), confidence: z.number().finite().min(0).max(1), clarification: z.string().min(1).max(2000).nullable() };
function validateAction(value: { action: string; targetReferenceId: string | null; referenceIds: string[]; clarification: string | null }, context: z.RefinementCtx) {
  if ((value.action === "modify") !== (value.targetReferenceId !== null) || (value.action === "clarify") !== (value.clarification !== null)
    || !unique(value.referenceIds) || value.targetReferenceId !== null && value.referenceIds.includes(value.targetReferenceId))
    context.addIssue({ code: "custom", message: "Invalid structured action, target or clarification" });
}
export const StudioConversationModelDecisionV1 = z.object(decisionFields).strict().superRefine(validateAction);
export const StudioConversationModelDecisionV2 = z.object({ ...decisionFields, imagePrompt: z.string().trim().min(1).max(4000).nullable(), options: z.array(StudioConversationOption).max(3) }).strict().superRefine((value, context) => {
  validateAction(value, context);
  if ((value.action === "clarify") !== (value.imagePrompt === null) || value.action === "clarify" && value.options.length < 2
    || value.action !== "clarify" && value.options.length > 0 || !unique(value.options.map(option => option.id)))
    context.addIssue({ code: "custom", message: "Action needs a rewritten prompt; clarification needs two or three distinct options" });
});
export const StudioConversationModelDecision = z.union([StudioConversationModelDecisionV1, StudioConversationModelDecisionV2]);
const tokens = z.number().int().min(0).max(2_147_483_647);
export const StudioConversationModelUsage = z.object({ inputTokens: tokens.optional(), outputTokens: tokens.optional(), totalTokens: tokens.optional(), reasoningTokens: tokens.optional(), latencyMs: tokens }).strict();
export const StudioConversationModelResponse = z.discriminatedUnion("revision", [
  z.object({ revision: z.literal("structured-conversation-intent-r1"), decision: StudioConversationModelDecisionV1 }).strict(),
  z.object({ revision: z.literal(STUDIO_CONVERSATION_MODEL_REVISION), decision: StudioConversationModelDecisionV2, usage: StudioConversationModelUsage.optional() }).strict(),
]);
export type StudioConversationModelRequest = z.infer<typeof StudioConversationModelRequest>;
export type StudioConversationModelDecision = z.infer<typeof StudioConversationModelDecision>;
export type StudioConversationModelResponse = z.infer<typeof StudioConversationModelResponse>;
export type StudioConversationOption = z.infer<typeof StudioConversationOption>;
export type StudioConversationModelUsage = z.infer<typeof StudioConversationModelUsage>;
