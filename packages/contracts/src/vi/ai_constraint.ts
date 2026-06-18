import { z } from "zod";

/**
 * VI Module · AI Constraint (生成模型硬约束)
 *
 * Outside the `RuleType` enum — fed directly into M3 generation params and
 * compliance hooks (deterministic guards, not style guidance).
 */
export const AIConstraintModule = z.object({
  module: z.literal("ai_constraint"),
  negative_prompt: z.array(z.string()).optional(),
  required_elements: z.array(z.string()).optional(),
  max_text_length: z.number().int().positive().optional(),
  forbid_real_persons: z.boolean().optional(),
  forbid_celebrity_likeness: z.boolean().optional(),
  // TODO confirm with brand owner: per-channel constraint overrides.
  extras: z.record(z.unknown()).optional(),
});
export type AIConstraintModule = z.infer<typeof AIConstraintModule>;
