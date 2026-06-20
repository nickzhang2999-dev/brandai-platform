import { z } from "zod";

/**
 * VI Module · Font (字体规范)
 */
export const FontModule = z.object({
  module: z.literal("font"),
  primary_font: z.string().optional(),
  secondary_font: z.string().optional(),
  fallback_fonts: z.array(z.string()).optional(),
  letter_spacing_rule: z.string().optional(),
  line_height_rule: z.string().optional(),
  license_status: z.enum(["LICENSED", "FREE", "UNKNOWN", "RISK"]).optional(),
  minimum_font_size: z
    .object({
      digital: z.string().optional(),
      print: z.string().optional(),
    })
    .optional(),
  text_hierarchy_rule: z.string().optional(),
  allow_text_stroke: z.boolean().optional(),
  allow_text_shadow: z.boolean().optional(),
  allow_text_distortion: z.boolean().optional(),
  extras: z.record(z.unknown()).optional(),
});
export type FontModule = z.infer<typeof FontModule>;
