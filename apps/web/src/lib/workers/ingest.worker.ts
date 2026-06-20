import { Worker, type Job } from "bullmq";
import { IngestWebsiteResponse } from "@brandai/contracts";
import { connection, queuePrefix } from "@/lib/queue";
import { ai } from "@/lib/ai";
import { markRunning, markSucceeded, markFailed } from "@/lib/async-tasks";

/**
 * K3 / §2 — payload enqueued by POST /api/workspaces/[wsId]/ingest. Crawling a
 * site + the AI extraction is slow, so it must NOT be awaited in the HTTP
 * handler. The handler returns 202 with `{ jobId, taskId }`; the client polls
 * GET /ingest?jobId=... for status + the candidate result (the job return
 * value). The SSRF check on `url` is already done in the route before enqueue.
 */
export interface IngestJobData {
  workspaceId: string;
  url: string;
  /** H-async — server-authoritative task row to mirror progress/status into. */
  taskId?: string;
}

export type IngestJobResult = IngestWebsiteResponse;

/**
 * Consumes the `ingest` queue: calls the AI service `/v1/ingest/website` (mock
 * by default → works with no keys), validates against the frozen contract, and
 * returns the candidate images/copies/sellingPoints as the job return value so
 * the GET poll can hand them to the selectable grid.
 */
export async function runIngestJob(
  job: Job<IngestJobData>,
): Promise<IngestJobResult> {
  const data = job.data;
  const taskId = data.taskId;
  try {
    await job.updateProgress(10);
    await markRunning(taskId, 10);

    const raw = await ai.ingestWebsite({ url: data.url });
    const result = IngestWebsiteResponse.parse(raw);

    await job.updateProgress(100);
    await markSucceeded(taskId, { refCount: result.images.length });
    return result;
  } catch (err) {
    await markFailed(taskId, String(err));
    throw err;
  }
}

export function createIngestWorker() {
  const worker = new Worker<IngestJobData, IngestJobResult>(
    "ingest",
    runIngestJob,
    { connection, prefix: queuePrefix, concurrency: 2 },
  );
  worker.on("failed", (job, err) => {
    console.error(`[ingest] job ${job?.id} failed:`, err);
  });
  worker.on("completed", (job) => {
    console.log(`[ingest] job ${job.id} completed`);
  });
  return worker;
}
