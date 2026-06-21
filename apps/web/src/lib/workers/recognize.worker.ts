import { Worker, type Job } from "bullmq";
import { prisma, Prisma } from "@brandai/db";
import {
  RecognizeRequest,
  RecognizeResponse,
} from "@brandai/contracts";
import { connection, queuePrefix } from "@/lib/queue";
import { ai } from "@/lib/ai";
import { recordUsage } from "@/lib/usage";
import {
  markRunning,
  setProgress,
  markSucceeded,
  markFailed,
} from "@/lib/async-tasks";

/**
 * Payload enqueued by POST /api/workspaces/[wsId]/rules/recognize.
 * The BullMQ job id is what the client polls for status.
 */
export interface RecognizeJobData {
  workspaceId: string;
  /** K7 — `source` carries asset provenance for the AI service's SSRF policy. */
  assets: { id: string; url: string; source?: "UPLOAD" | "WEBSITE" }[];
  /** H-async — server-authoritative task row to mirror progress/status into. */
  taskId?: string;
}

export interface RecognizeJobResult {
  ruleIds: string[];
  colorSystem?: RecognizeResponse["colorSystem"];
}

/**
 * Consumes the `recognize` queue: calls the AI service (mock provider by
 * default, so this works with no API keys), validates the response with the
 * frozen contract, then persists each recognized rule as a DRAFT BrandRule
 * carrying its evidence ("每条都看证据").
 */
export async function runRecognizeJob(
  job: Job<RecognizeJobData>,
): Promise<RecognizeJobResult> {
  const data = job.data;
  const taskId = data.taskId;
  try {
  await job.updateProgress(10);
  await markRunning(taskId, 10);

  const request = RecognizeRequest.parse({ assets: data.assets });
  // §2.3 — log every AI call's wall-clock latency for the activity log.
  const _t0 = Date.now();
  let raw: unknown;
  try {
    raw = await ai.recognize(request);
  } catch (aiErr) {
    await recordUsage({
      workspaceId: data.workspaceId,
      kind: "RECOGNIZE",
      status: "FAILED",
      latencyMs: Date.now() - _t0,
    });
    throw aiErr;
  }
  // Re-validate AI output against the frozen contract before persisting.
  const result = RecognizeResponse.parse(raw);
  await recordUsage({
    workspaceId: data.workspaceId,
    kind: "RECOGNIZE",
    status: "SUCCEEDED",
    imageCount: data.assets.length,
    latencyMs: Date.now() - _t0,
  });
  await job.updateProgress(60);
  await setProgress(taskId, 60);

  const ruleIds: string[] = [];
  let colorSystemAttached = false;
  for (const rule of result.rules) {
    // Persist the Color System report payload onto the first `color` rule's
    // value so the report page can read it without a (frozen-out) Job model.
    const value: Record<string, unknown> = { ...(rule.value ?? {}) };
    if (rule.type === "color" && result.colorSystem && !colorSystemAttached) {
      value.colorSystem = result.colorSystem;
      colorSystemAttached = true;
    }
    const created = await prisma.brandRule.create({
      data: {
        workspaceId: data.workspaceId,
        type: rule.type,
        strength: rule.strength,
        status: "DRAFT",
        summary: rule.summary,
        value: value as Prisma.InputJsonValue,
        evidence: (rule.evidence ?? []) as unknown as Prisma.InputJsonValue,
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

export function createRecognizeWorker() {
  const worker = new Worker<RecognizeJobData, RecognizeJobResult>(
    "recognize",
    runRecognizeJob,
    { connection, prefix: queuePrefix, concurrency: 2 },
  );
  worker.on("failed", (job, err) => {
    console.error(`[recognize] job ${job?.id} failed:`, err);
  });
  worker.on("completed", (job) => {
    console.log(`[recognize] job ${job.id} completed`);
  });
  return worker;
}
