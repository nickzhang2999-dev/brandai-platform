import { z } from "zod";

/** Current library state is deliberately separate from historical generation evidence. */
export const StudioBrandRuleStatus = z.object({
  workspaceId: z.string().min(1), brandName: z.string(), applicationEnabled: z.boolean(),
  confirmedCount: z.number().int().nonnegative(), draftCount: z.number().int().nonnegative(),
  savedDraftAvailable: z.boolean(),
}).strict();
export type StudioBrandRuleStatus = z.infer<typeof StudioBrandRuleStatus>;

export const StudioBrandRuleReceipt = z.object({
  outputId: z.string().min(1), appliedRuleCount: z.number().int().nonnegative().nullable(),
  mode: z.enum(["BRANDED", "FREE"]).nullable(),
  reason: z.enum(["APPLIED", "IMAGE_TOOL", "NO_APPLICABLE_RULES"]).nullable(),
  rules: z.array(z.object({ id: z.string().min(1), type: z.string(), summary: z.string(), strength: z.string() }).strict()),
  detailsComplete: z.boolean(), promptAdditionCount: z.number().int().nonnegative().nullable(),
}).strict();
export type StudioBrandRuleReceipt = z.infer<typeof StudioBrandRuleReceipt>;
