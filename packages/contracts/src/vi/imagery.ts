import { z } from "zod";

/**
 * VI Module · Imagery (影像风格)
 */
export const ImageryModule = z.object({
  module: z.literal("imagery"),
  style_keywords: z.array(z.string()).optional(),
  lighting_rule: z.string().optional(),
  composition_rule: z.string().optional(),
  // TODO confirm with brand owner: deeper imagery taxonomy.
  prohibited_visuals: z.array(z.string()).optional(),
  extras: z.record(z.unknown()).optional(),
});
export type ImageryModule = z.infer<typeof ImageryModule>;
