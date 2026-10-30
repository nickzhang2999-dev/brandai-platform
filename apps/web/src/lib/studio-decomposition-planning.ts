import { z } from "zod";
import { StudioLayerPlanResponse, STUDIO_LAYER_PLAN_REVISION, CAPTION_STUDIO_LAYER_PLAN_REVISION, LEGACY_STUDIO_LAYER_PLAN_REVISION } from "@brandai/contracts";
import type { StudioLayerWorkflow } from "@brandai/contracts";

export const StudioDecompositionPlanning = z.object({ revision: z.enum([STUDIO_LAYER_PLAN_REVISION, CAPTION_STUDIO_LAYER_PLAN_REVISION, LEGACY_STUDIO_LAYER_PLAN_REVISION]), mode: z.enum(["AUTO", "MANUAL"]),
  status: z.enum(["NOT_REQUESTED", "PENDING", "RUNNING", "SUCCEEDED", "FAILED"]),
  startedAt: z.string().datetime().nullable(), result: StudioLayerPlanResponse.nullable() }).strict().superRefine((planning, context) => {
    const valid = planning.mode === "MANUAL"
      ? planning.status === "NOT_REQUESTED" && planning.startedAt === null && planning.result === null
      : planning.status === "PENDING" ? planning.startedAt === null && planning.result === null
        : planning.status === "RUNNING" ? planning.startedAt !== null && planning.result === null
          : planning.status === "SUCCEEDED" ? planning.startedAt !== null && planning.result !== null
            : planning.status === "FAILED" && planning.result === null;
    if (!valid) context.addIssue({ code: "custom", message: "Semantic analysis mode, claim and saved plan must agree" });
  });
export type StudioDecompositionPlanning = z.infer<typeof StudioDecompositionPlanning>;
export function newStudioLayerPlanning(mode: "AUTO" | "MANUAL") {
  return StudioDecompositionPlanning.parse({ revision: STUDIO_LAYER_PLAN_REVISION, mode,
    status: mode === "AUTO" ? "PENDING" : "NOT_REQUESTED", startedAt: null, result: null });
}
export function readStudioLayerPlanning(json: unknown) {
  // Only true NULL/old rows imply manual. A malformed non-null analysis record
  // fails closed; it must never downgrade an AUTO task into a fixed-count call.
  return json === null || json === undefined ? newStudioLayerPlanning("MANUAL") : StudioDecompositionPlanning.parse(json);
}
export function studioLayerMaxCount(width: number, height: number, totalPixels: number) {
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels < 1) return 0;
  return Math.min(10, Math.floor(totalPixels / pixels));
}
export function semanticDecompositionIntent(userIntent: string | null, _planning: StudioDecompositionPlanning) {
  // Keep the original intent for audit and providers which support it. Qwen's
  // prompt is a source caption, not a command for the proposed semantic groups.
  return userIntent ?? undefined;
}
export function semanticDecompositionSourceCaption(planning: StudioDecompositionPlanning) {
  // Manual and saved r1 plans have no verified caption. Omit it so Fal can
  // describe the source itself; never synthesize one from intent/group names.
  return planning.mode === "AUTO" && planning.status === "SUCCEEDED" && planning.result && planning.result.revision !== LEGACY_STUDIO_LAYER_PLAN_REVISION
    ? planning.result.plan.sourceCaption : undefined;
}

export function studioLayerWorkflow(row: { status: string; providerStartedAt: Date | null; archiveToken: string | null }, planning: StudioDecompositionPlanning): StudioLayerWorkflow {
  const stage = row.status === "FAILED" ? "FAILED" : row.status === "SUCCEEDED" ? "READY_FOR_REVIEW"
    : row.archiveToken ? "CHECKING_AND_SAVING" : row.providerStartedAt ? "DECOMPOSING"
      : planning.status === "RUNNING" ? "ANALYZING" : "QUEUED";
  return { stage, assessment: planning.result?.revision === STUDIO_LAYER_PLAN_REVISION ? planning.result.plan.assessment : null,
    backgroundCompletion: "NOT_PERFORMED", independentQuality: "NOT_REVIEWED" };
}
