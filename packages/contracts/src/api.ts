import { z } from "zod";
import {
  AssetCategory,
  AssetInvocationMode,
  AssetLibraryKind,
  ComplianceTermType,
  EditOp,
  RuleStatus,
  RuleStrength,
  SceneType,
} from "./enums";
import { SizeSpec } from "./ai";
import { Asset } from "./entities";

/** Web BFF (Next.js Route Handlers) request schemas. */

export const CreateWorkspaceInput = z.object({
  name: z.string().min(1),
  industry: z.string().optional(),
  websiteUrl: z.string().url().optional(),
});
export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceInput>;

export const CreateAssetInput = z.object({
  workspaceId: z.string(),
  category: AssetCategory,
  libraryKind: AssetLibraryKind.default("MATERIAL"),
  fileName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  /** storage key returned by the presign step */
  storageKey: z.string(),
  source: z.enum(["UPLOAD", "WEBSITE"]).default("UPLOAD"),
});
export type CreateAssetInput = z.infer<typeof CreateAssetInput>;

export const UpdateAssetTagsMode = z.enum(["append", "remove", "replace"]);
export type UpdateAssetTagsMode = z.infer<typeof UpdateAssetTagsMode>;

export const BatchUpdateAssetTagsInput = z.object({
  assetIds: z.array(z.string()).min(1).max(200),
  tags: z.array(z.string().min(1).max(32)).max(50),
  mode: UpdateAssetTagsMode.default("append"),
});
export type BatchUpdateAssetTagsInput = z.infer<
  typeof BatchUpdateAssetTagsInput
>;

export const PresignUploadInput = z.object({
  workspaceId: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
});
export type PresignUploadInput = z.infer<typeof PresignUploadInput>;

export const PresignUploadOutput = z.object({
  uploadUrl: z.string(),
  storageKey: z.string(),
  publicUrl: z.string(),
});
export type PresignUploadOutput = z.infer<typeof PresignUploadOutput>;

export const WatermarkAnchor = z.enum([
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
]);
export type WatermarkAnchor = z.infer<typeof WatermarkAnchor>;

export const WatermarkPositionMode = z.enum(["pixel", "ratio"]);
export type WatermarkPositionMode = z.infer<typeof WatermarkPositionMode>;

export const WatermarkOverlayInput = z.object({
  assetId: z.string().optional(),
  text: z.string().max(120).optional(),
  invocationMode: AssetInvocationMode.default("EXACT"),
  lockAspectRatio: z.boolean().default(true),
  allowRecolor: z.boolean().default(false),
  enabled: z.boolean().default(true),
  anchor: WatermarkAnchor.default("bottom-right"),
  positionMode: WatermarkPositionMode.default("pixel"),
  offsetX: z.number().finite().default(24),
  offsetY: z.number().finite().default(24),
  widthPx: z.number().finite().positive().max(4096).default(120),
  fontFamily: z.string().max(80).default("Inter"),
  fontSizePx: z.number().finite().positive().max(512).default(28),
  opacity: z.number().finite().min(0).max(1).default(0.6),
  textColor: z.string().max(32).default("#111827"),
  backgroundEnabled: z.boolean().default(false),
  backgroundColor: z.string().max(32).default("#FFFFFF"),
  borderEnabled: z.boolean().default(false),
  borderColor: z.string().max(32).default("#7C5CFF"),
  borderWidth: z.number().finite().min(0).max(40).default(1),
  cornerRadius: z.number().finite().min(0).max(160).default(0),
});
export type WatermarkOverlayInput = z.infer<typeof WatermarkOverlayInput>;

export const WatermarkPresetInput = z.object({
  name: z.string().min(1).max(80).default("默认水印"),
  isActive: z.boolean().default(false),
  config: WatermarkOverlayInput,
});
export type WatermarkPresetInput = z.infer<typeof WatermarkPresetInput>;

export const IngestWebsiteInput = z.object({
  workspaceId: z.string(),
  url: z.string().url(),
});
export type IngestWebsiteInput = z.infer<typeof IngestWebsiteInput>;

export const UpdateRuleInput = z.object({
  status: RuleStatus.optional(),
  strength: RuleStrength.optional(),
  summary: z.string().optional(),
  value: z.record(z.unknown()).optional(),
  /** P1.1 — strong-typed VI module payload. Validated against MODULE_BY_NAME at the route. */
  structured: z.record(z.unknown()).optional(),
});
export type UpdateRuleInput = z.infer<typeof UpdateRuleInput>;

export const CreateComplianceTermInput = z.object({
  workspaceId: z.string(),
  type: ComplianceTermType,
  term: z.string().min(1),
  reason: z.string(),
  replacement: z.string().optional(),
});
export type CreateComplianceTermInput = z.infer<
  typeof CreateComplianceTermInput
>;

export const CreateProjectInput = z.object({
  workspaceId: z.string(),
  name: z.string().min(1),
  campaign: z.string().optional(),
  product: z.string().optional(),
  channel: z.string().optional(),
});
export type CreateProjectInput = z.infer<typeof CreateProjectInput>;

export const CreateGenerationInput = z.object({
  projectId: z.string(),
  sceneType: SceneType,
  sellingPoint: z.string().optional().default(""),
  scene: z.string().optional().default(""),
  versionCount: z.number().int().min(1).max(8).default(2),
  /**
   * P2.0 — when set, generate one image per target size (each at its own
   * W×H) instead of `versionCount` same-size versions. Empty/absent → legacy
   * versionCount path.
   */
  targets: z.array(SizeSpec).max(12).optional(),
  /**
   * M3 — text rendering strategy threaded down to the AI service's
   * GenerateRequest. `direct` (default) keeps legacy behavior; `layered` steers
   * the model to leave clean negative space and render NO text, so the client
   * can overlay crisp editable text. Frozen-additive.
   */
  textMode: z.enum(["direct", "layered"]).default("direct"),
  /**
   * F7 — per-generation style keywords. The worker appends these into the
   * compiled `AIConstraints.promptAdditions` so the AI service folds them into
   * the prompt (no AI-service contract change). Frozen-additive: optional, no
   * default, bounded.
   */
  styleKeywords: z.array(z.string()).max(20).optional(),
  /**
   * F9 / L8 — per-generation reference asset ids (素材库 references). Each must
   * belong to the same workspace (IDOR-checked at the route, see
   * lib/prohibitions.ts::assertExampleAssetsInWorkspace). The worker resolves
   * each to its asset URL and pushes a positive `referenceImage` into the
   * compiled `AIConstraints`. Frozen-additive: optional, no default, bounded.
   */
  referenceAssetIds: z.array(z.string()).max(8).optional(),
  /**
   * V0.0.7 — reference assets with explicit usage mode:
   * STRICT = 必须 100% 调用（内容不可改，仅尺寸/颜色可调）；
   * INSPIRATION = 仿制借鉴（允许改写与再创作）。 `referenceAssetIds`
   * stays as a legacy shorthand and is treated as INSPIRATION.
   */
  referenceAssets: z
    .array(
      z.object({
        assetId: z.string(),
        mode: z.enum(["STRICT", "INSPIRATION"]).default("INSPIRATION"),
      }),
    )
    .max(8)
    .optional(),
  /**
   * V0.0.9 — template library references. These are style/proportion/color
   * inspiration only and must never be deterministically overlaid.
   */
  templateReferenceAssetIds: z.array(z.string()).max(8).optional(),
  /**
   * V0.0.9 — material library overlays. These are not sent to the AI provider;
   * the web worker composites them after the base image is generated.
   */
  watermarkOverlays: z.array(WatermarkOverlayInput).max(8).optional(),
});
export type CreateGenerationInput = z.infer<typeof CreateGenerationInput>;

/**
 * E8 Campaign Kit — one brief → a whole set of channel materials. Fans out to
 * one Generation per `scenes[]` entry (each producing one image per `targets[]`
 * size), all under the same Project. The quota for the whole kit is checked
 * once up-front so a user never gets a half-finished set.
 */
export const CampaignKitInput = z.object({
  projectId: z.string(),
  sellingPoint: z.string().optional().default(""),
  scene: z.string().optional().default(""),
  scenes: z.array(SceneType).min(1).max(5),
  targets: z.array(SizeSpec).min(1).max(12),
  textMode: z.enum(["direct", "layered"]).default("direct"),
});
export type CampaignKitInput = z.infer<typeof CampaignKitInput>;

export const EditVersionInput = z.object({
  op: EditOp,
  payload: z.record(z.unknown()).default({}),
  /**
   * V0.0.11 — material library overlays for edited images. Same semantics as
   * CreateGenerationInput.watermarkOverlays: these are not sent to the AI
   * provider; the edit worker composites them after the edited base image is
   * returned.
   */
  watermarkOverlays: z.array(WatermarkOverlayInput).max(8).optional(),
});
export type EditVersionInput = z.infer<typeof EditVersionInput>;

export const PrecheckInput = z.object({
  workspaceId: z.string(),
  text: z.string(),
});
export type PrecheckInput = z.infer<typeof PrecheckInput>;

/**
 * M-B — change own password (/account). `currentPassword` is verified against
 * the stored hash before the new one is written; users who registered via OAuth
 * (no passwordHash) are told to use their provider instead. `newPassword` keeps
 * the same min-8 floor as registration.
 */
export const ChangePasswordInput = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});
export type ChangePasswordInput = z.infer<typeof ChangePasswordInput>;

export const UpdateProfileInput = z.object({
  name: z.string().trim().min(1).max(40),
});
export type UpdateProfileInput = z.infer<typeof UpdateProfileInput>;

/**
 * E11/E12 — durable Project↔Asset link. `MEMBER` = 加入项目（素材属于该
 * Campaign）；`REFERENCE` = 设为参考（工作台出图带入）。Replaces the browser-only
 * reference tray with a server-authoritative relation.
 */
export const ProjectAssetKind = z.enum(["MEMBER", "REFERENCE"]);
export type ProjectAssetKind = z.infer<typeof ProjectAssetKind>;

export const LinkProjectAssetInput = z.object({
  assetId: z.string(),
  kind: ProjectAssetKind.default("MEMBER"),
});
export type LinkProjectAssetInput = z.infer<typeof LinkProjectAssetInput>;

export const ProjectAssetLink = z.object({
  id: z.string(),
  projectId: z.string(),
  kind: ProjectAssetKind,
  createdAt: z.string(),
  asset: Asset,
});
export type ProjectAssetLink = z.infer<typeof ProjectAssetLink>;

export const ApiError = z.object({
  error: z.string(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiError>;
