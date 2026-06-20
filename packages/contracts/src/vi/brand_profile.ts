import { z } from "zod";

/**
 * VI Module · Brand Profile (品牌画像 / 调性)
 *
 * Outside the `RuleType` enum — informs prompt construction in M3.
 */
export const BrandProfileModule = z.object({
  module: z.literal("brand_profile"),
  industry: z.string().optional(),
  positioning: z.string().optional(),
  target_audience: z.string().optional(),
  brand_personality: z.array(z.string()).optional(),
  voice: z.string().optional(),
  // TODO confirm with brand owner: audience persona schema.
  extras: z.record(z.unknown()).optional(),
});
export type BrandProfileModule = z.infer<typeof BrandProfileModule>;
