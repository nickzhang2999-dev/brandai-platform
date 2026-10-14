import { z } from "zod";
export const STUDIO_CONVERSATION_MODEL_REVISION = "structured-conversation-intent-r1";
const refId = z.string().min(1).max(200);
export const StudioConversationModelRequest = z.object({
  schemaVersion: z.literal(1), text: z.string().trim().min(1).max(4000),
  references: z.array(z.object({ referenceId: refId, name: z.string().min(1).max(255), editable: z.boolean() }).strict()).max(8),
  quickEditTargetId: refId.nullable(), previousResultReferenceId: refId.nullable(), providerRetryPolicy: z.literal("never").default("never"),
}).strict().refine(value => new Set(value.references.map(ref => ref.referenceId)).size === value.references.length, "Duplicate references")
  .refine(value => (value.quickEditTargetId === null || value.references.some(ref => ref.referenceId === value.quickEditTargetId && ref.editable))
    && (value.previousResultReferenceId === null || value.references.some(ref => ref.referenceId === value.previousResultReferenceId)), "Targets must belong to the frozen references");
export const StudioConversationModelDecision = z.object({
  action: z.enum(["generate", "modify", "clarify"]), targetReferenceId: refId.nullable(),
  referenceIds: z.array(refId).max(8), confidence: z.number().finite().min(0).max(1), clarification: z.string().min(1).max(2000).nullable(),
}).strict().superRefine((value, context) => {
  if ((value.action === "modify") !== (value.targetReferenceId !== null) || value.action === "clarify" && value.clarification === null
    || value.action !== "clarify" && value.clarification !== null || new Set(value.referenceIds).size !== value.referenceIds.length)
    context.addIssue({ code: "custom", message: "Invalid structured action, target or clarification" });
});
export const StudioConversationModelResponse = z.object({ revision: z.literal(STUDIO_CONVERSATION_MODEL_REVISION), decision: StudioConversationModelDecision }).strict();
export type StudioConversationModelRequest = z.infer<typeof StudioConversationModelRequest>;
export type StudioConversationModelDecision = z.infer<typeof StudioConversationModelDecision>;
export type StudioConversationModelResponse = z.infer<typeof StudioConversationModelResponse>;
