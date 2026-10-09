import { z } from "zod";
import { NativeProjectQueryInput } from "./native-project";

const shapeId = z.string().min(7).max(200).regex(/^shape:[\x21-\x7e]+$/).refine(value => !value.includes("\n"));
const sha256 = z.string().length(64).regex(/^[a-f0-9]{64}$/);
export const StudioWorkflowTarget = z.object({ shapeId, assetSha256: sha256 }).strict();
export const StudioWorkflowReference = z.object({
  shapeId: shapeId.nullable(), assetSha256: sha256,
  purpose: z.enum(["EXACT", "ADAPTIVE", "REFERENCE"]).nullable(), participates: z.boolean(),
}).strict().refine(value => !value.participates || value.purpose !== null, "参与素材必须明确用途");
const fields = NativeProjectQueryInput.pick({ projectId: true }).extend({
  revision: z.number().int().min(0).max(2147483646), mode: z.enum(["generate", "modify"]),
  target: StudioWorkflowTarget.nullable(), references: z.array(StudioWorkflowReference).max(8),
}).strict();
function validSelection(value: z.infer<typeof fields>) {
  return (value.mode === "modify" ? value.target !== null : value.target === null)
    && new Set(value.references.map(ref => JSON.stringify([ref.shapeId, ref.assetSha256]))).size === value.references.length;
}
export const StudioWorkflowSaveInput = fields.refine(validSelection, "目标或素材选择不正确");
export const StudioWorkflowIssue = z.object({
  code: z.string(), scope: z.enum(["asset", "reference", "target"]),
  shapeId: shapeId.nullable(), assetSha256: sha256.nullable(),
  message: z.string(), blocking: z.boolean(), index: z.number().int().min(0).max(7).optional(),
}).strict();
export const StudioWorkflowView = fields.extend({
  revision: z.number().int().min(0).max(2147483647),
  updatedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  issues: z.array(StudioWorkflowIssue),
}).strict().refine(validSelection, "目标或素材选择不正确");
export const StudioWorkflowAssets = NativeProjectQueryInput.pick({ projectId: true }).extend({
  assets: z.array(z.object({
    shapeId, assetSha256: sha256, name: z.string().max(255),
    width: z.number().positive().finite().nullable(), height: z.number().positive().finite().nullable(),
    valid: z.boolean(), mime: z.string(),
  }).strict()),
  issues: z.array(StudioWorkflowIssue),
}).strict();
export type StudioWorkflowSaveInput = z.infer<typeof StudioWorkflowSaveInput>;
export type StudioWorkflowView = z.infer<typeof StudioWorkflowView>;
export type StudioWorkflowAssets = z.infer<typeof StudioWorkflowAssets>;
export type StudioWorkflowIssue = z.infer<typeof StudioWorkflowIssue>;
