import { z } from "zod";

/** Current library state is deliberately separate from historical generation evidence. */
export const StudioBrandRuleStatus = z.object({
  workspaceId: z.string().min(1), brandName: z.string(), applicationEnabled: z.boolean(),
  confirmedCount: z.number().int().nonnegative(), draftCount: z.number().int().nonnegative(),
  savedDraftAvailable: z.boolean(),
}).strict();
export type StudioBrandRuleStatus = z.infer<typeof StudioBrandRuleStatus>;

/**
 * Result of comparing a finished render against the palette that was actually
 * sent to the model. Brand rules reach the model as prompt text, so a deviation
 * here means "the model did not follow", not "the rule was missing".
 */
export const StudioBrandColourFidelity = z.object({
  checked: z.boolean(),
  present: z.array(z.object({ hex: z.string(), share: z.number(), closestDetected: z.string(), deltaE: z.number() }).strict()),
  missing: z.array(z.string()),
  neutral: z.array(z.string()).default([]),
  detected: z.array(z.object({ hex: z.string(), share: z.number() }).strict()),
  withinBrand: z.boolean(),
}).strict();
export type StudioBrandColourFidelity = z.infer<typeof StudioBrandColourFidelity>;

export const StudioBrandRuleReceipt = z.object({
  outputId: z.string().min(1), appliedRuleCount: z.number().int().nonnegative().nullable(),
  mode: z.enum(["BRANDED", "FREE"]).nullable(),
  reason: z.enum(["APPLIED", "IMAGE_TOOL", "NO_APPLICABLE_RULES"]).nullable(),
  rules: z.array(z.object({ id: z.string().min(1), type: z.string(), summary: z.string(), strength: z.string() }).strict()),
  detailsComplete: z.boolean(), promptAdditionCount: z.number().int().nonnegative().nullable(),
  /** Absent for generations made before the check existed — never inferred. */
  colourFidelity: StudioBrandColourFidelity.nullable().default(null),
}).strict();
export type StudioBrandRuleReceipt = z.infer<typeof StudioBrandRuleReceipt>;
