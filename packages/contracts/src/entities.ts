import { z } from "zod";
import {
  AssetCategory,
  ComplianceLevel,
  ComplianceTermType,
  ReviewStatus,
  RuleStatus,
  RuleStrength,
  RuleType,
  SceneType,
} from "./enums";

export const Evidence = z.object({
  assetId: z.string(),
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
  createdAt: z.string(),
});
export type Asset = z.infer<typeof Asset>;

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
});
export type Generation = z.infer<typeof Generation>;

export const Project = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  campaign: z.string().optional(),
  product: z.string().optional(),
  channel: z.string().optional(),
  createdAt: z.string(),
});
export type Project = z.infer<typeof Project>;

export const BrandWorkspace = z.object({
  id: z.string(),
  ownerId: z.string(),
  name: z.string(),
  industry: z.string().optional(),
  websiteUrl: z.string().optional(),
  createdAt: z.string(),
});
export type BrandWorkspace = z.infer<typeof BrandWorkspace>;
