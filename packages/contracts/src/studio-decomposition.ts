import { z } from "zod";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const dimension = z.number().int().positive().max(16384);
export const StudioLayerMode = z.enum(["AUTO", "MANUAL"]);
export const STUDIO_LAYER_PLAN_REVISION = "semantic-layer-plan-r1";
export const StudioLayerPlanGroup = z.object({ name: z.string().trim().min(1).max(80), description: z.string().trim().min(1).max(300) }).strict();
export const StudioLayerPlan = z.object({ layerCount: z.number().int().min(2).max(10), summary: z.string().trim().min(1).max(600),
  groups: z.array(StudioLayerPlanGroup).min(2).max(10) }).strict().superRefine((plan, context) => {
  if (plan.groups.length !== plan.layerCount || new Set(plan.groups.map(group => group.name)).size !== plan.groups.length)
    context.addIssue({ code: "custom", message: "Semantic groups must have unique names and match the selected count" });
});
export const StudioLayerPlanRequest = z.object({ imageUrl: z.string().regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/).max(45 * 1024 * 1024),
  maxLayers: z.number().int().min(2).max(10), intent: z.string().max(500).optional(), providerRetryPolicy: z.literal("never") }).strict();
export const StudioLayerPlanResponse = z.object({ revision: z.literal(STUDIO_LAYER_PLAN_REVISION), plan: StudioLayerPlan,
  usage: z.object({ provider: z.literal("HttpVLMProvider"), model: z.string().min(1).max(200), latencyMs: z.number().int().nonnegative() }).strict() }).strict();
export type StudioLayerPlanRequest = z.infer<typeof StudioLayerPlanRequest>;
export type StudioLayerPlanResponse = z.infer<typeof StudioLayerPlanResponse>;
export const STUDIO_DECOMPOSITION_TTL_MS = 6 * 60_000;
export const STUDIO_LAYER_RECOVERY_TTL_MS = 24 * 60 * 60_000;
export const StudioDecompositionInput = z.object({
  projectId: id, mutationId: z.string().uuid(),
  sourceShapeId: z.string().regex(/^shape:[A-Za-z0-9_-]{1,128}$/),
  assetId: id, assetSha256: sha, documentRevision: z.number().int().nonnegative(),
  layerMode: StudioLayerMode.optional(), layerCount: z.number().int().min(2).max(10).optional(), intent: z.string().trim().max(500).optional(),
}).strict().superRefine((input, context) => {
  if (input.layerMode === "AUTO" ? input.layerCount !== undefined : input.layerCount === undefined)
    context.addIssue({ code: "custom", message: "AUTO chooses its own count; MANUAL requires a layer count", path: ["layerCount"] });
});
export type StudioDecompositionInput = z.infer<typeof StudioDecompositionInput>;
export const StudioDecompositionQuery = z.object({ projectId: id, requestId: id.optional() }).strict();
export const StudioDecompositionRetryInput = StudioDecompositionQuery.extend({ requestId: id }).strict();
export const StudioDecompositionLayer = z.object({
  assetId: id, assetSha256: sha, mimeType: z.literal("image/png"),
  width: dimension, height: dimension, order: z.number().int().min(0).max(9),
  sizeBytes: z.number().int().positive().max(32 * 1024 * 1024),
  url: z.string().regex(/^\/api\/workspaces\/[a-zA-Z0-9_-]{1,128}\/assets\/[a-zA-Z0-9_-]{1,128}\/raw$/),
  alphaBounds: z.object({ left: z.number().int().nonnegative(), top: z.number().int().nonnegative(), width: dimension, height: dimension }).strict(),
  inkCoverage: z.number().min(0).max(1),
  name: z.string().trim().min(1).max(80).optional(),
}).strict().superRefine((layer, context) => {
  if (layer.alphaBounds.left + layer.alphaBounds.width > layer.width || layer.alphaBounds.top + layer.alphaBounds.height > layer.height) context.addIssue({ code: "custom", message: "Alpha bounds exceed the original full image" });
});
export type StudioDecompositionLayer = z.infer<typeof StudioDecompositionLayer>;
export const StudioDecompositionView = z.object({
  requestId: id, mutationId: z.string().uuid(), projectId: id,
  sourceShapeId: z.string().regex(/^shape:[A-Za-z0-9_-]{1,128}$/), assetId: id, assetSha256: sha,
  documentRevision: z.number().int().nonnegative(), layerCount: z.number().int().min(2).max(10),
  // Preserve the accepted/model-plan count when a completed provider returns
  // a different actual layer count. Optional for older server receipts.
  requestedLayerCount: z.number().int().min(2).max(10).optional(),
  layerMode: StudioLayerMode.default("MANUAL"),
  analysisStatus: z.enum(["NOT_REQUESTED", "PENDING", "RUNNING", "SUCCEEDED", "FAILED"]).default("NOT_REQUESTED"),
  analysisSummary: z.string().max(600).nullable().default(null),
  sourceWidth: dimension, sourceHeight: dimension,
  status: z.enum(["PENDING", "RUNNING", "SUCCEEDED", "FAILED"]), error: z.string().max(1000).nullable(),
  createdAt: z.string().datetime(), expiresAt: z.string().datetime(),
  archiveExpiresAt: z.string().datetime().nullable(), canRetryArchive: z.boolean(),
  layers: z.array(StudioDecompositionLayer).max(10),
}).strict().superRefine((view, context) => {
  if (view.status !== "SUCCEEDED" && view.requestedLayerCount !== undefined && view.requestedLayerCount !== view.layerCount)
    context.addIssue({ code: "custom", message: "Unfinished layer receipts must retain the accepted count" });
  if (view.layerMode === "AUTO" && ((view.status === "SUCCEEDED" && (view.analysisStatus !== "SUCCEEDED" || !view.analysisSummary)) || view.analysisStatus === "NOT_REQUESTED"))
    context.addIssue({ code: "custom", message: "AUTO requires real semantic analysis before publishing layers" });
  if (view.status !== "SUCCEEDED" && view.layers.length) context.addIssue({ code: "custom", message: "Unpublished layers must stay private" });
  if (view.status === "SUCCEEDED" && (view.layers.length !== view.layerCount || view.layers.length < 2 || view.layers.some((layer, index) => layer.order !== index || layer.width !== view.sourceWidth || layer.height !== view.sourceHeight) || new Set(view.layers.map(layer => layer.assetId)).size !== view.layers.length)) context.addIssue({ code: "custom", message: "Published layers need complete full-size ordered identities" });
});
export type StudioDecompositionView = z.infer<typeof StudioDecompositionView>;
