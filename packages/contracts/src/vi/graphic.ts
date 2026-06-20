import { z } from "zod";

/**
 * VI Module · Graphic (辅助图形)
 */
export const GraphicModule = z.object({
  module: z.literal("graphic"),
  pattern_library: z.array(z.string()).optional(),
  shape_language: z.string().optional(),
  // TODO confirm with brand owner: per-shape stroke/scale tokens.
  allow_decoration: z.boolean().optional(),
  prohibited_graphics: z.array(z.string()).optional(),
  extras: z.record(z.unknown()).optional(),
});
export type GraphicModule = z.infer<typeof GraphicModule>;
