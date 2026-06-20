import { z } from "zod";

/**
 * VI Module · Product (产品展示规范)
 *
 * Note: not in the existing `RuleType` enum — this module is exported
 * separately and stored via `BrandRule.structured.product` slot when a brand
 * chooses to capture product rules. Mapped onto `RuleType=imagery` for now
 * (closest existing bucket) until P2.0 extends the enum.
 */
export const ProductModule = z.object({
  module: z.literal("product"),
  standard_angle: z.array(z.string()).optional(),
  prohibited_angle: z.array(z.string()).optional(),
  allow_crop: z.boolean().optional(),
  allow_occlusion: z.boolean().optional(),
  allow_tilt: z.boolean().optional(),
  allow_distortion: z.boolean().optional(),
  product_scale_rule: z.string().optional(),
  product_clarity_rule: z.string().optional(),
  prop_pairing_rules: z.array(z.string()).optional(),
  prohibited_props: z.array(z.string()).optional(),
  extras: z.record(z.unknown()).optional(),
});
export type ProductModule = z.infer<typeof ProductModule>;
