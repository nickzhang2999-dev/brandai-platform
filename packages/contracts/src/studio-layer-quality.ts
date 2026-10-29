import { z } from "zod";

// Versioned triage heuristics, never a semantic, text or visual quality guarantee.
export const STUDIO_LAYER_QUALITY_REVISION = "layer-quality-r1" as const;
export const STUDIO_LAYER_QUALITY_THRESHOLDS = {
  changedChannelDelta: 24, meanAbsoluteError: 8, changedPixelRatio: 0.05,
  alphaMeanAbsoluteError: 8, regionChangedPixelRatio: 0.1,
} as const;
const ratio = z.number().finite().min(0).max(1);
const dimension = z.number().int().positive().max(16384);
export const StudioLayerQualityWarning = z.enum([
  "COMPOSITE_DIFFERENCE", "LOCAL_DIFFERENCE", "WEAK_LAYER", "NEAR_DUPLICATE_LAYERS", "QUALITY_CHECK_UNAVAILABLE",
]);
export const StudioLayerQualityUnavailableReason = z.enum([
  "SOURCE_UNAVAILABLE", "SOURCE_MISMATCH", "SOURCE_INVALID", "CHECK_ABORTED", "CHECK_FAILED",
]);
export const StudioLayerQualityReport = z.object({
  revision: z.literal(STUDIO_LAYER_QUALITY_REVISION),
  status: z.enum(["COMPOSITE_MATCH", "REVIEW_REQUIRED", "UNAVAILABLE"]),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), sourceWidth: dimension, sourceHeight: dimension,
  sampleWidth: z.number().int().positive().max(1024).nullable(),
  sampleHeight: z.number().int().positive().max(1024).nullable(),
  // RGB differences are measured in premultiplied sRGB (0..255); fully
  // invisible RGB is ignored. Alpha is compared independently in 0..255.
  metrics: z.object({ meanAbsoluteError: z.number().finite().min(0).max(255), changedPixelRatio: ratio,
    alphaMeanAbsoluteError: z.number().finite().min(0).max(255) }).strict().nullable(),
  // Significant 4x4 cells, expressed in the original full-frame coordinates.
  regions: z.array(z.object({ left: z.number().int().nonnegative(), top: z.number().int().nonnegative(),
    width: dimension, height: dimension, changedPixelRatio: ratio }).strict()).max(16),
  thresholds: z.object({ changedChannelDelta: z.literal(24), meanAbsoluteError: z.literal(8), changedPixelRatio: z.literal(0.05),
    alphaMeanAbsoluteError: z.literal(8), regionChangedPixelRatio: z.literal(0.1) }).strict(),
  warnings: z.array(StudioLayerQualityWarning).max(5), unavailableReason: StudioLayerQualityUnavailableReason.nullable(),
  semanticsChecked: z.literal(false), textChecked: z.literal(false), humanReviewRequired: z.literal(true),
  checkedAt: z.string().datetime(),
}).strict().superRefine((report, context) => {
  if (report.status === "UNAVAILABLE" ? !report.unavailableReason || report.metrics !== null || report.sampleWidth !== null || report.sampleHeight !== null || report.regions.length > 0
    : report.unavailableReason !== null || report.metrics === null || report.sampleWidth === null || report.sampleHeight === null)
    context.addIssue({ code: "custom", message: "Quality status requires its actual measurements or an explicit unavailable reason" });
  if (report.sampleWidth !== null && report.sampleWidth > report.sourceWidth || report.sampleHeight !== null && report.sampleHeight > report.sourceHeight
    || report.regions.some(region => region.left + region.width > report.sourceWidth || region.top + region.height > report.sourceHeight))
    context.addIssue({ code: "custom", message: "Quality sampling and regions must stay within the source frame" });
  const globalDifference = report.metrics && (report.metrics.meanAbsoluteError > report.thresholds.meanAbsoluteError
    || report.metrics.changedPixelRatio > report.thresholds.changedPixelRatio || report.metrics.alphaMeanAbsoluteError > report.thresholds.alphaMeanAbsoluteError);
  if (report.status === "COMPOSITE_MATCH" && (globalDifference || report.regions.length > 0 || report.warnings.length > 0)
    || report.status === "REVIEW_REQUIRED" && report.warnings.length === 0
    || report.status !== "UNAVAILABLE" && (report.warnings.includes("QUALITY_CHECK_UNAVAILABLE")
      || Boolean(globalDifference) !== report.warnings.includes("COMPOSITE_DIFFERENCE")
      || Boolean(report.regions.length) !== report.warnings.includes("LOCAL_DIFFERENCE"))
    || report.status === "UNAVAILABLE" && !report.warnings.includes("QUALITY_CHECK_UNAVAILABLE")
    || report.regions.some(region => region.changedPixelRatio <= report.thresholds.regionChangedPixelRatio))
    context.addIssue({ code: "custom", message: "Quality status and warnings must agree with versioned measurements" });
});
export type StudioLayerQualityReport = z.infer<typeof StudioLayerQualityReport>;
export type StudioLayerQualityUnavailableReason = z.infer<typeof StudioLayerQualityUnavailableReason>;
