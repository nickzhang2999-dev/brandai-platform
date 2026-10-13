import { z } from "zod";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const dimension = z.number().int().positive().max(16384);
export const STUDIO_DECOMPOSITION_TTL_MS = 6 * 60_000;
export const STUDIO_LAYER_RECOVERY_TTL_MS = 24 * 60 * 60_000;
export const StudioDecompositionInput = z.object({
  projectId: id, mutationId: z.string().uuid(),
  sourceShapeId: z.string().regex(/^shape:[A-Za-z0-9_-]{1,128}$/),
  assetId: id, assetSha256: sha, documentRevision: z.number().int().nonnegative(),
  layerCount: z.number().int().min(2).max(10), intent: z.string().trim().max(500).optional(),
}).strict();
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
}).strict().superRefine((layer, context) => {
  if (layer.alphaBounds.left + layer.alphaBounds.width > layer.width || layer.alphaBounds.top + layer.alphaBounds.height > layer.height) context.addIssue({ code: "custom", message: "Alpha bounds exceed the original full image" });
});
export type StudioDecompositionLayer = z.infer<typeof StudioDecompositionLayer>;
export const StudioDecompositionView = z.object({
  requestId: id, mutationId: z.string().uuid(), projectId: id,
  sourceShapeId: StudioDecompositionInput.shape.sourceShapeId, assetId: id, assetSha256: sha,
  documentRevision: z.number().int().nonnegative(), layerCount: z.number().int().min(2).max(10),
  sourceWidth: dimension, sourceHeight: dimension,
  status: z.enum(["PENDING", "RUNNING", "SUCCEEDED", "FAILED"]), error: z.string().max(1000).nullable(),
  createdAt: z.string().datetime(), expiresAt: z.string().datetime(),
  archiveExpiresAt: z.string().datetime().nullable(), canRetryArchive: z.boolean(),
  layers: z.array(StudioDecompositionLayer).max(10),
}).strict().superRefine((view, context) => {
  if (view.status !== "SUCCEEDED" && view.layers.length) context.addIssue({ code: "custom", message: "Unpublished layers must stay private" });
  if (view.status === "SUCCEEDED" && (view.layers.length < 2 || view.layers.some((layer, index) => layer.order !== index || layer.width !== view.sourceWidth || layer.height !== view.sourceHeight) || new Set(view.layers.map(layer => layer.assetId)).size !== view.layers.length)) context.addIssue({ code: "custom", message: "Published layers need complete full-size ordered identities" });
});
export type StudioDecompositionView = z.infer<typeof StudioDecompositionView>;
