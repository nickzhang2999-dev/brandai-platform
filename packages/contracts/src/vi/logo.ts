import { z } from "zod";

/**
 * VI Module · Logo
 *
 * Strong-typed Logo规范 fields per VI spec. All fields optional so existing
 * `BrandRule.value` (free-form Json) can be migrated incrementally; `extras`
 * carries any uncovered keys forward without contract churn.
 */
export const LogoModule = z.object({
  module: z.literal("logo"),
  clear_space_rule: z.string().optional(),
  minimum_size: z
    .object({
      digital: z.string().optional(),
      print: z.string().optional(),
    })
    .optional(),
  allow_stroke: z.boolean().optional(),
  allow_shadow: z.boolean().optional(),
  allow_rotation: z.boolean().optional(),
  allow_distortion: z.boolean().optional(),
  allow_crop: z.boolean().optional(),
  allow_opacity_change: z.boolean().optional(),
  logo_dont_rules: z.array(z.string()).optional(),
  primary_logo_asset_id: z.string().optional(),
  variants: z.array(z.string()).optional(),
  extras: z.record(z.unknown()).optional(),
});
export type LogoModule = z.infer<typeof LogoModule>;
