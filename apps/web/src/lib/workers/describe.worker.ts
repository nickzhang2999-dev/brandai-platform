import { Worker, type Job } from "bullmq";
import { prisma } from "@brandai/db";
import { DescribeRequest, DescribeResponse } from "@brandai/contracts";
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
 * Payload enqueued by POST /api/workspaces/[wsId]/assets/[assetId]/describe.
 * The BullMQ job id is what the client polls for status; the AsyncTask row
 * (kind=DESCRIBE) makes it refresh-resumable.
 */
export interface DescribeJobData {
  workspaceId: string;
  assetId: string;
  url: string;
  category?: string;
  /** K7 — asset provenance threaded to the AI service for SSRF policy. */
  source?: "UPLOAD" | "WEBSITE";
  /** Optional brand tone/voice hint to steer tagging. */
  brandTone?: string;
  /** H-async — server-authoritative task row to mirror progress/status into. */
  taskId?: string;
}

export interface DescribeJobResult {
  assetId: string;
  tagCount: number;
}

/**
 * Consumes the `describe` queue: calls the AI service `/v1/describe` (mock by
 * default → works with no keys), validates against the frozen contract, then
 * writes the real `Asset.aiTags` / `Asset.aiDescription` back to the row.
 */
export async function runDescribeJob(
  job: Job<DescribeJobData>,
): Promise<DescribeJobResult> {
  const data = job.data;
  const taskId = data.taskId;
  try {
    await job.updateProgress(10);
    await markRunning(taskId, 10);

    const request = DescribeRequest.parse({
      url: data.url,
      ...(data.category ? { category: data.category } : {}),
      ...(data.brandTone ? { brandTone: data.brandTone } : {}),
      ...(data.source ? { source: data.source } : {}),
    });

    const _t0 = Date.now();
    let raw: unknown;
    try {
      raw = await ai.describe(request);
    } catch (aiErr) {
      await recordUsage({
        workspaceId: data.workspaceId,
        kind: "DESCRIBE",
        status: "FAILED",
        latencyMs: Date.now() - _t0,
      });
      throw aiErr;
    }
    const result = DescribeResponse.parse(raw);
    await recordUsage({
      workspaceId: data.workspaceId,
      kind: "DESCRIBE",
      status: "SUCCEEDED",
      imageCount: 1,
      latencyMs: Date.now() - _t0,
    });
    await job.updateProgress(70);
    await setProgress(taskId, 70);

    // Re-scope the write to the workspace so a stale/foreign job can't touch
    // another tenant's asset (multi-tenant isolation §1).
    await prisma.asset.updateMany({
      where: { id: data.assetId, workspaceId: data.workspaceId },
      data: {
        aiTags: result.aiTags,
        aiDescription: result.aiDescription || null,
      },
    });

    await job.updateProgress(100);
    await markSucceeded(taskId, {
      refId: data.assetId,
      refCount: result.aiTags.length,
    });
    return { assetId: data.assetId, tagCount: result.aiTags.length };
  } catch (err) {
    await markFailed(taskId, String(err));
    throw err;
  }
}

export function createDescribeWorker() {
  const worker = new Worker<DescribeJobData, DescribeJobResult>(
    "describe",
    runDescribeJob,
    { connection, prefix: queuePrefix, concurrency: 2 },
  );
  worker.on("failed", (job, err) => {
    console.error(`[describe] job ${job?.id} failed:`, err);
  });
  worker.on("completed", (job) => {
    console.log(`[describe] job ${job.id} completed`);
  });
  return worker;
}
