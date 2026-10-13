import { z } from "zod";
import { StudioLayerPlanResponse, STUDIO_LAYER_PLAN_REVISION } from "@brandai/contracts";

export const StudioDecompositionPlanning = z.object({ revision: z.literal(STUDIO_LAYER_PLAN_REVISION), mode: z.enum(["AUTO", "MANUAL"]),
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
export function semanticDecompositionIntent(userIntent: string | null, planning: StudioDecompositionPlanning) {
  // The plan's names describe proposed groups, never verified names of
  // returned layers. Their order is not assumed to match the Fal images list.
  if (planning.mode !== "AUTO" || !planning.result) return userIntent ?? undefined;
  const groups = planning.result.plan.groups.map((group, index) => `${index + 1}.${group.name.slice(0, 24)}`).join("；");
  const required = `按图像实际内容拆出完整可编辑组：${groups}。保留原构图、透明边缘；勿把同一主体切碎。`;
  const spare = Math.max(0, 500 - required.length - 6);
  return userIntent && spare ? `${required}\n用户要求：${userIntent.slice(0, spare)}` : required;
}
