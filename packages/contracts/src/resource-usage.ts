import { z } from "zod";
import { AssetInvocationMode } from "./enums";

/**
 * V0.0.21 — EXACT locks the asset's identity/content while allowing explicit,
 * deterministic geometry changes. Coordinates are normalized to the selected
 * output frame so the same layout scales from 1K to 2K without drift.
 */
export const ExactAssetCrop = z
  .object({
    left: z.number().min(0).max(0.95).default(0),
    top: z.number().min(0).max(0.95).default(0),
    right: z.number().min(0).max(0.95).default(0),
    bottom: z.number().min(0).max(0.95).default(0),
  })
  .superRefine((crop, ctx) => {
    if (crop.left + crop.right >= 0.98) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "左右裁切后必须保留可见内容",
      });
    }
    if (crop.top + crop.bottom >= 0.98) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "上下裁切后必须保留可见内容",
      });
    }
  });
export type ExactAssetCrop = z.infer<typeof ExactAssetCrop>;

export const ExactAssetTransform = z.object({
  /** Layer center relative to the output frame; limited overflow enables partial display. */
  xRatio: z.number().min(-0.5).max(1.5).default(0.5),
  yRatio: z.number().min(-0.5).max(1.5).default(0.5),
  /** Visible layer width relative to the output frame width. */
  widthRatio: z.number().positive().max(3).default(0.35),
  rotationDeg: z.number().min(-360).max(360).default(0),
  flipX: z.boolean().default(false),
  crop: ExactAssetCrop.default({
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
  }),
  zIndex: z.number().int().min(-100).max(100).default(0),
});
export type ExactAssetTransform = z.infer<typeof ExactAssetTransform>;

const usageBase = {
  assetId: z.string(),
  /** Stable ordering for /images/edits multipart inputs and layer stacking. */
  order: z.number().int().min(0).max(99).default(0),
};

/**
 * One project asset's role in a generation.
 * - EXACT: original/confirmed source pixels, transformed and composited after AI.
 * - ADAPTIVE: real /images/edits input; model may harmonize/redraw it.
 * - REFERENCE: real /images/edits input for style/palette/composition only.
 */
export const AssetUsageInput = z.discriminatedUnion("mode", [
  z.object({
    ...usageBase,
    mode: z.literal("EXACT"),
    exactTransform: ExactAssetTransform.default({
      xRatio: 0.5,
      yRatio: 0.5,
      widthRatio: 0.35,
      rotationDeg: 0,
      flipX: false,
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
      zIndex: 0,
    }),
  }),
  z.object({
    ...usageBase,
    mode: z.literal("ADAPTIVE"),
  }),
  z.object({
    ...usageBase,
    mode: z.literal("REFERENCE"),
  }),
]);
export type AssetUsageInput = z.infer<typeof AssetUsageInput>;

/** Durable ProjectAsset configuration. Legacy links may omit both fields. */
export const ProjectAssetUsageConfig = z.object({
  usageMode: AssetInvocationMode.optional(),
  exactTransform: ExactAssetTransform.optional(),
});
export type ProjectAssetUsageConfig = z.infer<typeof ProjectAssetUsageConfig>;
