import { z } from "zod";
import {
  AssetCategory,
  AssetLibraryKind,
  CampaignStatus,
  ComplianceLevel,
  ComplianceTermType,
  ReviewStatus,
  RuleStatus,
  RuleStrength,
  RuleType,
  SceneType,
} from "./enums";

export const Evidence = z.object({
  /**
   * The asset this evidence points at. Optional for *note-only* evidence: a VLM
   * observation that isn't tied to a specific requested asset (e.g. a global
   * remark, or a PDF-knowledge note). Omitted (not null) when absent — keep the
   * no-null wire contract. A model-supplied assetId outside the requested set is
   * stripped upstream, so any assetId present here belongs to the request.
   */
  assetId: z.string().optional(),
  /** normalized bounding box [x,y,w,h] in 0..1, optional for global evidence */
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  note: z.string().optional(),
  thumbnailUrl: z.string().optional(),
});
export type Evidence = z.infer<typeof Evidence>;

export const Asset = z.object({
  id: z.string(),
  workspaceId: z.string(),
  category: AssetCategory,
  fileName: z.string(),
  url: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  source: z.enum(["UPLOAD", "WEBSITE"]).default("UPLOAD"),
  // V0.0.9 · 图片三分法。可选以兼容旧序列化器；新读端会收到明确值。
  libraryKind: AssetLibraryKind.optional(),
  createdAt: z.string(),
  // BrandAI 素材库智能字段（frozen-additive：全部 optional——省略而非 null，
  // 旧读端/旧序列化器零改动）。tags = 人工业务标签；aiTags = 识别 worker 自动打标；
  // aiDescription = AI 生成描述；isFavorite = 收藏；resolution = 展示串。
  tags: z.array(z.string()).optional(),
  aiTags: z.array(z.string()).optional(),
  aiDescription: z.string().optional(),
  isFavorite: z.boolean().optional(),
  resolution: z.string().optional(),
  // P1.3 · 素材生命周期字段，暴露到 wire 后客户端可在参考选择器/识别选择器里
  // 灰显并禁用「不可用于出图」的素材（frozen-additive：optional，省略而非 null）。
  // `availableForGeneration` = 是否参与 M3 出图/参考；`deprecatedAt` = 弃用时间
  // (ISO 串，省略表示在用)；`replacementAssetId` = 继任素材指针。
  availableForGeneration: z.boolean().optional(),
  deprecatedAt: z.string().optional(),
  replacementAssetId: z.string().optional(),
  // E3 · 素材文件夹归属（frozen-additive：optional，未归档则省略而非 null）。
  folderId: z.string().optional(),
  // F18 · 出图回流素材库 — 该素材镜像自哪个出图版本（frozen-additive：optional，
  // 上传/采集素材省略而非 null）。客户端据此把来源展示为「AI 生成」而非「上传」。
  generationVersionId: z.string().optional(),
});
export type Asset = z.infer<typeof Asset>;

// V0.10 · 生成图库读模型。Asset 仍是图片镜像本体；这里加上所属项目和
// Generation 元信息，供生成图页面按项目维度检索、过滤和回跳工作台。
export const GeneratedAsset = Asset.extend({
  projectId: z.string().optional(),
  projectName: z.string().optional(),
  projectStatus: CampaignStatus.optional(),
  generationId: z.string().optional(),
  generationCreatedAt: z.string().optional(),
  sceneType: SceneType.optional(),
});
export type GeneratedAsset = z.infer<typeof GeneratedAsset>;

/** E3 · 素材文件夹（workspace 作用域素材分组）。 */
export const AssetFolder = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  createdAt: z.string(),
  /** 该文件夹下的素材数（serializer 计算，便于 UI 直接展示）。 */
  assetCount: z.number().int().nonnegative().optional(),
});
export type AssetFolder = z.infer<typeof AssetFolder>;

/** E3 · 新建文件夹入参。 */
export const CreateAssetFolderInput = z.object({
  name: z.string().min(1).max(60),
});
export type CreateAssetFolderInput = z.infer<typeof CreateAssetFolderInput>;

export const BrandRule = z.object({
  id: z.string(),
  workspaceId: z.string(),
  type: RuleType,
  strength: RuleStrength,
  status: RuleStatus,
  /** structured rule payload, shape depends on `type` */
  value: z.record(z.unknown()),
  summary: z.string(),
  evidence: z.array(Evidence).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BrandRule = z.infer<typeof BrandRule>;

export const ComplianceTerm = z.object({
  id: z.string(),
  workspaceId: z.string(),
  type: ComplianceTermType,
  term: z.string(),
  reason: z.string(),
  replacement: z.string().optional(),
  createdAt: z.string(),
});
export type ComplianceTerm = z.infer<typeof ComplianceTerm>;

export const ComplianceResult = z.object({
  level: ComplianceLevel,
  span: z.string().optional(),
  reason: z.string(),
  replacement: z.string().optional(),
  category: z
    .enum([
      "ABSOLUTE",
      "EFFICACY",
      "EXAGGERATION",
      "AUTHORITY",
      "BRAND_TERM",
      "BRAND_VISUAL",
      "PLATFORM",
    ])
    .optional(),
});
export type ComplianceResult = z.infer<typeof ComplianceResult>;

export const ComplianceReport = z.object({
  overall: ComplianceLevel,
  textResults: z.array(ComplianceResult).default([]),
  visualResults: z.array(ComplianceResult).default([]),
  checkedAt: z.string(),
  // 0–100 brand-consistency of the inspected image vs the brand rules
  // (100 = fully on-brand). Optional: text-only checks and pre-score reports
  // omit it (no-null contract — AI emits it only when an image was scored).
  score: z.number().min(0).max(100).optional(),
});
export type ComplianceReport = z.infer<typeof ComplianceReport>;

export const GenerationVersion = z.object({
  id: z.string(),
  generationId: z.string(),
  index: z.number().int(),
  imageUrl: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  params: z.record(z.unknown()),
  complianceReport: ComplianceReport.optional(),
  parentVersionId: z.string().optional(),
  isFinal: z.boolean().default(false),
  // G6 — approval workflow. Frozen-additive: defaults to PENDING; review fields
  // are `.optional()` (omitted, not null) per the contract boundary.
  reviewStatus: ReviewStatus.default("PENDING"),
  reviewedById: z.string().optional(),
  reviewedAt: z.string().optional(),
  reviewNote: z.string().optional(),
  createdAt: z.string(),
});
export type GenerationVersion = z.infer<typeof GenerationVersion>;

export const Generation = z.object({
  id: z.string(),
  projectId: z.string(),
  workspaceId: z.string(),
  sceneType: SceneType,
  sellingPoint: z.string(),
  scene: z.string(),
  status: z.enum(["PENDING", "RUNNING", "SUCCEEDED", "FAILED"]),
  versions: z.array(GenerationVersion).default([]),
  /** Populated when status is FAILED — the upstream/worker failure reason. */
  error: z.string().nullable().optional(),
  createdAt: z.string(),
  /** Wall-clock timing set by the worker. `startedAt` = worker picked it up;
   *  `finishedAt` = terminal (SUCCEEDED/FAILED); `durationMs` = the difference,
   *  denormalized so the queue widget / activity log can render duration
   *  without client-side date math. All three are absent until the worker
   *  writes them (PENDING rows + pre-2026-05-29 rows). */
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  durationMs: z.number().int().optional(),
  /**
   * V0.0.13 — 对话面板（AI 设计师）投影。会话流不建独立消息表，直接从
   * Generation 历史推导（服务端权威、刷新可恢复）；本字段保存会话气泡需要
   * 的展示信息：用户原文 + 引用图（含解析后的缩略 URL）。
   * 铁律：displayText 只存用户敲的原文 —— 任何路径都不得把 URL/文件名/
   * 引用块拼进来（规避 prd_agent 文本冗余 bug）。
   */
  chatContext: z
    .object({
      displayText: z.string(),
      imageInputs: z
        .array(
          z.object({
            kind: z.enum(["VERSION", "ASSET"]),
            id: z.string(),
            url: z.string().optional(),
          }),
        )
        .default([]),
    })
    .optional(),
});
export type Generation = z.infer<typeof Generation>;

// Project 是 BrandAI **Campaign** 的物理底座（保留 openvisual 表名以零成本
// 复用迁移过来的路由/worker/lib）。下列 BrandAI 字段全部 frozen-additive。
export const Project = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  campaign: z.string().optional(),
  product: z.string().optional(),
  channel: z.string().optional(),
  createdAt: z.string(),
  // BrandAI Campaign 业务字段（frozen-additive：optional，旧读端零改动）
  status: CampaignStatus.optional(),
  progress: z.number().int().min(0).max(100).optional(),
  description: z.string().optional(),
  coverImage: z.string().optional(),
  tags: z.array(z.string()).optional(),
  channels: z.array(z.string()).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  aiSummary: z.string().optional(),
  // P02 归档 — 设置则表示「已归档」（区别于 status=COMPLETED 的「已完成」）。
  archivedAt: z.string().optional(),
});
export type Project = z.infer<typeof Project>;

// BrandWorkspace 是 BrandAI **Brand** 的物理底座。下列字段 frozen-additive。
export const BrandWorkspace = z.object({
  id: z.string(),
  ownerId: z.string(),
  name: z.string(),
  industry: z.string().optional(),
  websiteUrl: z.string().optional(),
  createdAt: z.string(),
  // BrandAI Brand 展示/调性属性（frozen-additive：optional，旧读端零改动）
  subtitle: z.string().optional(),
  description: z.string().optional(),
  coverImage: z.string().optional(),
  tags: z.array(z.string()).optional(),
  isVerified: z.boolean().optional(),
  positioning: z.string().optional(),
  targetAudience: z.string().optional(),
  slogan: z.string().optional(),
});
export type BrandWorkspace = z.infer<typeof BrandWorkspace>;
