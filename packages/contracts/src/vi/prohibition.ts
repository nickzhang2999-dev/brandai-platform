import { z } from "zod";

/**
 * VI Module · Prohibition (禁用规范)
 *
 * Surface schema for the standalone `ProhibitionRule` table (rule-level, not
 * word-level — the latter remains in `ComplianceTerm`). Used both as a VI
 * module slot and as the wire shape for `/api/workspaces/[wsId]/prohibitions`.
 */
export const ProhibitionSeverity = z.enum(["HIGH", "MEDIUM", "LOW"]);
export type ProhibitionSeverity = z.infer<typeof ProhibitionSeverity>;

export const ProhibitionStatus = z.enum(["ACTIVE", "INACTIVE", "PENDING"]);
export type ProhibitionStatus = z.infer<typeof ProhibitionStatus>;

export const ProhibitionRule = z.object({
  id: z.string(),
  workspaceId: z.string(),
  severity: ProhibitionSeverity,
  affectsGeneration: z.boolean().default(true),
  affectsValidation: z.boolean().default(true),
  description: z.string(),
  scope: z.array(z.string()).default([]),
  positiveExampleAssetId: z.string().optional(),
  negativeExampleAssetId: z.string().optional(),
  alternativeSuggestion: z.string().optional(),
  applicableChannels: z.array(z.string()).default([]),
  status: ProhibitionStatus.default("ACTIVE"),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProhibitionRule = z.infer<typeof ProhibitionRule>;

export const CreateProhibitionRuleInput = z.object({
  severity: ProhibitionSeverity,
  affectsGeneration: z.boolean().default(true),
  affectsValidation: z.boolean().default(true),
  description: z.string().min(1),
  scope: z.array(z.string()).default([]),
  positiveExampleAssetId: z.string().optional(),
  negativeExampleAssetId: z.string().optional(),
  alternativeSuggestion: z.string().optional(),
  applicableChannels: z.array(z.string()).default([]),
  status: ProhibitionStatus.default("ACTIVE"),
});
export type CreateProhibitionRuleInput = z.infer<
  typeof CreateProhibitionRuleInput
>;

export const UpdateProhibitionRuleInput = CreateProhibitionRuleInput.partial();
export type UpdateProhibitionRuleInput = z.infer<
  typeof UpdateProhibitionRuleInput
>;

// VI module slot variant (for embedding inside BrandRule.structured).
export const ProhibitionModule = z.object({
  module: z.literal("prohibition"),
  rules: z.array(CreateProhibitionRuleInput).optional(),
  extras: z.record(z.unknown()).optional(),
});
export type ProhibitionModule = z.infer<typeof ProhibitionModule>;
