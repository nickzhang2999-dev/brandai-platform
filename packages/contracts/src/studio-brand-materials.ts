import { z } from "zod";
import { NativeProjectQueryInput } from "./native-project";
import { StudioMaterial, StudioMaterialUploadView } from "./studio-materials";

const resourceId = NativeProjectQueryInput.shape.projectId;
export const StudioBrandMaterialUploadInput = z.object({ mutationId: z.string().uuid() }).strict();
/** A projectless brand task cannot masquerade as a legacy project receipt. */
export const StudioBrandMaterialUploadView = z.object({
  context: z.literal("brand-library"), workspaceId: resourceId,
  taskId: resourceId, mutationId: z.string().uuid(),
  status: StudioMaterialUploadView.innerType().shape.status,
  progress: z.number().int().min(0).max(100), expiresAt: z.string().datetime(),
  material: StudioMaterial.optional(), error: z.string().max(500).optional(),
}).strict().superRefine((value, context) => {
  if ((value.status === "SUCCEEDED") !== Boolean(value.material)) context.addIssue({ code: "custom", message: "Only completed brand uploads carry a material" });
  if (value.status === "FAILED" && !value.error) context.addIssue({ code: "custom", message: "Failed uploads require an error" });
});
export const StudioBrandMaterialsQuery = z.object({
  search: z.string().trim().max(200).optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.number().int().min(1).max(60).default(24),
  libraryKind: z.enum(["MATERIAL", "TEMPLATE", "GENERATED", "ALL"]).default("ALL"),
}).strict();
export const StudioBrandMaterialOperation = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("verify") }).strict(),
  z.object({ operation: z.literal("link"), projectId: resourceId,
    assetSha256: StudioMaterial.shape.assetSha256 }).strict(),
]);
export const StudioBrandMaterialEntry = z.object({
  assetId: resourceId, fileName: z.string().min(1).max(255),
  mimeType: StudioMaterial.shape.mimeType, sizeBytes: z.number().int().min(0),
  libraryKind: z.enum(["MATERIAL", "TEMPLATE", "GENERATED"]),
  createdAt: z.string().datetime(),
  url: StudioMaterial.shape.url,
  material: StudioMaterial.optional(),
}).strict();
export const StudioBrandMaterialsPage = z.object({
  items: StudioBrandMaterialEntry.array().max(60),
  nextCursor: z.string().max(512).nullable(),
}).strict();
export const StudioBrandMaterialVerification = z.object({
  assetId: resourceId, taskId: resourceId.optional(),
  status: z.enum(["UNVERIFIED", "PENDING", "RUNNING", "SUCCEEDED", "FAILED"]),
  material: StudioMaterial.optional(), error: z.string().max(500).optional(),
}).strict().superRefine((value, context) => {
  if ((value.status === "SUCCEEDED") !== Boolean(value.material))
    context.addIssue({ code: "custom", message: "Only a verified asset carries a trusted material" });
  if (value.status === "FAILED" && !value.error)
    context.addIssue({ code: "custom", message: "Failed verification requires an error" });
});
export type StudioBrandMaterialEntry = z.infer<typeof StudioBrandMaterialEntry>;
export type StudioBrandMaterialVerification = z.infer<typeof StudioBrandMaterialVerification>;
