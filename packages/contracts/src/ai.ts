import { z } from "zod";
import { EditOp, RuleStrength, RuleType, SceneType } from "./enums";
import {
  BrandRule,
  ComplianceReport,
  ComplianceResult,
  Evidence,
} from "./entities";

/**
 * AI service (Python FastAPI) external contract.
 * The web BFF only ever talks to these shapes; provider details live behind
 * the ImageProvider / VLMProvider adapter inside apps/ai.
 */

// POST /v1/ingest/website
export const IngestWebsiteRequest = z.object({ url: z.string().url() });
export type IngestWebsiteRequest = z.infer<typeof IngestWebsiteRequest>;

export const IngestWebsiteResponse = z.object({
  images: z.array(
    z.object({
      sourceUrl: z.string(),
      previewUrl: z.string(),
      guessedCategory: z.string().optional(),
    }),
  ),
  copies: z.array(z.string()),
  sellingPoints: z.array(z.string()),
  // Deterministic brand-style signals read straight from the page HTML/CSS.
  siteStyle: z
    .object({
      palette: z.array(z.string()).default([]),
      fonts: z.array(z.string()).default([]),
      themeColor: z.string().optional(),
      logoUrl: z.string().optional(),
      siteName: z.string().optional(),
    })
    .optional(),
});
export type IngestWebsiteResponse = z.infer<typeof IngestWebsiteResponse>;

/**
 * K7 — an asset's provenance hint, threaded to the AI service so it can apply
 * the right SSRF policy when fetching the asset's URL server-side:
 *  - `UPLOAD` (default): the URL points at our own object storage (which may be
 *    a private/internal host) → the initial host is trusted, only redirect hops
 *    are validated (legacy behavior, unchanged).
 *  - `WEBSITE`: the URL was harvested from an arbitrary third-party site. Its
 *    host could DNS-rebind to private space between save-time validation and
 *    fetch-time → the INITIAL host must be re-validated too.
 * Frozen-additive: optional, defaults (when absent) to the trusting UPLOAD
 * policy so existing callers are unchanged.
 */
export const AssetSourceHint = z.enum(["UPLOAD", "WEBSITE"]);
export type AssetSourceHint = z.infer<typeof AssetSourceHint>;

// POST /v1/recognize
export const RecognizeRequest = z.object({
  assets: z
    .array(
      z.object({
        id: z.string(),
        url: z.string(),
        // K7 — per-asset SSRF policy hint (see AssetSourceHint).
        source: AssetSourceHint.optional(),
      }),
    )
    .min(1),
});
export type RecognizeRequest = z.infer<typeof RecognizeRequest>;

export const RecognizedRule = z.object({
  type: RuleType,
  strength: RuleStrength,
  summary: z.string(),
  value: z.record(z.unknown()),
  evidence: z.array(Evidence).default([]),
});
export type RecognizedRule = z.infer<typeof RecognizedRule>;

export const RecognizeResponse = z.object({
  rules: z.array(RecognizedRule),
  /** color-system report payload for the Color System screen */
  colorSystem: z
    .object({
      palette: z.array(z.string()),
      pairing: z.array(z.tuple([z.string(), z.string()])).default([]),
      restrictions: z.array(z.string()).default([]),
      contrastScore: z.number().min(0).max(100),
      consistencyScore: z.number().min(0).max(100),
    })
    .optional(),
});
export type RecognizeResponse = z.infer<typeof RecognizeResponse>;

// POST /v1/describe — E9/E10 asset auto-tagging. Hands one image (by URL) to
// the VLM and gets back concise tags + a one-paragraph description, persisted
// onto Asset.aiTags / Asset.aiDescription by the describe worker.
export const DescribeRequest = z.object({
  /** Image asset URL (inlined server-side by the AI service, like recognize). */
  url: z.string(),
  /** Optional asset category hint (e.g. "PRODUCT" / "LOGO") to steer tagging. */
  category: z.string().optional(),
  /** Optional brand tone/voice hint so tags/description stay on-brand. */
  brandTone: z.string().optional(),
  /**
   * K7 — provenance of `url` for SSRF policy (see AssetSourceHint). Asset
   * tagging always runs on stored assets, so this is UPLOAD in practice; kept
   * for symmetry / future WEBSITE-sourced assets. Optional → trusting default.
   */
  source: AssetSourceHint.optional(),
});
export type DescribeRequest = z.infer<typeof DescribeRequest>;

export const DescribeResponse = z.object({
  /** Concise descriptive tags (subjects, colors, style, usage). Possibly []. */
  aiTags: z.array(z.string()).default([]),
  /** A short natural-language description of the asset (Chinese). */
  aiDescription: z.string(),
});
export type DescribeResponse = z.infer<typeof DescribeResponse>;

// POST /v1/summarize — B2/C8 text-only VLM (chat) endpoint with two modes:
//  - "brief_decompose": turn a free-text brand brief into structured creation
//    seeds (selling point / scene / scene type / style keywords) + a one-line
//    summary, so the homepage AI input can 立项 + prefill the workspace.
//  - "campaign_summary": condense a Campaign's context (name + brief +
//    confirmed brand rules) into a short AI 项目摘要 + a few highlights.
// Real path runs through the same VLM provider/model resolution as recognize /
// describe (text-only chat, no image); mock.py gives a deterministic zero-key
// result for contract tests. Every output field is optional/no-null per the L1
// null-vs-optional convention (the AI service runs response_model_exclude_none).
export const SummarizeMode = z.enum(["brief_decompose", "campaign_summary"]);
export type SummarizeMode = z.infer<typeof SummarizeMode>;

export const SummarizeRequest = z.object({
  mode: SummarizeMode,
  /** The text to work on: the raw brief (decompose) or the campaign context (summary). */
  text: z.string(),
  /** Optional steering context (brand tone, confirmed rule summaries, name). */
  context: z
    .object({
      brandName: z.string().optional(),
      brandTone: z.string().optional(),
      campaignName: z.string().optional(),
      ruleSummaries: z.array(z.string()).default([]),
    })
    .optional(),
});
export type SummarizeRequest = z.infer<typeof SummarizeRequest>;

export const SummarizeResponse = z.object({
  // brief_decompose fields (all optional — the model may omit any).
  sellingPoint: z.string().optional(),
  scene: z.string().optional(),
  sceneType: SceneType.optional(),
  styleKeywords: z.array(z.string()).default([]),
  // shared / campaign_summary fields.
  summary: z.string().optional(),
  highlights: z.array(z.string()).default([]),
});
export type SummarizeResponse = z.infer<typeof SummarizeResponse>;

// POST /v1/parse-manual — parse a brand/VI manual PDF (by asset URL) into the
// same DRAFT rule shape as /v1/recognize, so the confirm workbench is reused.
export const ParseManualRequest = z.object({ url: z.string() });
export type ParseManualRequest = z.infer<typeof ParseManualRequest>;

export const ManualExtractedAsset = z.object({
  /** Stable within one parse response; rule evidence cites this as sourceRef. */
  ref: z.string(),
  type: RuleType,
  page: z.number().int().positive(),
  /** normalized [x,y,w,h] crop inside the rendered PDF page */
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  label: z.string(),
  dataUrl: z.string().startsWith("data:image/"),
});
export type ManualExtractedAsset = z.infer<typeof ManualExtractedAsset>;

export const ParseManualResponse = RecognizeResponse.extend({
  /** Cropped visual evidence extracted from rendered PDF pages. */
  extractedAssets: z.array(ManualExtractedAsset).default([]),
  pageCount: z.number().int().nonnegative().default(0),
  warnings: z.array(z.string()).default([]),
});
export type ParseManualResponse = z.infer<typeof ParseManualResponse>;

// P1.2 — AI constraint layer. Optional payload compiled from confirmed brand
// rules + active ProhibitionRule rows; lets the AI worker push real
// negative_prompt / machine_rule / hard-block semantics down to the provider.
// Frozen-additive: every field is optional so the P0 (mock) path is untouched.
// P2.0 — multi-size batch 1→N adaptation. A `SizeSpec` is a single named
// target output size (channel preset or custom W×H). Shared with M4
// `EditOp.RESIZE` (resize payload uses the same shape). Frozen-additive:
// only referenced from new optional `targets` fields, so no existing caller
// changes.
export const SizeSpec = z.object({
  key: z.string(),
  label: z.string(),
  width: z.number().int().positive().max(8192),
  height: z.number().int().positive().max(8192),
  /**
   * V0.0.20 — generation-size provenance. Optional so legacy channel targets
   * and edit RESIZE payloads remain wire-compatible.
   */
  ratioKey: z
    .enum([
      "1:1",
      "4:5",
      "3:4",
      "2:3",
      "9:16",
      "5:4",
      "4:3",
      "3:2",
      "16:10",
      "16:9",
      "2.35:1",
      "3:1",
      "custom",
    ])
    .optional(),
  resolutionTier: z.enum(["1K", "2K"]).optional(),
  requestedRatio: z.string().max(50).optional(),
});
export type SizeSpec = z.infer<typeof SizeSpec>;

export const GenerationResolutionTier = z.enum(["1K", "2K"]);
export type GenerationResolutionTier = z.infer<typeof GenerationResolutionTier>;

export const GenerationAspectRatioKey = z.enum([
  "1:1",
  "4:5",
  "3:4",
  "2:3",
  "9:16",
  "5:4",
  "4:3",
  "3:2",
  "16:10",
  "16:9",
  "2.35:1",
  "3:1",
  "custom",
]);
export type GenerationAspectRatioKey = z.infer<typeof GenerationAspectRatioKey>;

export const CustomAspectRatio = z.object({
  width: z.number().finite().positive().max(10_000),
  height: z.number().finite().positive().max(10_000),
});
export type CustomAspectRatio = z.infer<typeof CustomAspectRatio>;

/**
 * The UI submits intent, not raw provider pixels or quality. The API resolves
 * this selection through the shared, server-authoritative size matrix.
 */
export const GenerationSizeSelection = z
  .object({
    ratioKey: GenerationAspectRatioKey,
    resolutionTier: GenerationResolutionTier,
    customRatio: CustomAspectRatio.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.ratioKey === "custom" && !value.customRatio) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["customRatio"],
        message: "自定义比例需要填写宽和高",
      });
      return;
    }
    if (value.ratioKey !== "custom" && value.customRatio) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["customRatio"],
        message: "预设比例不能携带 customRatio",
      });
      return;
    }
    if (value.customRatio) {
      const ratio = value.customRatio.width / value.customRatio.height;
      if (ratio < 1 / 3 || ratio > 3) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["customRatio"],
          message: "自定义比例需在 1:3 到 3:1 之间",
        });
      }
    }
  });
export type GenerationSizeSelection = z.infer<typeof GenerationSizeSelection>;

/**
 * Channel size presets surfaced in the generation wizard's multi-size picker.
 * Keys are stable identifiers persisted into `GenerationVersion.params.targetKey`.
 */
export const CHANNEL_SIZES: SizeSpec[] = [
  { key: "xhs_cover", label: "小红书封面", width: 1080, height: 1440 },
  { key: "ecom_main", label: "电商主图", width: 1024, height: 1024 },
  { key: "detail", label: "详情页", width: 750, height: 1000 },
  { key: "moments", label: "朋友圈", width: 1080, height: 1080 },
  { key: "banner", label: "Banner", width: 1920, height: 1080 },
  { key: "campaign_kv", label: "活动 KV", width: 1920, height: 1080 },
];

/**
 * D5 — a positive/negative example asset (resolved to a fetchable URL) that
 * the AI service can use as a visual reference. `positive` = "follow this";
 * `negative` = "avoid resembling this". `source` traces the origin rule (e.g.
 * `prohibition:<id>`); `note` carries the rule's human description.
 */
export const ReferenceImage = z.object({
  url: z.string(),
  polarity: z.enum(["positive", "negative"]),
  source: z.string(),
  /**
   * V0.0.8 — explicit usage semantics for workspace-picked assets.
   * STRICT means the image must be provided to an image-input path; callers must
   * not silently degrade it into text-only prompt steering.
   */
  mode: z.enum(["STRICT", "INSPIRATION"]).optional(),
  note: z.string().optional(),
  /**
   * K7 — provenance of the reference image's URL so the AI service applies the
   * right SSRF policy when inlining it (see AssetSourceHint). Frozen-additive:
   * optional, absent → trusting UPLOAD policy (unchanged behavior).
   */
  sourceHint: AssetSourceHint.optional(),
});
export type ReferenceImage = z.infer<typeof ReferenceImage>;

export const AIConstraints = z.object({
  /**
   * Stable generic provider knobs translated from VI structured fields, e.g.
   * `{ aspect_ratio: "1:1", cfg: 7, seed: 42 }`. Best-effort: providers that
   * don't support a key drop it (and log).
   */
  machineRules: z.record(z.unknown()).optional(),
  /** Soft "must include" hints appended to the prompt (STRONG rule summaries). */
  promptAdditions: z.array(z.string()).default([]),
  /** Negative prompt list ordered by priority; provider joins with ", ". */
  negativePrompt: z.array(z.string()).default([]),
  /**
   * HIGH-severity prohibitions that ABORT the request before any provider
   * call. Worker raises 422 + writes Generation.error.
   */
  hardBlocks: z
    .array(z.object({ reason: z.string(), source: z.string() }))
    .default([]),
  /**
   * D5 — positive/negative example assets compiled from the workspace's
   * ProhibitionRule rows (their `positiveExampleAssetId` / `negativeExampleAssetId`
   * resolved to URLs). The AI service folds them into the prompt and forwards
   * them to providers that accept image references. Frozen-additive: defaults
   * to `[]` so the pre-D5 wire shape is unchanged.
   */
  referenceImages: z.array(ReferenceImage).default([]),
});
export type AIConstraints = z.infer<typeof AIConstraints>;

// POST /v1/generate
export const GenerateRequest = z.object({
  sceneType: SceneType,
  sellingPoint: z.string(),
  scene: z.string(),
  brandRules: z.array(BrandRule),
  versionCount: z.number().int().min(1).max(8).default(2),
  /**
   * P1.2 — optional compiled constraint payload. When set, the AI worker
   * echoes `appliedNegativePrompt` / `appliedPromptAdditions` /
   * `machineRulesApplied` into each version's `params` for L3 assertion.
   */
  aiConstraints: AIConstraints.optional(),
  /**
   * P2.0 — optional list of target output sizes. When present, the AI service
   * ignores `versionCount` and the sceneType default size, producing exactly
   * one image per target (at `target.width × target.height`) and stamping
   * `targetKey` / `targetLabel` into each version's `params`. When absent, the
   * legacy same-size `versionCount` path is used unchanged.
   */
  targets: z.array(SizeSpec).max(12).optional(),
  /**
   * M3 — text rendering strategy. AI models render text (especially Chinese)
   * unreliably, so the caller picks how text lands on the image:
   *  - `direct` (default): the model renders the full image including any text
   *    (legacy behavior, untouched).
   *  - `layered`: the model is steered to produce a CLEAN background with
   *    generous negative space and NO baked-in text; the web client then
   *    overlays crisp, real, editable text on top (see the text-layer editor).
   * Frozen-additive: existing callers default to `direct`.
   */
  textMode: z.enum(["direct", "layered"]).default("direct"),
  /**
   * V0.0.13 — admin-configured image system prompt
   * (`AppSetting.imageSystemPrompt`, threaded by the web worker). The AI
   * service prepends it verbatim to the assembled prompt. Frozen-additive:
   * absent → prompt unchanged.
   */
  systemPrompt: z.string().optional(),
  // V0.0.18 — generation prompt policy:
  //  - branded: legacy form/campaign path (scene + rules + additions)
  //  - direct: chat path with no active Brand Kit (user brief only)
  //  - branded_direct: chat path with an active Brand Kit. Mandatory compact
  //    brand boundaries are placed before the user brief without restoring the
  //    legacy scene/long-context dump that previously caused off-topic output.
  promptMode: z.enum(["branded", "direct", "branded_direct"]).optional(),
});
export type GenerateRequest = z.infer<typeof GenerateRequest>;

/**
 * T-conn-b — per-call usage/cost surfaced by the AI service so the web side can
 * persist a UsageLog and render the admin usage dashboard. Best-effort:
 * `costUsd`/`model` are absent for the mock provider or an unpriced vendor
 * (frozen-additive, optional → exclude_none keeps the no-null wire shape).
 */
export const GenerateUsage = z.object({
  provider: z.string(),
  model: z.string().optional(),
  size: z.string().optional(),
  imageCount: z.number().int().nonnegative(),
  costUsd: z.number().optional(),
  latencyMs: z.number().int().nonnegative().optional(),
  /** Provider-reported total tokens (gpt-image-* is token-priced). Absent
   *  for mock / non-OpenAI gateways. */
  totalTokens: z.number().int().nonnegative().optional(),
});
export type GenerateUsage = z.infer<typeof GenerateUsage>;

export const GenerateResponse = z.object({
  versions: z.array(
    z.object({
      imageUrl: z.string(),
      width: z.number().int(),
      height: z.number().int(),
      /**
       * K5 — the ACTUAL pixel dimensions of the returned image. OpenAI's
       * gpt-image-* snaps the requested canvas to its supported size set
       * (1024×1024 / 1024×1536 / 1536×1024), so the delivered image often does
       * NOT match the requested `width`/`height`. These are decoded from the
       * returned bytes (best-effort) so the worker can persist the truth into
       * `GenerationVersion.params.actualWidth/actualHeight`. Frozen-additive:
       * optional → absent when the decode failed / mock provider, in which case
       * the requested `width`/`height` remain the only recorded size.
       */
      actualWidth: z.number().int().positive().optional(),
      actualHeight: z.number().int().positive().optional(),
      params: z.record(z.unknown()),
    }),
  ),
  usage: GenerateUsage.optional(),
});
export type GenerateResponse = z.infer<typeof GenerateResponse>;

// POST /v1/edit
export const EditRequest = z.object({
  imageUrl: z.string(),
  op: EditOp,
  payload: z.record(z.unknown()).default({}),
});
export type EditRequest = z.infer<typeof EditRequest>;

export const EditResponse = z.object({
  imageUrl: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  params: z.record(z.unknown()).default({}),
});
export type EditResponse = z.infer<typeof EditResponse>;

// POST /v1/decompose — 图层分解（迁移自 prd_agent 视觉创作的 AI 分层能力）。
//
// 它不是「一个可选的模型」，是一个**动作能力**：必须先有一张图，不吃尺寸 /
// versionCount / sceneType，产物是一组 RGBA 图层而不是一张成品图。因此它永远
// 不出现在任何模型或尺寸选择器里，只能被「选中一张图之后的操作」点名调用。
//
// 命名刻意避开 “layered” 一词：本仓库的 `textMode: "layered"` 指的是「让模型
// 留白不烤字、前端叠真文字」，与把图拆成多张 RGBA 图层完全是两件事。
export const DECOMPOSE_LAYER_MIN = 1;
export const DECOMPOSE_LAYER_MAX = 10;

export const DecomposeRequest = z.object({
  imageUrl: z.string(),
  /** 要拆几层。上游是必填参数，不是「期望值」——给多少就必须凑够多少。 */
  layerCount: z
    .number()
    .int()
    .min(DECOMPOSE_LAYER_MIN)
    .max(DECOMPOSE_LAYER_MAX)
    .default(4),
  /**
   * 用户用自然语言说的拆法（「logo 单独一层」「不要切开人物」）。
   * 原样附进提示词，不改写、不翻译——改写等于替用户做决定。
   */
  intent: z.string().max(500).optional(),
});
export type DecomposeRequest = z.infer<typeof DecomposeRequest>;

export const DecomposedLayer = z.object({
  imageUrl: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type DecomposedLayer = z.infer<typeof DecomposedLayer>;

export const DecomposeResponse = z.object({
  layers: z.array(DecomposedLayer),
  /**
   * 上游随机种子。实测 fal 会回它，而它是「同一张图重拆能不能复现」的唯一抓手，
   * 所以必须一路透传到图层组落库，不能像 prd_agent 那样在转换层丢掉。
   */
  seed: z.number().int().optional(),
  usage: GenerateUsage.optional(),
});
export type DecomposeResponse = z.infer<typeof DecomposeResponse>;

// POST /v1/compliance/check
export const ComplianceCheckRequest = z.object({
  text: z.string().optional(),
  imageUrl: z.string().optional(),
  brandRules: z.array(BrandRule).default([]),
  termLib: z.array(
    z.object({
      type: z.enum(["FORBIDDEN", "CAUTION"]),
      term: z.string(),
      reason: z.string(),
      replacement: z.string().optional(),
    }),
  ),
  /**
   * D5 — positive/negative example assets from the workspace's prohibition
   * rules. When an image is checked, the VLM compares it against these: a
   * generated image that resembles a `negative` example (or strays from a
   * `positive` one) is flagged. Frozen-additive: defaults to `[]`.
   */
  referenceImages: z.array(ReferenceImage).default([]),
});
export type ComplianceCheckRequest = z.infer<typeof ComplianceCheckRequest>;

export const ComplianceCheckResponse = z.object({
  results: z.array(ComplianceResult),
  report: ComplianceReport,
});
export type ComplianceCheckResponse = z.infer<typeof ComplianceCheckResponse>;

// POST /v1/diag — per-provider self-check (auth + reachability). Each item is a
// boolean ok plus an operator-readable detail (provider OK / "<status>: body" /
// exception). The storage check is web-only and shaped in the web route.
const DiagItem = z.object({ ok: z.boolean(), detail: z.string() });
export const DiagResponse = z.object({
  image: DiagItem,
  vlm: DiagItem,
  /**
   * 图层分解上游的自检结果。
   *
   * 后台能存分层密钥却测不了它，等于让管理员把「密钥对不对」推迟到某次真拆解
   * 失败时才知道——最小输入的连带义务是**当场能自测**（`minimal-user-input.md`）。
   */
  layer: DiagItem,
});
export type DiagResponse = z.infer<typeof DiagResponse>;
