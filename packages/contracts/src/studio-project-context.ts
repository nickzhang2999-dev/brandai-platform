import { z } from "zod";
import { NativeProjectQueryInput } from "./native-project";
import { StudioWorkflowTarget } from "./studio-workflow";
const id = NativeProjectQueryInput.shape.projectId;
const revision = z.number().int().min(0).max(2147483646);
export const StudioProjectContextFacts = z.object({ goal: z.string().trim().max(1000), audience: z.string().trim().max(1000),
  approvedCopy: z.string().trim().max(4000), visualRequirements: z.string().trim().max(2000) }).strict();
export const StudioProjectMaterialRole = z.enum(["PRODUCT", "BRAND", "COPY", "STYLE"]);
const source = z.object({ assetId: id, assetSha256: StudioWorkflowTarget.shape.assetSha256 }).strict();
const roleInput = source.extend({ role: StudioProjectMaterialRole });
const masterInput = source.extend({ shapeId: StudioWorkflowTarget.shape.shapeId.optional(), versionId: id.optional() });
export const StudioProjectContextSaveInput = z.object({ mutationId: z.string().uuid(), expectedRevision: revision,
  facts: StudioProjectContextFacts, materials: z.array(roleInput).max(7), master: masterInput.nullable(),
  documentRevision: revision.optional() }).strict().superRefine((value, context) => {
  if (new Set(value.materials.map(item => item.assetId)).size !== value.materials.length) context.addIssue({ code: "custom", path: ["materials"], message: "Each asset has one explicit responsibility" });
  if (value.master?.shapeId && value.documentRevision === undefined) context.addIssue({ code: "custom", path: ["documentRevision"], message: "A selected master requires the saved canvas revision" });
});
const metadata = { name: z.string().min(1).max(255), width: z.number().int().positive().max(16384), height: z.number().int().positive().max(16384), versionId: id.nullable() };
export const StudioProjectContextMaterial = roleInput.extend(metadata).strict();
export const StudioProjectContextMaster = source.extend({ ...metadata, shapeId: StudioWorkflowTarget.shape.shapeId.nullable() }).strict();
export const StudioProjectContextSnapshot = z.object({ projectId: id, revision,
  facts: StudioProjectContextFacts, materials: z.array(StudioProjectContextMaterial).max(7), master: StudioProjectContextMaster.nullable(),
  updatedAt: z.string().datetime().nullable() }).strict().superRefine((value, context) => {
  if (new Set(value.materials.map(item => item.assetId)).size !== value.materials.length) context.addIssue({ code: "custom", message: "Duplicate material responsibilities" });
});
export const StudioProjectContextIssue = z.object({ scope: z.enum(["material", "master"]), assetId: id,
  code: z.enum(["SOURCE_UNAVAILABLE", "SOURCE_CHANGED"]), message: z.string().min(1).max(500) }).strict();
export const StudioProjectContextView = z.object({ projectId: id, revision,
  facts: StudioProjectContextFacts, materials: z.array(StudioProjectContextMaterial).max(7), master: StudioProjectContextMaster.nullable(),
  updatedAt: z.string().datetime().nullable(), issues: z.array(StudioProjectContextIssue).max(8) }).strict();
export type StudioProjectContextSaveInput = z.infer<typeof StudioProjectContextSaveInput>;
export type StudioProjectContextSnapshot = z.infer<typeof StudioProjectContextSnapshot>;
export type StudioProjectContextView = z.infer<typeof StudioProjectContextView>;
export type StudioProjectContextIssue = z.infer<typeof StudioProjectContextIssue>;
