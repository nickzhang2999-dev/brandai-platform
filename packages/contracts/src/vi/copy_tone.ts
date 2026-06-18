import { z } from "zod";

/**
 * VI Module · Copy Tone (文案语气)
 *
 * Mapped onto `RuleType=copy` in BrandRule.
 */
export const CopyToneModule = z.object({
  module: z.literal("copy_tone"),
  tone_keywords: z.array(z.string()).optional(),
  prohibited_words: z.array(z.string()).optional(),
  preferred_words: z.array(z.string()).optional(),
  promotion_copy_rule: z.string().optional(),
  punctuation_rule: z.string().optional(),
  cta_rule: z.string().optional(),
  // TODO confirm with brand owner: industry-specific compliance overlay.
  extras: z.record(z.unknown()).optional(),
});
export type CopyToneModule = z.infer<typeof CopyToneModule>;
