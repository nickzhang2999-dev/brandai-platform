import { z } from "zod";

export const AssetCategory = z.enum([
  "LOGO",
  "PRODUCT",
  "PACKAGING",
  "KV",
  "ECOM",
  "SOCIAL",
  "VI_DOC",
  "OTHER",
]);
export type AssetCategory = z.infer<typeof AssetCategory>;

// V0.0.9 — platform-level image taxonomy:
// MATERIAL = 素材库（会被确定性使用/水印叠加）
// TEMPLATE = 模板库参考图（只影响风格、色系、比例、构图）
// GENERATED = AI 工作台确认后的生成图镜像
export const AssetLibraryKind = z.enum([
  "MATERIAL",
  "TEMPLATE",
  "GENERATED",
  // Brand-kit source files and AI-extracted visual evidence live outside the
  // normal material/template pickers. They are still workspace-scoped Assets
  // so rules can cite and reuse them during generation.
  "BRAND_KIT",
]);
export type AssetLibraryKind = z.infer<typeof AssetLibraryKind>;

export const RuleType = z.enum([
  "color",
  "font",
  "layout",
  "imagery",
  "graphic",
  "copy",
  "logo",
]);
export type RuleType = z.infer<typeof RuleType>;

export const RuleStrength = z.enum(["STRONG", "WEAK", "FORBIDDEN"]);
export type RuleStrength = z.infer<typeof RuleStrength>;

export const RuleStatus = z.enum(["DRAFT", "CONFIRMED", "REJECTED"]);
export type RuleStatus = z.infer<typeof RuleStatus>;

export const ComplianceTermType = z.enum(["FORBIDDEN", "CAUTION"]);
export type ComplianceTermType = z.infer<typeof ComplianceTermType>;

export const ComplianceLevel = z.enum(["PASS", "RISK", "FORBIDDEN"]);
export type ComplianceLevel = z.infer<typeof ComplianceLevel>;

export const SceneType = z.enum([
  "ECOM_MAIN",
  "SCENE",
  "SOCIAL_POSTER",
  "CAMPAIGN_KV",
  "SELLING_POINT",
]);
export type SceneType = z.infer<typeof SceneType>;

export const JobStatus = z.enum(["PENDING", "RUNNING", "SUCCEEDED", "FAILED"]);
export type JobStatus = z.infer<typeof JobStatus>;

// BrandAI — Campaign 生命周期状态（草稿 / 进行中 / 已完成）。映射自旧
// `Project`，是 Campaign 卡片状态徽章 + 列表筛选的事实源。
export const CampaignStatus = z.enum(["DRAFT", "IN_PROGRESS", "COMPLETED"]);
export type CampaignStatus = z.infer<typeof CampaignStatus>;

// G6 — workspace member roles (rank: OWNER > EDITOR > REVIEWER > VIEWER).
export const WorkspaceRole = z.enum(["OWNER", "EDITOR", "REVIEWER", "VIEWER"]);
export type WorkspaceRole = z.infer<typeof WorkspaceRole>;

// G6 — generation version approval state.
export const ReviewStatus = z.enum([
  "PENDING",
  "SUBMITTED",
  "APPROVED",
  "REJECTED",
]);
export type ReviewStatus = z.infer<typeof ReviewStatus>;

export const EditOp = z.enum([
  "IMAGE_EDIT",
  "REPLACE_BACKGROUND",
  "MOVE_PRODUCT",
  "EDIT_TEXT",
  "RECOLOR",
  "ADD_ELEMENT",
  "REMOVE_ELEMENT",
  "OUTPAINT",
  "INPAINT",
  "RESIZE",
]);
export type EditOp = z.infer<typeof EditOp>;

// V0.0.12 — asset invocation semantics in the workspace. REFERENCE only steers
// style/composition; EXACT is deterministic composition with content unchanged;
// ADAPTIVE must appear but may be resized/recolored within the same silhouette.
export const AssetInvocationMode = z.enum(["REFERENCE", "EXACT", "ADAPTIVE"]);
export type AssetInvocationMode = z.infer<typeof AssetInvocationMode>;
