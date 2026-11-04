import { z } from "zod";

export const VisualFidelityRevision = z.literal("visual-fidelity-guard/1");
export const VisualFidelitySha256 = z.string().regex(/^[a-f0-9]{64}$/);
const Text = z.string().trim().min(1).max(4000);
export const VisualFidelityConstraint = z.object({
  id: Text, target: Text, attribute: Text, expected: Text,
  strength: z.enum(["hard", "soft"]), source: z.enum(["user", "brand", "source"]),
}).strict();
export type VisualFidelityConstraint = z.infer<typeof VisualFidelityConstraint>;
export const VisualFidelityPlan = z.object({
  revision: VisualFidelityRevision, inputSha256: VisualFidelitySha256,
  constraints: z.array(VisualFidelityConstraint).max(64),
}).strict().refine(p => new Set(p.constraints.map(c => c.id)).size === p.constraints.length, "Duplicate constraint IDs");
export type VisualFidelityPlan = z.infer<typeof VisualFidelityPlan>;
export const VisualFidelitySourceImage = z.object({
  id: z.string().min(1).max(128).optional(),
  role: z.enum(["edit-source", "reference-context"]).optional(),
  note: z.string().max(4000).optional(),
  url: z.string().min(1), sha256: VisualFidelitySha256,
  sourceHint: z.enum(["UPLOAD", "WEBSITE"]).optional(),
}).strict();
export type VisualFidelitySourceImage = z.infer<typeof VisualFidelitySourceImage>;
export const VisualFidelityCheck = z.object({
  id: Text, status: z.enum(["pass", "fail", "unknown"]),
  objectRegion: Text.optional(), observation: Text, evidence: Text,
}).strict();
export type VisualFidelityCheck = z.infer<typeof VisualFidelityCheck>;
export const VisualFidelityReport = z.object({
  revision: VisualFidelityRevision, inputSha256: VisualFidelitySha256,
  outputSha256: VisualFidelitySha256,
  overall: z.enum(["pass", "fail", "unknown", "not_applicable"]),
  checkPerformed: z.boolean(), checks: z.array(VisualFidelityCheck), warnings: z.array(Text),
}).strict();
export type VisualFidelityReport = z.infer<typeof VisualFidelityReport>;
