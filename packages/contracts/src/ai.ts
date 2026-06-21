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

export const ParseManualResponse = RecognizeResponse;
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
});
export type SizeSpec = z.infer<typeof SizeSpec>;

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
});
export type DiagResponse = z.infer<typeof DiagResponse>;
