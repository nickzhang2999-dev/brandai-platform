import { z } from "zod";

const Id = z.string().min(1).max(128);
const Revision = z.number().int().nonnegative().max(2 ** 31 - 1);
const Text = z.string().max(60000);
export const STUDIO_WRITING_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const STUDIO_WRITING_IMAGE_MAX_COUNT = 4;
export const StudioWritingSelection = z.object({ start: Revision, end: Revision, text: z.string().min(1).max(20000) }).strict()
  .refine(v => v.end > v.start && v.end - v.start === v.text.length, "选段范围与原文不一致。");
export const StudioWritingCitation = z.object({ referenceId: Id, segmentId: Id, pageNumber: z.number().int().min(1).max(200).nullable(), label: z.string().max(200) }).strict();
export const StudioWritingSegment = z.object({ id: Id, pageNumber: z.number().int().min(1).max(200).nullable(), label: z.string().max(200), text: z.string().max(3000) }).strict();
export const StudioWritingStyleContent = z.object({ rules: z.array(z.string().trim().min(1).max(1000)).max(20),
  examples: z.array(z.object({ title: z.string().trim().min(1).max(100), text: z.string().trim().min(1).max(6000) }).strict()).max(5) }).strict();
export const StudioWritingStyle = StudioWritingStyleContent.extend({ revision: Revision, confirmedAt: z.string().nullable() }).strict();
export const StudioWritingDocument = z.object({ id: Id, title: z.string().max(200), text: Text, revision: Revision, updatedAt: z.string().nullable() }).strict();
export const StudioWritingVersion = z.object({ id: Id, revision: Revision, title: z.string().max(200), text: Text,
  operation: z.enum(["SAVE", "REPLACE", "RESTORE"]), createdAt: z.string() }).strict();
const SaveBase = z.object({ mutationId: z.string().uuid(), expectedRevision: Revision });
export const StudioWritingSaveInput = z.discriminatedUnion("operation", [
  SaveBase.extend({ operation: z.literal("SAVE"), title: z.string().max(200), text: Text }).strict(),
  SaveBase.extend({ operation: z.literal("REPLACE"), selection: StudioWritingSelection, replacement: z.string().max(20000) }).strict(),
  SaveBase.extend({ operation: z.literal("RESTORE"), versionId: Id }).strict(),
]);
export type StudioWritingSaveInput = z.infer<typeof StudioWritingSaveInput>;
export const StudioWritingGenerateInput = z.object({ mutationId: z.string().uuid(), expectedRevision: Revision,
  prompt: z.string().trim().min(1).max(4000), mode: z.enum(["GENERATE", "REWRITE", "CONTINUE", "SELECTION", "CHAT"]),
  referenceIds: z.array(Id).max(12), styleRevision: Revision.nullable(), selection: StudioWritingSelection.optional(),
  projectContextRevision: Revision.optional(),
}).strict().superRefine((v, ctx) => {
  if ((v.mode === "SELECTION") !== !!v.selection) ctx.addIssue({ code: "custom", path: ["selection"], message: "选段模式必须提供当前原文选段，其它模式不接受选段。" });
  if (new Set(v.referenceIds).size !== v.referenceIds.length) ctx.addIssue({ code: "custom", path: ["referenceIds"], message: "参考资料不可重复。" });
});
export type StudioWritingGenerateInput = z.infer<typeof StudioWritingGenerateInput>;
export const StudioWritingStyleSaveInput = StudioWritingStyleContent.extend({ mutationId: z.string().uuid(), expectedRevision: Revision, confirmed: z.literal(true) }).strict();
export const StudioWritingStyleExtractInput = z.object({ mutationId: z.string().uuid(), referenceIds: z.array(Id).min(1).max(12),
  prompt: z.string().trim().max(2000).default("") }).strict().refine(v => new Set(v.referenceIds).size === v.referenceIds.length, "参考资料不可重复。");
export const StudioWritingAssetReferenceInput = z.object({ mutationId: z.string().uuid(), assetId: Id,
  assetSha256: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().trim().min(1).max(200) }).strict();
export const StudioWritingReference = z.object({ id: Id, name: z.string().max(200), mimeType: z.string().max(128),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), sizeBytes: z.number().int().nonnegative().max(STUDIO_WRITING_FILE_MAX_BYTES),
  kind: z.enum(["IMAGE", "DOCUMENT"]), status: z.enum(["PENDING", "RUNNING", "READY", "FAILED"]),
  error: z.string().nullable(), segments: z.array(StudioWritingSegment).max(200), truncated: z.boolean(), imageUrl: z.string().nullable(), createdAt: z.string() }).strict();
export const StudioWritingResult = z.object({ text: z.string().max(20000), scope: z.enum(["DOCUMENT", "SELECTION", "CHAT", "STYLE_DRAFT", "REFERENCE"]),
  baseRevision: Revision, citations: z.array(StudioWritingCitation).max(30), styleDraft: StudioWritingStyleContent.nullable(),
  model: z.string().max(200), inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), latencyMs: z.number().int().nonnegative(),
}).strict();
export const StudioWritingTask = z.object({ id: Id, mutationId: z.string().uuid(), operation: z.enum(["GENERATE", "STYLE_EXTRACT", "REFERENCE_PARSE"]),
  input: z.union([StudioWritingGenerateInput, StudioWritingStyleExtractInput]).nullable(),
  status: z.enum(["PENDING", "RUNNING", "SUCCEEDED", "FAILED"]), progress: z.number().int().min(0).max(100),
  createdAt: z.string(), expiresAt: z.string(), error: z.string().nullable(), result: StudioWritingResult.nullable() }).strict();
export const StudioWritingMessage = z.object({ id: Id, role: z.enum(["user", "assistant"]), text: z.string().max(20000),
  taskId: Id, citations: z.array(StudioWritingCitation).max(30), createdAt: z.string() }).strict();
export const StudioWritingState = z.object({ enabled: z.boolean(), document: StudioWritingDocument,
  versions: z.array(StudioWritingVersion).max(20), messages: z.array(StudioWritingMessage).max(50),
  references: z.array(StudioWritingReference).max(30), style: StudioWritingStyle, tasks: z.array(StudioWritingTask).max(30) }).strict();
export const StudioWritingVersions = z.object({ versions: z.array(StudioWritingVersion).max(20), hasMore: z.boolean() }).strict();
export const StudioWritingMessages = z.object({ messages: z.array(StudioWritingMessage).max(50), hasMore: z.boolean() }).strict();
export const StudioWritingReferenceAccepted = z.object({ reference: StudioWritingReference, task: StudioWritingTask }).strict();
export const StudioWritingTaskLookup = z.object({ task: StudioWritingTask.nullable() }).strict();
export const StudioWritingSaveResult = z.object({ document: StudioWritingDocument, version: StudioWritingVersion }).strict();
export const StudioWritingError = z.object({ error: z.string(), code: z.enum(["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "CONFLICT", "INVALID_INPUT", "TOO_LARGE", "RATE_LIMITED", "UNAVAILABLE"]) }).strict();
export type StudioWritingState = z.infer<typeof StudioWritingState>;
export type StudioWritingTask = z.infer<typeof StudioWritingTask>;
export type StudioWritingResult = z.infer<typeof StudioWritingResult>;
export type StudioWritingReference = z.infer<typeof StudioWritingReference>;
export type StudioWritingDocument = z.infer<typeof StudioWritingDocument>;
export type StudioWritingStyle = z.infer<typeof StudioWritingStyle>;
export type StudioWritingSelection = z.infer<typeof StudioWritingSelection>;

// Internal parser wire. Bytes are accepted only by the private AI service from a
// scoped worker; it extracts text, never calls a model and never executes files.
export const StudioWritingParseRequest = z.object({ fileName: z.string().min(1).max(200), mimeType: z.string().max(128),
  contentBase64: z.string().min(1).max(Math.ceil(STUDIO_WRITING_FILE_MAX_BYTES / 3) * 4) }).strict();
export const StudioWritingParseResponse = z.object({ segments: z.array(StudioWritingSegment).max(200),
  truncated: z.boolean(), parserRevision: z.literal("studio-writing-text-v1") }).strict();
