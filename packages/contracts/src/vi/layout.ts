import { z } from "zod";

/**
 * VI Module · Layout (版式构图)
 */
export const LayoutModule = z.object({
  module: z.literal("layout"),
  grid_system: z.string().optional(),
  safe_margin_rule: z.string().optional(),
  alignment_preference: z.enum(["left", "center", "right", "justify"]).optional(),
  whitespace_ratio: z.number().min(0).max(1).optional(),
  // TODO confirm with brand owner: scenario-specific layout templates.
  extras: z.record(z.unknown()).optional(),
});
export type LayoutModule = z.infer<typeof LayoutModule>;
