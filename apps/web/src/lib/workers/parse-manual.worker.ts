import { Worker, type Job } from "bullmq";
import { prisma, Prisma } from "@brandai/db";
import { ParseManualRequest, ParseManualResponse } from "@brandai/contracts";
import { connection, queuePrefix } from "@/lib/queue";
import { ai } from "@/lib/ai";
import { recordUsage } from "@/lib/usage";
import {
  markRunning,
  setProgress,
  markSucceeded,
  markFailed,
} from "@/lib/async-tasks";
import { uploadDataUrlImage } from "@/lib/s3";
import { decodeImageResolution } from "@/lib/assets";

/**
 * Payload enqueued by POST /api/workspaces/[wsId]/rules/parse-manual.
 * The BullMQ job id is what the client polls for status.
 */
export interface ParseManualJobData {
  workspaceId: string;
  /** the VI_DOC asset whose PDF text is parsed; stamped onto rule evidence */
  assetId: string;
  url: string;
  /** H-async — server-authoritative task row to mirror progress/status into. */
  taskId?: string;
}

export interface ParseManualJobResult {
  ruleIds: string[];
  assetIds: string[];
  colorSystem?: ParseManualResponse["colorSystem"];
  warnings: string[];
}

const ASSET_CATEGORY_BY_RULE = {
  logo: "LOGO",
  imagery: "KV",
  font: "OTHER",
  color: "OTHER",
  layout: "OTHER",
  copy: "OTHER",
  graphic: "OTHER",
} as const;

function decodeDataUrl(dataUrl: string): {
  bytes: Buffer;
  mimeType: string;
} {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error("invalid extracted manual image");
  return {
    mimeType: match[1] || "image/jpeg",
    bytes: Buffer.from(match[2] ?? "", "base64"),
  };
}

/**
 * Consumes the `parse-manual` queue: hands the VI-manual PDF URL to the AI
 * service, validates the deep ParseManualResponse contract, persists the
 * selected page crops as BRAND_KIT Assets, then creates one editable DRAFT rule
 * per detected module. Evidence resolves to a crop when available and otherwise
 * falls back to the original VI_DOC, so every rule remains auditable.
 */
export async function runParseManualJob(
  job: Job<ParseManualJobData>,
): Promise<ParseManualJobResult> {
  const data = job.data;
  const taskId = data.taskId;
  try {
    await job.updateProgress(10);
    await markRunning(taskId, 10);

    const request = ParseManualRequest.parse({ url: data.url });
    // §2.3 — log every AI call's wall-clock latency for the activity log.
    const _t0 = Date.now();
    let raw: unknown;
    try {
      raw = await ai.parseManual(request);
    } catch (aiErr) {
      await recordUsage({
        workspaceId: data.workspaceId,
        kind: "PARSE_MANUAL",
        status: "FAILED",
        latencyMs: Date.now() - _t0,
      });
      throw aiErr;
    }
    // Re-validate AI output against the frozen contract before persisting.
    const result = ParseManualResponse.parse(raw);
    await recordUsage({
      workspaceId: data.workspaceId,
      kind: "PARSE_MANUAL",
      status: "SUCCEEDED",
      latencyMs: Date.now() - _t0,
    });
    await job.updateProgress(50);
    await setProgress(taskId, 50);

    // Persist model-selected PDF crops as real workspace-scoped brand-kit
    // Assets. Rules cite these image ids, so the review UI shows the actual logo,
    // font specimen, color card or photography evidence instead of a dead PDF
    // thumbnail. BRAND_KIT keeps them out of the ordinary material library.
    const extractedAssetIds: string[] = [];
    const assetIdByRef = new Map<string, string>();
    const refsByType = new Map<string, string[]>();
    for (const extracted of result.extractedAssets) {
      const { bytes, mimeType } = decodeDataUrl(extracted.dataUrl);
      const url = await uploadDataUrlImage(
        extracted.dataUrl,
        `${data.workspaceId}/brand-kit`,
      );
      const safeRef = extracted.ref.replace(/[^a-zA-Z0-9._-]+/g, "-");
      const resolution = decodeImageResolution(bytes);
      const created = await prisma.asset.create({
        data: {
          workspaceId: data.workspaceId,
          category: ASSET_CATEGORY_BY_RULE[extracted.type],
          libraryKind: "BRAND_KIT",
          fileName: `${extracted.label || safeRef}.jpg`,
          storageKey: `brand-kit/${taskId ?? job.id}/${safeRef}.jpg`,
          url,
          mimeType,
          sizeBytes: bytes.length,
          source: "UPLOAD",
          availableForGeneration: true,
          aiDescription: `从品牌手册第 ${extracted.page} 页自动提取：${extracted.label}`,
          ...(resolution ? { resolution } : {}),
        },
      });
      extractedAssetIds.push(created.id);
      assetIdByRef.set(extracted.ref, created.id);
      const refs = refsByType.get(extracted.type) ?? [];
      refs.push(extracted.ref);
      refsByType.set(extracted.type, refs);
    }

    await job.updateProgress(72);
    await setProgress(taskId, 72);

    const ruleIds: string[] = [];
    let colorSystemAttached = false;
    for (const rule of result.rules) {
      // Persist the Color System report payload onto the first `color` rule's
      // value so the report page can read it (parity with recognize.worker).
      const value: Record<string, unknown> = { ...(rule.value ?? {}) };
      if (rule.type === "color" && result.colorSystem && !colorSystemAttached) {
        value.colorSystem = result.colorSystem;
        colorSystemAttached = true;
      }
      const sourceEvidence =
        rule.evidence.length > 0
          ? rule.evidence
          : [{ note: "来自 VI 手册解析" }];
      // Prefer the crop explicitly cited by the VLM. If a visual module has a
      // crop but the model omitted sourceRef, attach the first crop of that type.
      const fallbackRef = refsByType.get(rule.type)?.[0];
      const evidence = sourceEvidence.map((ev, index) => {
        const sourceRef =
          ev.sourceRef ?? (index === 0 ? fallbackRef : undefined);
        const extractedAssetId = sourceRef
          ? assetIdByRef.get(sourceRef)
          : undefined;
        const { sourceRef: _sourceRef, ...persistable } = ev;
        return {
          ...persistable,
          assetId: extractedAssetId ?? data.assetId,
          note:
            ev.note ??
            (ev.page ? `品牌手册第 ${ev.page} 页` : "来自 VI 手册解析"),
        };
      });
      const created = await prisma.brandRule.create({
        data: {
          workspaceId: data.workspaceId,
          type: rule.type,
          strength: rule.strength,
          status: "DRAFT",
          summary: rule.summary,
          value: value as Prisma.InputJsonValue,
          evidence: evidence as unknown as Prisma.InputJsonValue,
        },
      });
      ruleIds.push(created.id);
    }

    await job.updateProgress(100);
    await markSucceeded(taskId, {
      refCount: ruleIds.length,
      ...(ruleIds[0] ? { refId: ruleIds[0] } : {}),
    });
    return {
      ruleIds,
      assetIds: extractedAssetIds,
      colorSystem: result.colorSystem,
      warnings: result.warnings,
    };
  } catch (err) {
    await markFailed(taskId, String(err));
    throw err;
  }
}

export function createParseManualWorker() {
  const worker = new Worker<ParseManualJobData, ParseManualJobResult>(
    "parse-manual",
    runParseManualJob,
    { connection, prefix: queuePrefix, concurrency: 2 },
  );
  worker.on("failed", (job, err) => {
    console.error(`[parse-manual] job ${job?.id} failed:`, err);
  });
  worker.on("completed", (job) => {
    console.log(`[parse-manual] job ${job.id} completed`);
  });
  return worker;
}
