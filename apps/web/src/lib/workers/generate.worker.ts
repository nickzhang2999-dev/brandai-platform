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
import { connection } from "@/lib/queue";
import { ai } from "@/lib/ai";
import { uploadDataUrlImage } from "@/lib/s3";
import { getConfirmedRules } from "@/lib/rules";
import { runPrecheck, type PrecheckResult } from "@/lib/precheck";
import {
  loadAssetUrlMap,
  loadProhibitionReferenceImages,
  serializeProhibition,
} from "@/lib/prohibitions";
import { loadTermLib } from "@/lib/compliance";
import { setVersionComplianceReport } from "@/lib/generations";
import {
  compileAIConstraints,
  constraintsEnabled,
} from "@/lib/ai-constraints";
import { recordUsage, fromGenerateUsage } from "@/lib/usage";

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
    watchdog = setTimeout(() => reject(new GenerationTimeoutError()), TIMEOUT_MS);
  });

  try {
    const result = await Promise.race([
      runGenerationInner(),
      timeout,
    ]);
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
    const brandRules = await getConfirmedRules(workspaceId);
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
      const compiled = compileAIConstraints(brandRules, prohibitions, assetUrls);
      aiConstraints = compiled.aiConstraints;
      blockers = compiled.blockers;
      if (blockers.length > 0) {
        throw new HardBlockError(blockers);
      }
    }

    const appliedRuleIds = brandRules.map((r) => r.id);
    const sceneType = generation.sceneType;
    const constraintEcho = constraintsEnabled()
      ? {
          // P1.2 — echo the compiled constraints so L3 can assert what
          // actually shaped the image. Provider-side may also write these
          // keys; explicit echo here guarantees presence even when the
          // upstream silently ignores fields.
          appliedNegativePrompt: aiConstraints.negativePrompt,
          appliedPromptAdditions: aiConstraints.promptAdditions,
          machineRulesApplied: aiConstraints.machineRules ?? {},
          // D5 — record which positive/negative example assets shaped the image.
          appliedReferenceImages: aiConstraints.referenceImages,
        }
      : {};

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

    const baseFields = {
      sceneType: generation.sceneType,
      sellingPoint: generation.sellingPoint,
      scene: generation.scene,
      brandRules,
      // M3 — forward the chosen text mode (defaults to "direct" when a job was
      // enqueued before this field existed, preserving legacy behavior).
      textMode: job.data.textMode ?? "direct",
      ...(constraintsEnabled() ? { aiConstraints } : {}),
    };

    async function persist(
      v: GenerateResponse["versions"][number],
      index: number,
    ): Promise<string> {
      // gpt-image-1 returns a giant base64 data: URL (~2 MB). Upload it to
      // object storage and persist the resulting public URL instead of bloating
      // Postgres. Non-data URLs (e.g. mock provider hosted URLs) pass through.
      const imageUrl = await uploadDataUrlImage(
        v.imageUrl,
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
            sceneType,
            ...constraintEcho,
          } as Prisma.InputJsonValue,
          // complianceReport / parentVersionId / isFinal left null/default
          // for M5 / M4 / M6 to fill in.
        },
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
          failures.push(`[${t.key} ${t.label} ${t.width}×${t.height}] ${String(sizeErr)}`);
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
        throw new Error(
          "All target sizes failed: " + failures.join("; "),
        );
      }
      // §2.4 — skip the terminal write if the watchdog already FAILED this
      // run (orphan after timeout): don't resurrect a timed-out generation.
      if (!(await writeTerminal({
        status: "SUCCEEDED",
        error: failures.length > 0 ? failures.join("; ") : null,
      }))) {
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
    { connection, concurrency: 2 },
  );
  worker.on("failed", (job, err) => {
    console.error(`[generate] job ${job?.id} failed:`, err);
  });
  worker.on("completed", (job) => {
    console.log(`[generate] job ${job.id} completed`);
  });
  return worker;
}
