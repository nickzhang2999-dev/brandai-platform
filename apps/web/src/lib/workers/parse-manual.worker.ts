import { Worker, type Job } from "bullmq";
import { prisma, Prisma } from "@brandai/db";
import {
  ParseManualRequest,
  RecognizeResponse,
} from "@brandai/contracts";
import { connection } from "@/lib/queue";
import { ai } from "@/lib/ai";
import { recordUsage } from "@/lib/usage";
import {
  markRunning,
  setProgress,
  markSucceeded,
  markFailed,
} from "@/lib/async-tasks";

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
  colorSystem?: RecognizeResponse["colorSystem"];
}

/**
 * Consumes the `parse-manual` queue: hands the VI-manual PDF URL to the AI
 * service (mock provider by default, so this works with no API keys), validates
 * the response with the frozen RecognizeResponse contract — exactly the
 * recognition machinery — then persists each parsed rule as a DRAFT BrandRule.
 * Manual evidence carries no image bbox, so we stamp the VI_DOC assetId onto
 * each rule's evidence ("每条都看证据") so the confirm workbench can link back.
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
  const result = RecognizeResponse.parse(raw);
  await recordUsage({
    workspaceId: data.workspaceId,
    kind: "PARSE_MANUAL",
    status: "SUCCEEDED",
    latencyMs: Date.now() - _t0,
  });
  await job.updateProgress(60);
  await setProgress(taskId, 60);

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
    // Backfill the VI_DOC asset id onto every evidence item (the AI service
    // returns note-only evidence for a manual; assetId is required by Evidence).
    const evidence = (
      rule.evidence.length > 0 ? rule.evidence : [{ note: "来自 VI 手册解析" }]
    ).map((ev) => ({ ...ev, assetId: data.assetId }));
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
  return { ruleIds, colorSystem: result.colorSystem };
  } catch (err) {
    await markFailed(taskId, String(err));
    throw err;
  }
}

export function createParseManualWorker() {
  const worker = new Worker<ParseManualJobData, ParseManualJobResult>(
    "parse-manual",
    runParseManualJob,
    { connection, concurrency: 2 },
  );
  worker.on("failed", (job, err) => {
    console.error(`[parse-manual] job ${job?.id} failed:`, err);
  });
  worker.on("completed", (job) => {
    console.log(`[parse-manual] job ${job.id} completed`);
  });
  return worker;
}
