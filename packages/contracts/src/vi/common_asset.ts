import { z } from "zod";

/**
 * VI Module · Common Asset Library (常用素材库)
 *
 * Catalogs reusable assets (mascots, signature props, etc.). Outside the
 * `RuleType` enum — used as a profile module on the workspace.
 */
const CommonAssetEntry = z.object({
  assetId: z.string(),
  role: z.string().optional(),
  notes: z.string().optional(),
});

export const CommonAssetModule = z.object({
  module: z.literal("common_asset"),
  entries: z.array(CommonAssetEntry).optional(),
  extras: z.record(z.unknown()).optional(),
});
export type CommonAssetModule = z.infer<typeof CommonAssetModule>;
