import { z } from "zod";

/**
 * VI Module · Channel & Size (渠道与尺寸适配)
 *
 * Not in the `RuleType` enum — exported separately for forms that build
 * channel preset libraries.
 */
const ChannelPreset = z.object({
  channel: z.string(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  safe_zone: z.string().optional(),
  notes: z.string().optional(),
});

export const ChannelSizeModule = z.object({
  module: z.literal("channel_size"),
  presets: z.array(ChannelPreset).optional(),
  default_channels: z.array(z.string()).optional(),
  extras: z.record(z.unknown()).optional(),
});
export type ChannelSizeModule = z.infer<typeof ChannelSizeModule>;
