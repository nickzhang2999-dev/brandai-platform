import { z } from "zod";
import { NativeProjectQueryInput } from "./native-project";
import { GenerationSizeSelection, GenerationAspectRatioKey, GenerationResolutionTier, CustomAspectRatio } from "./ai";
import { StudioWorkflowTarget } from "./studio-workflow";

export const STUDIO_GENERATION_TTL_MS = 6 * 60_000;
export const STUDIO_GENERATION_OUTPUT_TTL_MS = 24 * 60 * 60_000;
export const StudioGenerationSizeSelection = z.object({ ratioKey: GenerationAspectRatioKey, resolutionTier: GenerationResolutionTier,
  customRatio: CustomAspectRatio.strict().optional() }).strict().superRefine((value, context) => {
  const parsed = GenerationSizeSelection.safeParse(value);
  if (!parsed.success) parsed.error.issues.forEach(issue => context.addIssue(issue));
});
export const StudioGenerationInput = NativeProjectQueryInput.pick({ projectId: true }).extend({
  mutationId: z.string().uuid(), prompt: z.string().trim().min(1).max(4000),
  sizeSelection: StudioGenerationSizeSelection,
  workflowRevision: z.number().int().min(0).max(2147483646),
  documentRevision: z.number().int().min(0).max(2147483646),
  outputFrameId: StudioWorkflowTarget.shape.shapeId.optional(),
}).strict();
export const StudioGenerationQuery = NativeProjectQueryInput.pick({ projectId: true }).extend({
  requestId: NativeProjectQueryInput.shape.projectId.optional(),
}).strict();
export const StudioGenerationRetryInput = StudioGenerationQuery.required();
export const StudioGenerationArchiveRetryInput = StudioGenerationRetryInput;
export const StudioGenerationView = z.object({
  mode: z.enum(["generate", "modify"]).default("generate"),
  requestId: NativeProjectQueryInput.shape.projectId, mutationId: z.string().uuid(),
  projectId: NativeProjectQueryInput.shape.projectId, generationId: NativeProjectQueryInput.shape.projectId,
  status: z.enum(["PENDING", "RUNNING", "SUCCEEDED", "FAILED"]), progress: z.null(),
  expiresAt: z.string().datetime(), archiveExpiresAt: z.string().datetime().nullable(),
  archiveProcessingExpiresAt: z.string().datetime().nullable(), displayText: z.string(),
  resultState: z.enum(["NOT_REQUESTED", "PENDING", "RUNNING", "READY", "FAILED"]),
  results: z.array(z.object({
    versionId: NativeProjectQueryInput.shape.projectId, assetId: NativeProjectQueryInput.shape.projectId,
    assetSha256: z.string().regex(/^[a-f0-9]{64}$/), width: z.number().int().positive(), height: z.number().int().positive(),
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    url: z.string().regex(/^\/api\/workspaces\/[a-zA-Z0-9_-]+\/assets\/[a-zA-Z0-9_-]+\/raw$/).refine(v => !v.includes("\n")),
  }).strict()), error: z.string().nullable(), archiveError: z.string().nullable(), canRetryArchive: z.boolean(),
}).strict();
export type StudioGenerationInput = z.infer<typeof StudioGenerationInput>;
