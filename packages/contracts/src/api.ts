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
import { GenerationSizeSelection, SizeSpec } from "./ai";
import { Asset } from "./entities";
import { AssetUsageInput, ExactAssetTransform } from "./resource-usage";

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

/**
 * V0.0.13 — 对话面板（AI 设计师）的图像输入引用：一次图生图/多图生图请求里，
 * 用户按序选中的历史出图版本(VERSION)或素材(ASSET)。worker 把它们解析成
 * STRICT referenceImages（note=IMAGE_INPUT:{序号}），单图与多图共用同一条
 * /images/edits multipart 路径。与 V0.0.12 的「素材 STRICT→水印叠加」
 * 「模板参考→INSPIRATION」语义互不干扰。
 */
export const ImageInputRef = z.object({
  kind: z.enum(["VERSION", "ASSET"]),
  id: z.string(),
});
export type ImageInputRef = z.infer<typeof ImageInputRef>;

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
   * V0.0.20 — workbench ratio/clarity intent. The API resolves this into an
   * enriched SizeSpec so clients cannot spoof provider pixels or quality.
   */
  sizeSelection: GenerationSizeSelection.optional(),
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
  /**
   * V0.0.13 — 对话面板图生图/多图生图输入（有序，≤8，跨 workspace 引用在
   * route 层做归属校验）。Frozen-additive。
   */
  imageInputs: z.array(ImageInputRef).max(8).optional(),
  /**
   * V0.0.21 — project resources with explicit execution semantics. EXACT
   * layers never reach the image provider; ADAPTIVE/REFERENCE are ordered real
   * image inputs. Kept separate from chat imageInputs so the resource panel is
   * server-authoritative and auditable.
   */
  assetUsages: z.array(AssetUsageInput).max(8).optional(),
  /**
   * V0.0.13 — 会话气泡里展示的用户原文。与模型 prompt 彻底分离（规避
   * prd_agent「引用块/文件名泄漏进可见消息」bug）：本字段仅存展示，服务端
   * 不对它做任何拼接。Frozen-additive。
   */
  chatDisplayText: z.string().max(2000).optional(),
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
  /**
   * V0.0.21 — EXACT resources are re-composited after the AI edits the clean
   * base image. Omitted requests inherit the source version's asset usages.
   */
  assetUsages: z.array(AssetUsageInput).max(8).optional(),
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
  usageMode: AssetInvocationMode.optional(),
  exactTransform: ExactAssetTransform.optional(),
});
export type LinkProjectAssetInput = z.infer<typeof LinkProjectAssetInput>;

export const ProjectAssetLink = z.object({
  id: z.string(),
  projectId: z.string(),
  kind: ProjectAssetKind,
  usageMode: AssetInvocationMode.optional(),
  exactTransform: ExactAssetTransform.optional(),
  createdAt: z.string(),
  asset: Asset,
});
export type ProjectAssetLink = z.infer<typeof ProjectAssetLink>;

/* ------------------------------------------------------------------ *
 * 图层分解（AI 分层）—— BFF 侧契约
 *
 * 存放位置的取舍（方案 A）：一次分解产出 N 个 `GenerationVersion` 子版本，
 * 父版本 = 被拆的那一版。这样导出、终稿、素材库回流、配额、审批全部沿用
 * 现成链路，不用为图层再造四条支路；代价是变体网格必须把一个图层组折叠成
 * 一张卡（`params.layerRole === "layer"` 的版本不单独占格）。
 * ------------------------------------------------------------------ */

export const DecomposeVersionInput = z.object({
  layerCount: z.number().int().min(1).max(10).default(4),
  intent: z.string().trim().max(500).optional(),
});
export type DecomposeVersionInput = z.infer<typeof DecomposeVersionInput>;

/** 实墨包围盒，坐标相对图层自身像素。求不出（整层全透明）时缺省。 */
export const LayerBounds = z.object({
  left: z.number().int().nonnegative(),
  top: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type LayerBounds = z.infer<typeof LayerBounds>;

export const LayerView = z.object({
  versionId: z.string(),
  /** 在本组内的序号，0 起。上游返回顺序即叠放顺序（先返回的在下）。 */
  index: z.number().int().nonnegative(),
  imageUrl: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bounds: LayerBounds.optional(),
  /** 实墨（alpha ≥ 64）像素占全幅的比例，0–1。 */
  inkCoverage: z.number().min(0).max(1),
  /**
   * 细层标记：实墨覆盖率极低。**只是标记，不是「空层」，绝不据此默认隐藏。**
   * 真上游实测里那组绿色取景框角标覆盖率只有 0.12%，是真实设计元素；
   * prd_agent 的 0.2% 空层线会把它默认藏起来，用户以为没拆出来。
   */
  thin: z.boolean(),
  hidden: z.boolean(),
  opacity: z.number().min(0).max(1),
  /** 叠放次序，越大越靠上。默认等于 index。 */
  z: z.number().int(),
});
export type LayerView = z.infer<typeof LayerView>;

export const LayerSetView = z.object({
  setId: z.string(),
  generationId: z.string(),
  sourceVersionId: z.string(),
  /** 请求的层数；与 `layers.length` 不一定相等（上游可能超发或少给）。 */
  requestedLayerCount: z.number().int().positive(),
  intent: z.string().optional(),
  seed: z.number().int().optional(),
  provider: z.string().optional(),
  createdAt: z.string(),
  layers: z.array(LayerView),
});
export type LayerSetView = z.infer<typeof LayerSetView>;

/**
 * 一次 PATCH 最多带几条。
 *
 * **刻意不复用 `DECOMPOSE_LAYER_MAX`(=10)**:那是"一次请求要拆几层"的上界,
 * 而这里是"改一组已经存在的图层"。上游允许超发(`requestedLayerCount` 上的注释
 * 写明"上游可能超发或少给"),超发的层本仓库有意保留、不丢弃——于是一组真的可能
 * 有 11 层。而面板调一次层序是**整组重新发号**(`LayerPanel.move()` 提交全组),
 * 借用 10 这个数就会让超发的组永远调不了层序:一个由上游决定、用户无法自救的死锁。
 *
 * 这个数字只是"别让人一次糊几万条进来"的体量护栏,不承载语义。真正的正确性
 * 判据在路由里:每一条 versionId 都必须属于本组,不属于就 400。
 */
export const LAYER_SET_PATCH_MAX = 64;

/** 改显隐 / 不透明度 / 层序。服务端权威——刷新、换设备、分享都读同一份。 */
export const UpdateLayerSetInput = z.object({
  layers: z
    .array(
      z.object({
        versionId: z.string(),
        hidden: z.boolean().optional(),
        opacity: z.number().min(0).max(1).optional(),
        z: z.number().int().optional(),
      }),
    )
    .min(1)
    .max(LAYER_SET_PATCH_MAX),
});
export type UpdateLayerSetInput = z.infer<typeof UpdateLayerSetInput>;

export const ApiError = z.object({
  error: z.string(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiError>;
