import { z } from "zod";
import { NativeProjectQueryInput } from "./native-project";

const NativeProjectReference = NativeProjectQueryInput.pick({ projectId: true });
const NativeProjectId = NativeProjectReference.shape.projectId;

export const STUDIO_MATERIAL_MAX_BYTES = 10 * 1024 * 1024;
export const STUDIO_MATERIAL_TTL_MS = 6 * 60_000;
export const StudioMaterialUploadInput = NativeProjectReference.extend({
  mutationId: z.string().uuid(),
}).strict();
export const StudioMaterialUploadQuery = NativeProjectReference.extend({
  taskId: NativeProjectId.optional(),
}).strict();
export const StudioMaterial = z.object({
  id: NativeProjectId,
  assetId: NativeProjectId,
  assetSha256: z.string().length(64).regex(/^[a-f0-9]{64}$/),
  fileName: z.string().min(1).max(255),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  sizeBytes: z.number().int().positive().max(STUDIO_MATERIAL_MAX_BYTES),
  width: z.number().int().positive().max(16384),
  height: z.number().int().positive().max(16384),
  url: z.string().regex(/^\/api\/workspaces\/[a-zA-Z0-9_-]+\/assets\/[a-zA-Z0-9_-]+\/raw$/).refine(value => !value.includes("\n")),
  kind: z.literal("image"),
}).strict();
export const StudioMaterialUploadView = z.object({
  taskId: NativeProjectId,
  projectId: NativeProjectId,
  mutationId: z.string().uuid(),
  status: z.enum(["PENDING", "RUNNING", "SUCCEEDED", "FAILED"]),
  progress: z.number().int().min(0).max(100),
  expiresAt: z.string().datetime(),
  material: StudioMaterial.optional(),
  error: z.string().max(500).optional(),
}).strict().superRefine((value, context) => {
  if ((value.status === "SUCCEEDED") !== !!value.material)
    context.addIssue({ code: "custom", message: "Only completed uploads carry a material" });
  if (value.status === "FAILED" && !value.error)
    context.addIssue({ code: "custom", message: "Failed uploads require a readable error" });
});
export type StudioMaterial = z.infer<typeof StudioMaterial>;
