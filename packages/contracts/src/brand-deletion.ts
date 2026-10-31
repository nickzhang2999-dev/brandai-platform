import { z } from "zod";

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const count = z.number().int().nonnegative();
export const BrandDeletionCounts = z.object({
  projects: count, assets: count, rules: count, terms: count,
  prohibitions: count, inspirationCases: count, members: count,
}).strict();
export const BrandDeletionPreview = z.object({
  workspaceId: id, name: z.string().min(1).max(80), counts: BrandDeletionCounts,
  activeTasks: count, canDelete: z.boolean(), blockedReason: z.string().min(1).max(300).nullable(),
  confirmationToken: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().refine(value => value.canDelete === (value.activeTasks === 0)
  && (value.canDelete ? value.blockedReason === null : value.blockedReason !== null), "Invalid deletion readiness");
export const BrandDeletionInput = z.object({
  confirmationName: z.string().min(1).max(80),
  confirmationToken: z.string().regex(/^[a-f0-9]{64}$/), mutationId: z.string().uuid(),
}).strict();
export const BrandDeletionResult = z.object({
  ok: z.literal(true), deletedWorkspaceId: id, nextWorkspaceId: id.nullable(), redirectTo: z.string(),
}).strict().refine(value => value.redirectTo === (value.nextWorkspaceId
  ? `/studio?workspaceId=${encodeURIComponent(value.nextWorkspaceId)}#/home` : "/studio"), "Invalid deletion destination");
export type BrandDeletionPreview = z.infer<typeof BrandDeletionPreview>;
export type BrandDeletionInput = z.infer<typeof BrandDeletionInput>;
export type BrandDeletionResult = z.infer<typeof BrandDeletionResult>;
