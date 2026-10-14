import { z } from "zod";
import { NativeProjectQueryInput } from "./native-project";
import { StudioGenerationSizeSelection, StudioGenerationView } from "./studio-generation";
import { StudioWorkflowTarget } from "./studio-workflow";

export const STUDIO_CONVERSATION_TTL_MS = 6 * 60_000;
export const StudioConversationPixels = z.object({ width: z.number().int().min(32).max(8192), height: z.number().int().min(32).max(8192) }).strict()
  .refine(value => value.width * value.height <= 16_777_216 && value.width / value.height >= 1 / 3 && value.width / value.height <= 3, "图片尺寸或像素总量超过支持范围");
const id = NativeProjectQueryInput.shape.projectId;
export const StudioConversationReference = z.object({
  referenceId: z.string().min(1).max(200), name: z.string().trim().min(1).max(255),
  shapeId: StudioWorkflowTarget.shape.shapeId.optional(), assetId: id,
  assetSha256: StudioWorkflowTarget.shape.assetSha256, versionId: id.optional(),
  width: z.number().int().positive().max(16384), height: z.number().int().positive().max(16384),
  purpose: z.enum(["REFERENCE", "ADAPTIVE", "EXACT"]).default("REFERENCE"),
}).strict();
const refs = z.array(StudioConversationReference).max(8).refine(value => new Set(value.map(item => item.referenceId)).size === value.length && new Set(value.map(item => item.assetId)).size === value.length, "引用图片不能重复");
const draftFields = z.object({ text: z.string().max(4000), references: refs, quickEditTargetId: z.string().min(1).max(200).nullable().default(null), sizeSelection: StudioGenerationSizeSelection }).strict();
const validTarget = (value: z.infer<typeof draftFields>) => value.quickEditTargetId === null || value.references.some(ref => ref.referenceId === value.quickEditTargetId && ref.shapeId !== undefined);
export const StudioConversationDraftInput = draftFields.extend({ revision: z.number().int().min(0).max(2147483646) }).refine(validTarget, "快捷编辑目标必须在本次引用中");
export const StudioConversationDraft = draftFields.extend({ revision: z.number().int().min(0).max(2147483647) }).refine(validTarget, "快捷编辑目标必须在本次引用中");
export const StudioConversationInput = draftFields.extend({ mutationId: z.string().uuid(), text: z.string().trim().min(1).max(4000),
  documentRevision: z.number().int().min(0).max(2147483646), workflowRevision: z.number().int().min(0).max(2147483646),
  requestedSize: StudioConversationPixels.optional(), outputFrameId: StudioWorkflowTarget.shape.shapeId.optional(),
}).refine(validTarget, "快捷编辑目标必须在本次引用中");
export const StudioConversationIntent = z.object({
  action: z.enum(["generate", "modify", "clarify"]), targetReferenceId: z.string().nullable(), referenceIds: z.array(z.string()).max(8),
  prompt: z.string().min(1).max(4000), clarification: z.string().nullable(),
  requestedSize: StudioConversationPixels.nullable(), sizeSource: z.enum(["dialog-pixels", "dialog-ratio", "control", "target", "default"]),
  sizeSelection: StudioGenerationSizeSelection, parser: z.enum(["safe-rules-v1", "structured-model-v1"]),
  modelStatus: z.enum(["UNAVAILABLE", "SUCCEEDED", "UNKNOWN"]).optional(),
}).strict();
export const StudioConversationMessage = z.object({
  messageId: id, mutationId: z.string().uuid(), projectId: id, text: z.string(), references: refs,
  status: z.enum(["PENDING", "RUNNING", "CLARIFICATION", "SUCCEEDED", "FAILED"]),
  intent: StudioConversationIntent.nullable(), generation: StudioGenerationView.nullable(),
  error: z.string().nullable(), clarification: z.string().nullable(), createdAt: z.string().datetime(), expiresAt: z.string().datetime(),
}).strict();
export const StudioConversationQuery = z.object({ messageId: id.optional(), before: id.optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }).strict();
export const StudioConversationPage = z.object({ messages: z.array(StudioConversationMessage), nextCursor: id.nullable(), draft: StudioConversationDraft.nullable() }).strict();
export type StudioConversationInput = z.infer<typeof StudioConversationInput>;
export type StudioConversationReference = z.infer<typeof StudioConversationReference>;
export type StudioConversationIntent = z.infer<typeof StudioConversationIntent>;
export type StudioConversationDraftInput = z.infer<typeof StudioConversationDraftInput>;
export type StudioConversationMessage = z.infer<typeof StudioConversationMessage>;
