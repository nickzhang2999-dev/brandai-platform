import { z } from "zod";

/**
 * VI Module · Color (色彩规范)
 *
 * Covers primary/secondary palette swatches, cmyk/pantone breakdown,
 * usage priority, allowed/prohibited combinations, deviation threshold,
 * gradient policy, brightness/saturation preferences.
 */
const Hex = z
  .string()
  .regex(/^#?[0-9a-fA-F]{3,8}$/, "invalid hex color")
  .optional();

const ColorSwatch = z.object({
  name: z.string().optional(),
  hex: Hex,
  cmyk: z
    .object({
      c: z.number().min(0).max(100).optional(),
      m: z.number().min(0).max(100).optional(),
      y: z.number().min(0).max(100).optional(),
      k: z.number().min(0).max(100).optional(),
    })
    .optional(),
  pantone: z.string().optional(),
  usage_priority: z.enum(["primary", "secondary", "accent", "neutral"]).optional(),
});
export type ColorSwatch = z.infer<typeof ColorSwatch>;

export const ColorModule = z.object({
  module: z.literal("color"),
  palette: z.array(ColorSwatch).optional(),
  // Pairings/combinations expressed as ordered tuples of hex strings.
  combination_rules: z.array(z.array(z.string())).optional(),
  prohibited_combinations: z.array(z.array(z.string())).optional(),
  deviation_threshold: z.number().min(0).max(100).optional(),
  allow_gradient: z.boolean().optional(),
  brightness_preference: z.enum(["light", "neutral", "dark"]).optional(),
  saturation_preference: z.enum(["low", "medium", "high"]).optional(),
  extras: z.record(z.unknown()).optional(),
});
export type ColorModule = z.infer<typeof ColorModule>;
