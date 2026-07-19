import { Worker, type Job } from "bullmq";
import { prisma, Prisma } from "@brandai/db";
import {
  ComplianceCheckRequest,
  ComplianceCheckResponse,
  ComplianceReport,
  GenerateRequest,
  GenerateResponse,
  type BrandRule,
  type SizeSpec,
} from "@brandai/contracts";
import { connection, queuePrefix } from "@/lib/queue";
import { ai } from "@/lib/ai";
import { uploadDataUrlImage } from "@/lib/s3";
import { mirrorGenerationVersionToAsset } from "@/lib/asset-mirror";
import {
  applyWatermarksToImage,
  type ResolvedWatermarkOverlay,
} from "@/lib/watermark";
import { getConfirmedRules } from "@/lib/rules";
import { runPrecheck, type PrecheckResult } from "@/lib/precheck";
import {
  loadAssetUrlMap,
  loadProhibitionReferenceImages,
  serializeProhibition,
} from "@/lib/prohibitions";
import { loadTermLib } from "@/lib/compliance";
import { setVersionComplianceReport } from "@/lib/generations";
import { compileAIConstraints, constraintsEnabled } from "@/lib/ai-constraints";
import { recordUsage, fromGenerateUsage } from "@/lib/usage";
import { getEffectiveAiSettings } from "@/lib/settings";
import { resolveChatBrandPolicy } from "@/lib/chat-brand-policy";

/**
 * K5 — zero-dependency pixel-size probe for a base64 `data:` URL, used as a
 * fallback when the AI service's own probe is unavailable (observed on the CDS
 * gray AI container). Reads the PNG IHDR (gpt-image-1 returns PNG) or the JPEG
 * SOF marker directly from the decoded bytes. Returns null on anything it can't
 * parse, so a miss never breaks generation — the requested w×h stays the truth.
 */
function decodeImageSize(
  dataUrl: string,
): { width: number; height: number } | null {
  const m = /^data:[^;,]*(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m || m[2] === undefined) return null;
  let buf: Buffer;
  try {
    buf = Buffer.from(m[2], m[1] ? "base64" : "utf8");
  } catch {
    return null;
  }
  // PNG: 8-byte signature, then IHDR with width/height as big-endian uint32.
  if (
    buf.length >= 24 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    if (width > 0 && height > 0) return { width, height };
  }
  // JPEG: scan for an SOF marker (0xFFC0–0xFFCF, excluding DHT/JPG/DAC).
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length && buf[off] === 0xff) {
      const marker = buf[off + 1];
      if (marker === undefined) break;
      const len = buf.readUInt16BE(off + 2);
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        const height = buf.readUInt16BE(off + 5);
        const width = buf.readUInt16BE(off + 7);
        if (width > 0 && height > 0) return { width, height };
        break;
      }
      off += 2 + len;
    }
  }
  return null;
}

/** Raised when HIGH-severity prohibitions abort generation before any AI
 *  call. The route handler converts this into a 422 (when synchronous) or
 *  Generation.error (when async — which is the worker's job here). */
export class HardBlockError extends Error {
  constructor(public blockers: Array<{ reason: string; source: string }>) {
    super(
      "AI constraint hard-block: " +
        blockers.map((b) => `[${b.source}] ${b.reason}`).join("; "),
    );
    this.name = "HardBlockError";
  }
}

/** §2.2 — raised when the in-worker AI compliance precheck flags the selling
 *  point as FORBIDDEN. Caught by the same FAILED path as HardBlockError; the
 *  message becomes Generation.error and renders in the result panel + activity
 *  log. (Previously this lived in POST as a sync 422 → 529 on slow AI.) */
export class PrecheckBlockError extends Error {
  constructor(public result: PrecheckResult) {
    const reasons = [
      ...result.results,
      ...result.report.textResults,
      ...result.report.visualResults,
    ]
      .filter((r) => r.level === "FORBIDDEN")
      .map((r) => r.reason)
      .slice(0, 3);
    super(
      "卖点文案存在违禁风险：" +
        (reasons.length > 0 ? reasons.join("；") : "未通过合规预检"),
    );
    this.name = "PrecheckBlockError";
  }
}

/** §2.4 — server-side watchdog. The worker races the generation against
 *  TIMEOUT_MS so a wedged AI call eventually marks the row FAILED instead of
 *  burning a job slot forever. Smaller than the client's 6-min cap so the
 *  DB row reaches FAILED *before* the wizard gives up — the user sees a real
 *  error, not "may have timed out". */
const TIMEOUT_MS = 5 * 60_000;
class GenerationTimeoutError extends Error {
  constructor() {
    super(`generation timed out after ${TIMEOUT_MS / 1000}s`);
    this.name = "GenerationTimeoutError";
  }
}

/**
 * Payload enqueued by POST /api/workspaces/[wsId]/generations (and the
 * "重新生成" re-enqueue). The BullMQ job id is what the client polls.
 *
 * The Generation row is created (status PENDING) before enqueuing; this
 * worker flips it RUNNING -> SUCCEEDED/FAILED and writes the version rows.
 */
export interface GenerateJobData {
  workspaceId: string;
  generationId: string;
  versionCount: number;
  /**
   * M3 — text rendering strategy threaded into the AI GenerateRequest.
   * "direct" (default) keeps the model rendering any text; "layered" steers it
   * to leave clean negative space and render NO text. Optional for backward
   * compat with any in-flight jobs enqueued before this field existed.
   */
  textMode?: "direct" | "layered";
  /**
   * P2.0 — when present (and MULTI_SIZE_V1 != "0"), produce one
   * GenerationVersion per target size instead of `versionCount` same-size
   * versions. Each target is generated independently so a single failing size
   * doesn't sink the whole batch.
   */
  targets?: SizeSpec[];
  /**
   * F7 — per-generation style keywords appended into the compiled
   * `AIConstraints.promptAdditions` (so the AI service folds them into the
   * prompt). Optional for backward compat with in-flight jobs.
   */
  styleKeywords?: string[];
  /**
   * F9 / L8 — per-generation reference asset ids. The worker resolves each to
   * its asset URL (within the workspace) and pushes a positive `referenceImage`
   * into the compiled `AIConstraints`. Optional for backward compat.
   */
  referenceAssetIds?: string[];
  /**
   * V0.0.7 — per-generation reference assets with explicit usage mode.
   * STRICT = 必须 100% 调用；INSPIRATION = 仿制借鉴。 `referenceAssetIds`
   * remains a legacy shorthand for INSPIRATION.
   */
  referenceAssets?: {
    assetId: string;
    mode: "STRICT" | "INSPIRATION";
  }[];
  /**
   * V0.0.9 — template library references. These steer the AI only.
   */
  templateReferenceAssetIds?: string[];
  /**
   * V0.0.9 — material library deterministic overlays. These are composited
   * after the base image returns from the AI provider.
   */
  watermarkOverlays?: {
    assetId?: string;
    text?: string;
    enabled: boolean;
    anchor: "top-left" | "top-right" | "bottom-left" | "bottom-right";
    positionMode: "pixel" | "ratio";
    offsetX: number;
    offsetY: number;
    widthPx: number;
    fontFamily: string;
    fontSizePx: number;
    opacity: number;
    textColor: string;
    backgroundEnabled: boolean;
    backgroundColor: string;
    borderEnabled: boolean;
    borderColor: string;
    borderWidth: number;
    cornerRadius: number;
  }[];
  /**
   * V0.0.13 — 对话面板图生图/多图生图输入（有序，≤8）。worker 在 workspace
   * 作用域内把每个引用解析成 URL，并按序折成 STRICT referenceImages
   * （note=IMAGE_INPUT:{序号}）。单图与多图共用 AI 服务同一条
   * /images/edits multipart 路径（规避 prd_agent 多图独立 Vision 分支 bug）。
   */
  imageInputs?: { kind: "VERSION" | "ASSET"; id: string }[];
}

/** P2.0 feature flag. Default on; set MULTI_SIZE_V1=0 to fall back to the
 *  P1.2 single-size versionCount path even when `targets` is present. */
export function multiSizeEnabled(): boolean {
  return (process.env.MULTI_SIZE_V1 ?? "1") !== "0";
}

export interface GenerateJobResult {
  generationId: string;
  versionIds: string[];
}

/** Auto-compliance feature flag. Default on; set AUTO_COMPLIANCE_V1=0 to skip
 *  the post-generation visual compliance pass (versions keep null reports,
 *  matching the legacy "manual 复检 only" behavior). */
export function autoComplianceEnabled(): boolean {
  return (process.env.AUTO_COMPLIANCE_V1 ?? "1") !== "0";
}

/**
 * Best-effort post-generation visual compliance. For each freshly created
 * version, runs the AI visual compliance check against the version's image
 * (plus the workspace's CONFIRMED brand rules + term library) and persists the
 * resulting `ComplianceReport` onto the version. So every output is
 * auto-verified instead of waiting for a manual "复检".
 *
 * Failure-safety: this NEVER throws. A per-version compliance failure (AI
 * service down, bad image, parse error) is logged and skipped — the version
 * simply keeps a null `complianceReport` and the generation still succeeds.
 */
async function runAutoCompliance(
  workspaceId: string,
  versionIds: string[],
  brandRules: BrandRule[],
): Promise<void> {
  if (!autoComplianceEnabled() || versionIds.length === 0) return;

  let termLib: Awaited<ReturnType<typeof loadTermLib>> = [];
  // D5 — the workspace's prohibition example assets, fed to the VLM so it can
  // flag a generated image that resembles a negative example. Best-effort: a
  // load failure just means no references (the check still runs on rules+terms).
  let referenceImages: Awaited<
    ReturnType<typeof loadProhibitionReferenceImages>
  > = [];
  try {
    [termLib, referenceImages] = await Promise.all([
      loadTermLib(workspaceId),
      loadProhibitionReferenceImages(workspaceId, "validation"),
    ]);
  } catch (err) {
    console.error(
      `[generate] auto-compliance: failed to load termLib for ${workspaceId}:`,
      err,
    );
    return;
  }

  for (const versionId of versionIds) {
    try {
      const version = await prisma.generationVersion.findUnique({
        where: { id: versionId },
        select: { imageUrl: true },
      });
      if (!version?.imageUrl) continue;

      const request = ComplianceCheckRequest.parse({
        imageUrl: version.imageUrl,
        brandRules,
        termLib,
        referenceImages,
      });
      const { report } = ComplianceCheckResponse.parse(
        await ai.complianceCheck(request),
      );
      await setVersionComplianceReport(
        versionId,
        ComplianceReport.parse(report),
      );
    } catch (err) {
      // Best-effort: a failed check must not sink the generation.
      console.error(
        `[generate] auto-compliance failed for version ${versionId}:`,
        err,
      );
    }
  }
}

/**
 * Consumes the `generate` queue: loads the workspace's CONFIRMED brand rule
 * library (M2 output), calls the AI service (mock provider by default so
 * this works with no API keys), validates the response against the frozen
 * contract, then persists one GenerationVersion per returned version with a
 * clean `index` and the applied rule ids recorded into `params` so M4/M6 can
 * trace which rules shaped the image.
 */
export async function runGenerateJob(
  job: Job<GenerateJobData>,
): Promise<GenerateJobResult> {
  const { workspaceId, generationId, versionCount } = job.data;
  const targets =
    multiSizeEnabled() && job.data.targets && job.data.targets.length > 0
      ? job.data.targets
      : undefined;
  await job.updateProgress(5);

  const generationRow = await prisma.generation.findUnique({
    where: { id: generationId },
  });
  if (!generationRow) {
    throw new Error(`Generation ${generationId} not found`);
  }
  // Alias to a definitely-non-null local so the nested runGenerationInner
  // (separate TS scope, narrowing doesn't carry across) doesn't need `!`s.
  const generation = generationRow;

  // §2 — wall-clock for the queue widget + activity log. Captured once so
  // every terminal write uses the same baseline.
  const startedAt = new Date();
  // §2.4 watchdog-race fence. Promise.race only decides which promise the
  // OUTER await sees — it does NOT cancel runGenerationInner(), which keeps
  // running after a timeout (no AbortController on the AI fetch). Without a
  // guard, a slow-but-eventual success would run its SUCCEEDED update and
  // overwrite the watchdog's FAILED (and could clobber a user-triggered
  // regenerate). `settled` makes the FIRST terminal writer win: whoever
  // (watchdog catch OR inner success) calls writeTerminal first wins, the
  // loser's call is a no-op. Local to this invocation, so a later regenerate
  // is a separate run with its own fence and can't be corrupted by this
  // run's orphan.
  let settled = false;
  const writeTerminal = async (
    extra: Record<string, unknown>,
  ): Promise<boolean> => {
    if (settled) return false;
    settled = true;
    await prisma.generation.update({
      where: { id: generationId },
      data: {
        ...extra,
        finishedAt: new Date(),
        durationMs: Date.now() - startedAt.getTime(),
      },
    });
    return true;
  };

  await prisma.generation.update({
    where: { id: generationId },
    data: { status: "RUNNING", error: null, startedAt },
  });

  // T-conn-b — owner id for per-user usage attribution (best-effort).
  const ownerId =
    (
      await prisma.brandWorkspace.findUnique({
        where: { id: workspaceId },
        select: { ownerId: true },
      })
    )?.ownerId ?? undefined;

  // §2.4 watchdog: race the whole pipeline against TIMEOUT_MS. On timeout
  // the rejection lands in the outer catch → FAILED with a clear reason.
  // The orphan AI fetch may keep running upstream (no AbortController on
  // ai.call), but the job slot frees and attempts:1 prevents replay.
  let watchdog: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    watchdog = setTimeout(
      () => reject(new GenerationTimeoutError()),
      TIMEOUT_MS,
    );
  });

  try {
    const result = await Promise.race([runGenerationInner(), timeout]);
    if (watchdog) clearTimeout(watchdog);
    return result;
  } catch (err) {
    if (watchdog) clearTimeout(watchdog);
    // writeTerminal no-ops if the inner already settled SUCCEEDED (can't
    // normally happen — a success clears the watchdog — but keeps the
    // invariant "first terminal write wins" airtight).
    await writeTerminal({ status: "FAILED", error: String(err) });
    throw err;
  }

  async function runGenerationInner(): Promise<GenerateJobResult> {
    // §V0.02 #6 — latest-first ONLY for the generation prompt: newly created /
    // just re-enabled rules take precedence in the constraint. Snapshots and the
    // hard-block gates keep the deterministic default order (docs/10 #4).
    const brandRules = await getConfirmedRules(workspaceId, {
      order: "recency",
      respectKitAvailability: true,
    });
    await job.updateProgress(20);

    // §2.2 — AI compliance precheck moved here from the POST handler (was
    // the 529 cause). Blocking findings become a readable Generation.error
    // via PrecheckBlockError; latency is logged so the activity view shows
    // how long each precheck actually took.
    const pcStart = Date.now();
    try {
      const pc = await runPrecheck({
        workspaceId,
        text: generation.sellingPoint,
      });
      await recordUsage({
        workspaceId,
        userId: ownerId,
        kind: "COMPLIANCE",
        status: pc.blocking ? "FAILED" : "SUCCEEDED",
        latencyMs: pc.latencyMs ?? Date.now() - pcStart,
      });
      if (pc.blocking) throw new PrecheckBlockError(pc);
    } catch (err) {
      if (err instanceof PrecheckBlockError) throw err;
      // Infra failure of the precheck itself shouldn't sink the job — log
      // and continue. The downstream generate will surface any real model
      // error; visual compliance still runs post-gen.
      console.warn("[generate] precheck call failed, continuing:", err);
    }
    await job.updateProgress(25);

    // P1.2 — aggregate ProhibitionRule + structured rule deltas into a
    // compiled `AIConstraints` payload. Feature-flagged so the legacy
    // summary-only P0 path remains reachable via AI_CONSTRAINTS_V1=0.
    let aiConstraints: ReturnType<
      typeof compileAIConstraints
    >["aiConstraints"] = {
      promptAdditions: [],
      negativePrompt: [],
      hardBlocks: [],
      referenceImages: [],
    };
    let blockers: Array<{ reason: string; source: string }> = [];
    let automaticBrandLogoAsset: {
      id: string;
      url: string;
      mimeType: string;
    } | null = null;
    if (constraintsEnabled()) {
      const prohRows = await prisma.prohibitionRule.findMany({
        where: {
          workspaceId,
          status: "ACTIVE",
          affectsGeneration: true,
        },
        orderBy: { createdAt: "asc" },
      });
      const prohibitions = prohRows.map(serializeProhibition);
      // D5 — resolve each prohibition's positive/negative example asset to a
      // fetchable URL so the compiler can emit `referenceImages` the AI service
      // folds into the prompt / forwards to the provider.
      const assetUrls = await loadAssetUrlMap(
        prohRows.flatMap((p) => [
          p.positiveExampleAssetId,
          p.negativeExampleAssetId,
        ]),
      );
      const compiled = compileAIConstraints(
        brandRules,
        prohibitions,
        assetUrls,
      );
      aiConstraints = compiled.aiConstraints;
      blockers = compiled.blockers;
      if (blockers.length > 0) {
        throw new HardBlockError(blockers);
      }

      // Brand-manual visual evidence is part of the active project-level kit,
      // not a one-off user pick. Feed the confirmed primary logo as the single
      // locked reference (exact pixels) and representative imagery as style
      // inspiration. This makes PDF-imported assets affect generation instead
      // of merely decorating the Brand Kit page.
      const evidenceRows = brandRules.flatMap((rule) =>
        (Array.isArray(rule.evidence) ? rule.evidence : [])
          .map((e) =>
            e && typeof e === "object" && "assetId" in e
              ? {
                  rule,
                  assetId: String((e as { assetId?: unknown }).assetId ?? ""),
                }
              : null,
          )
          .filter(
            (x): x is { rule: BrandRule; assetId: string } =>
              !!x?.assetId &&
              (x.rule.type === "logo" || x.rule.type === "imagery"),
          ),
      );
      const kitAssets = await prisma.asset.findMany({
        where: {
          id: { in: Array.from(new Set(evidenceRows.map((x) => x.assetId))) },
          workspaceId,
          libraryKind: "BRAND_KIT",
          availableForGeneration: true,
          deprecatedAt: null,
          mimeType: { startsWith: "image/" },
        },
        select: { id: true, url: true, mimeType: true, source: true },
      });
      const kitAssetMap = new Map(kitAssets.map((asset) => [asset.id, asset]));
      const primaryLogo = evidenceRows.find(
        (item) => item.rule.type === "logo" && kitAssetMap.has(item.assetId),
      );
      if (primaryLogo) {
        const asset = kitAssetMap.get(primaryLogo.assetId)!;
        automaticBrandLogoAsset = {
          id: asset.id,
          url: asset.url,
          mimeType: asset.mimeType,
        };
      }
      const imagery = evidenceRows
        .filter(
          (item) =>
            item.rule.type === "imagery" && kitAssetMap.has(item.assetId),
        )
        .slice(0, 4);
      const kitReferences = [
        ...(primaryLogo
          ? [
              {
                url: kitAssetMap.get(primaryLogo.assetId)!.url,
                polarity: "positive" as const,
                mode: "STRICT" as const,
                source: `brand_rule:${primaryLogo.rule.id}`,
                note: "BRAND_LOGO_LOCKED: authoritative project Brand Kit primary logo; reserve a safe area and never invent a substitute.",
                sourceHint: kitAssetMap.get(primaryLogo.assetId)!.source,
              },
            ]
          : []),
        ...imagery.map((item) => ({
          url: kitAssetMap.get(item.assetId)!.url,
          polarity: "positive" as const,
          mode: "INSPIRATION" as const,
          source: `brand_rule:${item.rule.id}`,
          note: `Project Brand Kit imagery reference: ${item.rule.summary}`,
          sourceHint: kitAssetMap.get(item.assetId)!.source,
        })),
      ];
      if (kitReferences.length > 0) {
        aiConstraints = {
          ...aiConstraints,
          referenceImages: [...aiConstraints.referenceImages, ...kitReferences],
        };
      }
    }

    // F7 / F9 / L8 — per-generation style keywords + reference assets. Merged
    // into the compiled AIConstraints regardless of the AI_CONSTRAINTS_V1 flag
    // so the user's explicit picks always reach the AI service:
    //  - styleKeywords → appended to promptAdditions (the AI service folds
    //    promptAdditions into the prompt; no AI-service contract change).
    //  - referenceAssetIds → each resolved to its asset URL (workspace-scoped)
    //    and pushed as a positive referenceImage. Ownership was IDOR-checked at
    //    the POST route; we re-scope the lookup to the workspace here too.
    // Track explicit user picks so we forward `aiConstraints` even when the
    // AI_CONSTRAINTS_V1 flag is off — the user's deliberate style/reference
    // choices must always reach the AI service.
    let hasExplicitPicks = false;
    const styleKeywords = (job.data.styleKeywords ?? [])
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (styleKeywords.length > 0) {
      aiConstraints = {
        ...aiConstraints,
        promptAdditions: [...aiConstraints.promptAdditions, ...styleKeywords],
      };
      hasExplicitPicks = true;
    }
    const legacyReferenceItems = Array.from(
      new Map(
        [
          ...(job.data.referenceAssetIds ?? []).map((assetId) => ({
            assetId,
            mode: "INSPIRATION" as const,
          })),
          ...(job.data.referenceAssets ?? []),
        ]
          .filter((x) => !!x.assetId)
          .map((x) => [x.assetId, x]),
      ).values(),
    );
    const templateReferenceAssetIds = Array.from(
      new Set([
        ...(job.data.templateReferenceAssetIds ?? []),
        ...legacyReferenceItems
          .filter((r) => r.mode !== "STRICT")
          .map((r) => r.assetId),
      ]),
    );
    const legacyWatermarkOverlays =
      legacyReferenceItems
        .filter((r) => r.mode === "STRICT")
        .map((r) => ({
          assetId: r.assetId,
          enabled: true,
          anchor: "bottom-right" as const,
          positionMode: "pixel" as const,
          offsetX: 24,
          offsetY: 24,
          widthPx: 120,
          fontFamily: "Inter",
          fontSizePx: 28,
          opacity: 0.85,
          textColor: "#111827",
          backgroundEnabled: false,
          backgroundColor: "#FFFFFF",
          borderEnabled: false,
          borderColor: "#7C5CFF",
          borderWidth: 1,
          cornerRadius: 0,
        })) ?? [];
    const watermarkOverlays = [
      ...(job.data.watermarkOverlays ?? []),
      ...legacyWatermarkOverlays,
    ];
    if (templateReferenceAssetIds.length > 0) {
      const refAssets = await prisma.asset.findMany({
        // Only feed generatable IMAGE assets as visual references — mirror the
        // recognize path's lifecycle guard (skip deprecated/disabled) and
        // exclude non-image assets (e.g. VI_DOC/PDF) that can't steer image gen.
        where: {
          id: { in: templateReferenceAssetIds },
          workspaceId,
          availableForGeneration: true,
          deprecatedAt: null,
          mimeType: { startsWith: "image/" },
          libraryKind: { in: ["TEMPLATE", "MATERIAL"] },
        },
        select: { id: true, url: true, source: true, fileName: true },
      });
      const refImages = templateReferenceAssetIds
        .map((id) => {
          const a = refAssets.find((r) => r.id === id);
          if (!a?.url) return null;
          return {
            url: a.url,
            polarity: "positive" as const,
            source: `asset:${id}`,
            mode: "INSPIRATION" as const,
            note: `TEMPLATE_REFERENCE: use as style, composition, color or proportion inspiration only. Asset: ${a.fileName}`,
            // K7 — thread the asset's provenance so the AI service applies the
            // strict initial-host SSRF check to WEBSITE-harvested references
            // (DNS-rebinding guard). UPLOAD/storage keeps the trusting default.
            // `Asset.source` ("UPLOAD"|"WEBSITE") matches AssetSourceHint.
            sourceHint: a.source,
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);
      if (refImages.length > 0) {
        aiConstraints = {
          ...aiConstraints,
          promptAdditions: [
            ...aiConstraints.promptAdditions,
            `Use ${refImages.length} selected template image(s) only as inspiration references: borrow style, composition, color or visual language, but do not copy them as final content.`,
          ],
          referenceImages: [...aiConstraints.referenceImages, ...refImages],
        };
        hasExplicitPicks = true;
      }
    }
    const watermarkAssetIds = Array.from(
      new Set(
        watermarkOverlays
          .map((overlay) => overlay.assetId)
          .filter((id): id is string => !!id),
      ),
    );
    const watermarkAssets =
      watermarkAssetIds.length > 0
        ? await prisma.asset.findMany({
            where: {
              id: { in: watermarkAssetIds },
              workspaceId,
              availableForGeneration: true,
              deprecatedAt: null,
              mimeType: { startsWith: "image/" },
              libraryKind: "MATERIAL",
            },
            select: { id: true, url: true, mimeType: true },
          })
        : [];
    const watermarkAssetMap = new Map(watermarkAssets.map((a) => [a.id, a]));
    const missingWatermarkIds = watermarkAssetIds.filter(
      (id) => !watermarkAssetMap.has(id),
    );
    if (missingWatermarkIds.length > 0) {
      throw new Error(
        `watermark asset unavailable: ${missingWatermarkIds.join(", ")}`,
      );
    }
    const resolvedWatermarkOverlays: ResolvedWatermarkOverlay[] =
      watermarkOverlays.map((overlay) => {
        const asset = overlay.assetId
          ? watermarkAssetMap.get(overlay.assetId)
          : null;
        return {
          ...overlay,
          ...(asset
            ? { assetUrl: asset.url, assetMimeType: asset.mimeType }
            : {}),
        };
      });
    // Project-level Brand Kit logo composition is automatic and intentionally
    // has no workspace UI control. The model receives the logo as identity
    // context, then the worker composites the exact source pixels so an
    // invented/redrawn mark can never become the final authority.
    const automaticBrandLogoOverlay: ResolvedWatermarkOverlay | null =
      automaticBrandLogoAsset
        ? {
            assetId: automaticBrandLogoAsset.id,
            assetUrl: automaticBrandLogoAsset.url,
            assetMimeType: automaticBrandLogoAsset.mimeType,
            enabled: true,
            anchor: "top-left",
            positionMode: "ratio",
            offsetX: 0.035,
            offsetY: 0.035,
            widthPx: 196,
            fontFamily: "Inter",
            fontSizePx: 28,
            opacity: 1,
            textColor: "#111827",
            backgroundEnabled: false,
            backgroundColor: "#FFFFFF",
            borderEnabled: false,
            borderColor: "#7C5CFF",
            borderWidth: 1,
            cornerRadius: 0,
          }
        : null;
    const resolvedOutputOverlays = [
      ...resolvedWatermarkOverlays,
      ...(automaticBrandLogoOverlay ? [automaticBrandLogoOverlay] : []),
    ];

    const appliedRuleIds = brandRules.map((r) => r.id);
    const sceneType = generation.sceneType;

    // Re-generate: capture prior root versions but DON'T delete them yet —
    // only swap them out once the replacement has actually been generated +
    // persisted AND this run is the authoritative winner (writeTerminal true).
    // Deleting up-front lost the previous (possibly final) versions whenever the
    // provider timed out / all sizes failed / upload threw.
    //
    // Partial retry ({targets:[oneSize]}) must ONLY replace the retried target's
    // root — deleting every root would turn a complete multi-size kit into a
    // single version. So scope the stale set by params.targetKey for a partial
    // retry, and drop all roots only for a full regenerate. New rows for a
    // partial retry start above the highest existing index (siblings kept, no
    // collision); a full regenerate stays clean 0-based (all roots removed).
    const allRoots = await prisma.generationVersion.findMany({
      where: { generationId, parentVersionId: null },
      select: { id: true, index: true, params: true },
    });
    const retryKeys =
      targets && targets.length > 0 ? new Set(targets.map((t) => t.key)) : null;
    const staleRootIds = (
      retryKeys
        ? allRoots.filter((r) => {
            const k = (r.params as { targetKey?: unknown } | null)?.targetKey;
            return typeof k === "string" && retryKeys.has(k);
          })
        : allRoots
    ).map((r) => r.id);
    const baseIndex = retryKeys
      ? allRoots.reduce((m, r) => Math.max(m, r.index), -1) + 1
      : 0;
    async function dropStaleRoots() {
      if (staleRootIds.length > 0) {
        await prisma.generationVersion.deleteMany({
          where: { id: { in: staleRootIds } },
        });
      }
    }

    // V0.0.13 — 对话面板图像输入：workspace 作用域内解析（defense-in-depth，
    // route 层已 IDOR 校验过一次），按用户给定顺序折成 STRICT referenceImages。
    const imageInputs = job.data.imageInputs ?? [];
    if (imageInputs.length > 0) {
      const versionIds = imageInputs
        .filter((r) => r.kind === "VERSION")
        .map((r) => r.id);
      const assetIds = imageInputs
        .filter((r) => r.kind === "ASSET")
        .map((r) => r.id);
      const [versionRows, assetRows] = await Promise.all([
        versionIds.length > 0
          ? prisma.generationVersion.findMany({
              where: {
                id: { in: versionIds },
                generation: { workspaceId },
              },
              select: { id: true, imageUrl: true },
            })
          : Promise.resolve([]),
        assetIds.length > 0
          ? prisma.asset.findMany({
              where: {
                id: { in: assetIds },
                workspaceId,
                deprecatedAt: null,
                mimeType: { startsWith: "image/" },
              },
              select: { id: true, url: true, source: true },
            })
          : Promise.resolve([]),
      ]);
      const versionMap = new Map(versionRows.map((v) => [v.id, v]));
      const assetMap = new Map(assetRows.map((a) => [a.id, a]));
      const inputRefs = imageInputs.map((r, i) => {
        const resolved =
          r.kind === "VERSION" ? versionMap.get(r.id) : assetMap.get(r.id);
        const url =
          resolved && "imageUrl" in resolved
            ? resolved.imageUrl
            : resolved?.url;
        if (!resolved || !url) {
          throw new Error(
            `对话引用的图片不可用（${r.kind === "VERSION" ? "出图版本" : "素材"} ${r.id} 不在本品牌空间或已失效）`,
          );
        }
        return {
          url,
          polarity: "positive" as const,
          source: `${r.kind === "VERSION" ? "version" : "asset"}:${r.id}`,
          mode: "STRICT" as const,
          // note 只承载机器可读的序号标记 —— 展示文本(chatContext.displayText)
          // 与模型层物理分离，绝不把文件名/URL 拼进用户可见消息。
          note: `IMAGE_INPUT:${i + 1}`,
          // K7 — WEBSITE 采集素材走严格 SSRF 初始 host 校验；出图版本存于
          // 自有存储，走 UPLOAD 信任策略。
          sourceHint:
            resolved && "source" in resolved && resolved.source === "WEBSITE"
              ? ("WEBSITE" as const)
              : ("UPLOAD" as const),
        };
      });
      aiConstraints = {
        ...aiConstraints,
        referenceImages: [...aiConstraints.referenceImages, ...inputRefs],
      };
      hasExplicitPicks = true;
    }

    // V0.0.13 — 管理员配置的图像系统提示词（AppSetting > env，空则不注入）。
    const { imageSystemPrompt } = await getEffectiveAiSettings();

    // V0.0.18 — chat uses one of two server-authoritative policies, without UI
    // switches: no active rules → free direct creation; active rules → compact
    // branded_direct. The latter MUST retain compiled additions and automatic
    // Brand Kit references. This replaces V0.0.13g's blanket clearing, which
    // made the "Brand Kit auto-applied" badge diverge from the real AI request.
    const chatOrigin = generation.chatContext != null;
    const chatBrandPolicy = resolveChatBrandPolicy({
      chatOrigin,
      brandRules,
      aiConstraints,
    });
    aiConstraints = chatBrandPolicy.aiConstraints;

    const baseFields = {
      sceneType: generation.sceneType,
      sellingPoint: generation.sellingPoint,
      scene: chatOrigin ? "" : generation.scene,
      brandRules: chatBrandPolicy.brandRules,
      ...(chatBrandPolicy.promptMode
        ? { promptMode: chatBrandPolicy.promptMode }
        : {}),
      // M3 — forward the chosen text mode (defaults to "direct" when a job was
      // enqueued before this field existed, preserving legacy behavior).
      textMode: job.data.textMode ?? "direct",
      ...(constraintsEnabled() || hasExplicitPicks ? { aiConstraints } : {}),
      ...(imageSystemPrompt ? { systemPrompt: imageSystemPrompt } : {}),
    };
    const constraintEcho = constraintsEnabled()
      ? {
          // Persist the FINAL policy-adjusted payload, not the pre-chat draft,
          // so version params prove exactly which constraints/references reached
          // the AI service for this output.
          appliedNegativePrompt: aiConstraints.negativePrompt,
          appliedPromptAdditions: aiConstraints.promptAdditions,
          machineRulesApplied: aiConstraints.machineRules ?? {},
          appliedReferenceImages: aiConstraints.referenceImages,
        }
      : {};

    async function persist(
      v: GenerateResponse["versions"][number],
      index: number,
    ): Promise<string> {
      // gpt-image-1 returns a giant base64 data: URL (~2 MB). Upload it to
      // object storage and persist the resulting public URL instead of bloating
      // Postgres. Non-data URLs (e.g. mock provider hosted URLs) pass through.
      // K5 — prefer the AI service's probed size; fall back to a local
      // header read of the original data: URL (the AI probe is unreliable on
      // the gray container, but the worker always has the raw bytes here).
      const watermarked =
        resolvedOutputOverlays.length > 0
          ? await applyWatermarksToImage(v.imageUrl, resolvedOutputOverlays)
          : { imageUrl: v.imageUrl, appliedAssetIds: [] };
      const finalImageUrl = watermarked.imageUrl;
      const localSize =
        v.actualWidth && v.actualHeight ? null : decodeImageSize(finalImageUrl);
      const actualSize =
        v.actualWidth && v.actualHeight
          ? { actualWidth: v.actualWidth, actualHeight: v.actualHeight }
          : localSize
            ? { actualWidth: localSize.width, actualHeight: localSize.height }
            : {};
      const imageUrl = await uploadDataUrlImage(
        finalImageUrl,
        `generations/${workspaceId}`,
      );
      const created = await prisma.generationVersion.create({
        data: {
          generationId,
          index,
          imageUrl,
          width: v.width,
          height: v.height,
          params: {
            ...v.params,
            appliedRuleIds,
            brandConstraintMode: brandRules.length > 0 ? "BRANDED" : "FREE",
            appliedBrandRuleCount: appliedRuleIds.length,
            ...(automaticBrandLogoAsset &&
            watermarked.appliedAssetIds.includes(automaticBrandLogoAsset.id)
              ? {
                  appliedBrandLogoAssetId: automaticBrandLogoAsset.id,
                  brandLogoComposition: "deterministic-source-overlay",
                }
              : {}),
            sceneType,
            // K5 — persist the ACTUAL returned pixel size (OpenAI snaps the
            // requested canvas). The AI service also echoes these into
            // `v.params`; stamping from the typed response fields here makes the
            // record robust even if a provider drops the param echo. Absent when
            // the size probe failed / mock provider (requested w×h stays truth).
            ...actualSize,
            ...constraintEcho,
            // K5 / M3 — stamp the chosen text mode onto each version so 重新生成
            // can reconstruct it from prior roots (mirrors styleKeywords below;
            // defaults to "direct" for jobs enqueued before this field existed).
            textMode: job.data.textMode ?? "direct",
            // F7 / F9 / L8 — stamp the per-generation picks onto each version so
            // they display and so 重新生成 can reconstruct them from prior roots.
            ...(styleKeywords.length > 0 ? { styleKeywords } : {}),
            ...(templateReferenceAssetIds.length > 0
              ? { templateReferenceAssetIds }
              : {}),
            // V0.0.13 — 对话面板图像输入留痕（重试/审计可重建）。
            ...(imageInputs.length > 0 ? { imageInputs } : {}),
            ...(watermarkOverlays.length > 0 ? { watermarkOverlays } : {}),
            ...(watermarked.appliedAssetIds.filter((id) =>
              watermarkAssetIds.includes(id),
            ).length > 0
              ? {
                  appliedWatermarkAssetIds: watermarked.appliedAssetIds.filter(
                    (id) => watermarkAssetIds.includes(id),
                  ),
                }
              : {}),
            imageKind: "GENERATED",
            ...(legacyReferenceItems.length > 0
              ? { referenceAssets: legacyReferenceItems }
              : {}),
          } as Prisma.InputJsonValue,
          // complianceReport / parentVersionId / isFinal left null/default
          // for M5 / M4 / M6 to fill in.
        },
      });
      // F18 · 出图回流素材库 — 把刚落库的出图版本镜像成一条真实 Asset，使生成图与
      // 上传素材并列出现在素材库（P04）。best-effort：失败只 warn，绝不让出图 FAILED。
      const mWidth =
        (actualSize as { actualWidth?: number }).actualWidth ?? v.width;
      const mHeight =
        (actualSize as { actualHeight?: number }).actualHeight ?? v.height;
      await mirrorGenerationVersionToAsset({
        workspaceId,
        generationVersionId: created.id,
        imageUrl,
        dataUrl: finalImageUrl,
        width: mWidth,
        height: mHeight,
        sceneType,
        fileLabel: `${(generation.scene || "AI 出图").slice(0, 40)} #${index + 1}`,
        aiDescription: generation.scene || undefined,
      });
      return created.id;
    }

    const versionIds: string[] = [];

    if (targets) {
      // P2.0 — multi-size fan-out. One AI call per target (versionCount=1 at
      // that size). Each target is isolated: a single size failing does NOT
      // sink the batch. Failed sizes accumulate into Generation.error; the
      // batch is SUCCEEDED as long as ≥1 size produced a version.
      const failures: string[] = [];
      // 部分重试时从现有最大 index 之后开始,避免与保留的兄弟尺寸版本撞 index;
      // 全新多尺寸生成 baseIndex=0(无旧 root)。
      let index = baseIndex;
      for (const t of targets) {
        // §2.4 — stop persisting further sizes once the watchdog has FAILED
        // this run; don't attach orphan versions to a timed-out generation.
        if (settled) {
          console.warn(
            `[generate] ${generationId} settled (timeout) mid-batch; stopping at size ${t.key}`,
          );
          break;
        }
        try {
          const request = GenerateRequest.parse({
            ...baseFields,
            versionCount: 1,
            targets: [t],
          });
          const result = GenerateResponse.parse(await ai.generate(request));
          if (settled) {
            console.warn(
              `[generate] ${generationId} settled (timeout) after size ${t.key} AI call; discarding`,
            );
            break;
          }
          for (const v of result.versions) {
            versionIds.push(await persist(v, index));
            index += 1;
          }
          await recordUsage({
            workspaceId,
            userId: ownerId,
            kind: "GENERATE",
            status: "SUCCEEDED",
            generationId,
            ...fromGenerateUsage(result.usage),
          });
        } catch (sizeErr) {
          failures.push(
            `[${t.key} ${t.label} ${t.width}×${t.height}] ${String(sizeErr)}`,
          );
          await recordUsage({
            workspaceId,
            userId: ownerId,
            kind: "GENERATE",
            status: "FAILED",
            size: `${t.width}x${t.height}`,
          });
        }
        await job.updateProgress(
          25 + Math.round((index / Math.max(targets.length, 1)) * 70),
        );
      }

      if (versionIds.length === 0) {
        // All sizes failed → FAILED (the catch below records the error too).
        throw new Error("All target sizes failed: " + failures.join("; "));
      }
      // §2.4 — skip the terminal write if the watchdog already FAILED this
      // run (orphan after timeout): don't resurrect a timed-out generation.
      if (
        !(await writeTerminal({
          status: "SUCCEEDED",
          error: failures.length > 0 ? failures.join("; ") : null,
        }))
      ) {
        console.warn(
          `[generate] ${generationId} already settled (timeout); discarding late multi-size success`,
        );
        return { generationId, versionIds };
      }
      // Replacement is persisted and this run won → now safe to remove old roots.
      await dropStaleRoots();
      // Best-effort auto visual compliance AFTER SUCCEEDED is written: it's
      // optional + can be slow (VLM calls); if the watchdog fires during it, the
      // FAILED write no-ops (settled), so a job with usable outputs stays
      // SUCCEEDED instead of being flipped to FAILED.
      await runAutoCompliance(workspaceId, versionIds, brandRules);
      await job.updateProgress(100);
      return { generationId, versionIds };
    }

    // Legacy P1.2 same-size versionCount path (unchanged).
    const request = GenerateRequest.parse({
      ...baseFields,
      versionCount,
    });
    let raw: unknown;
    try {
      raw = await ai.generate(request);
    } catch (genErr) {
      await recordUsage({
        workspaceId,
        userId: ownerId,
        kind: "GENERATE",
        status: "FAILED",
        size: generation.sceneType,
      });
      throw genErr;
    }
    // Re-validate AI output against the frozen contract before persisting.
    const result = GenerateResponse.parse(raw);
    await recordUsage({
      workspaceId,
      userId: ownerId,
      kind: "GENERATE",
      status: "SUCCEEDED",
      generationId,
      ...fromGenerateUsage(result.usage),
    });
    await job.updateProgress(70);

    // §2.4 — if the watchdog already FAILED this run while ai.generate() was
    // in flight, do NOT write version rows: stale versions would attach to a
    // now-FAILED generation and mix with a user retry. Bail before persisting.
    if (settled) {
      console.warn(
        `[generate] ${generationId} settled (timeout) before persist; discarding ${result.versions.length} late version(s)`,
      );
      return { generationId, versionIds };
    }

    let index = 0;
    for (const v of result.versions) {
      versionIds.push(await persist(v, index));
      index += 1;
    }

    // §2.4 — see multi-size path: don't overwrite a watchdog FAILED.
    if (!(await writeTerminal({ status: "SUCCEEDED", error: null }))) {
      console.warn(
        `[generate] ${generationId} already settled (timeout); discarding late success`,
      );
      return { generationId, versionIds };
    }
    // Replacement is persisted and this run won → now safe to remove old roots.
    await dropStaleRoots();
    // Best-effort auto visual compliance AFTER SUCCEEDED is written (see
    // multi-size path): optional + slow, must not let the watchdog flip a job
    // with usable outputs to FAILED.
    await runAutoCompliance(workspaceId, versionIds, brandRules);
    await job.updateProgress(100);
    return { generationId, versionIds };
  }
}

export function createGenerateWorker() {
  const worker = new Worker<GenerateJobData, GenerateJobResult>(
    "generate",
    runGenerateJob,
    { connection, prefix: queuePrefix, concurrency: 2 },
  );
  worker.on("failed", (job, err) => {
    console.error(`[generate] job ${job?.id} failed:`, err);
  });
  worker.on("completed", (job) => {
    console.log(`[generate] job ${job.id} completed`);
  });
  return worker;
}
