import { z } from "zod";

// A model's scene assessment is a proposal, not a mask, tool permission or QA receipt.
const description = z.string().trim().min(1).max(300);
export const StudioLayerOcclusion = z.object({
  target: z.string().trim().min(1).max(80),
  kind: z.enum(["CONTINUOUS_TEXTURE", "REGULAR_STRUCTURE", "IDENTITY_OR_PRODUCT", "TEXT_OR_LOGO", "ATTACHED_OBJECTS", "TRANSPARENCY_OR_REFLECTION"]),
  evidence: description,
  action: z.enum(["INFER_BACKGROUND", "KEEP_GROUPED", "VISIBLE_ONLY", "REFERENCE_REQUIRED"]),
  reason: description,
}).strict().superRefine((item, context) => {
  if (item.action === "INFER_BACKGROUND" && !["CONTINUOUS_TEXTURE", "REGULAR_STRUCTURE"].includes(item.kind))
    context.addIssue({ code: "custom", message: "Only ordinary background or regular structure may be inferred without a reference" });
});
export const StudioLayerAssessment = z.object({
  occlusions: z.array(StudioLayerOcclusion).max(8),
  preserve: z.array(description).min(1).max(8),
  shadowPolicy: z.enum(["NONE_VISIBLE", "KEEP_WITH_SUBJECT", "SEPARATE_IF_VERIFIED", "KEEP_ENVIRONMENT", "UNCERTAIN"]),
  shadowEvidence: description,
}).strict().superRefine((assessment, context) => {
  if (new Set(assessment.occlusions.map(item => item.target)).size !== assessment.occlusions.length)
    context.addIssue({ code: "custom", message: "Occlusion targets must be unique" });
});
export type StudioLayerAssessment = z.infer<typeof StudioLayerAssessment>;

export const StudioLayerWorkflow = z.object({
  stage: z.enum(["QUEUED", "ANALYZING", "DECOMPOSING", "CHECKING_AND_SAVING", "READY_FOR_REVIEW", "FAILED"]),
  assessment: StudioLayerAssessment.nullable(),
  // The current decomposition provider cannot prove local repair or independent quality.
  backgroundCompletion: z.literal("NOT_PERFORMED"),
  independentQuality: z.literal("NOT_REVIEWED"),
}).strict();
export type StudioLayerWorkflow = z.infer<typeof StudioLayerWorkflow>;
