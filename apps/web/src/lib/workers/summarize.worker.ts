import { Worker, type Job } from "bullmq";
import { prisma } from "@brandai/db";
import { SummarizeRequest, SummarizeResponse } from "@brandai/contracts";
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
 * B2/C8 — server-authoritative text summarization (§2: never await the slow VLM
 * chat in an HTTP handler). Two modes:
 *
 *  - brief_decompose: the homepage AI input submits a free-text brief; the
 *    worker decomposes it into creation seeds (sellingPoint / scene / sceneType
 *    / styleKeywords) + a one-line summary, CREATES a draft Campaign (Project)
 *    seeded with that summary, and returns the seeds so the client can navigate
 *    to the workspace prefilled.
 *  - campaign_summary: a campaign's context (name + brief + confirmed rule
 *    summaries) is condensed into an AI 项目摘要, persisted onto
 *    Project.aiSummary.
 *
 * The structured result rides back via the BullMQ job return value (the route's
 * GET ?jobId= reads it); the AsyncTask row carries status/progress so the client
 * poll is refresh-resumable and §2-observable.
 */
export interface SummarizeJobData {
  workspaceId: string;
  mode: "brief_decompose" | "campaign_summary";
  text: string;
  context?: {
    brandName?: string;
    brandTone?: string;
    campaignName?: string;
    ruleSummaries?: string[];
  };
  /** campaign_summary: the Project whose aiSummary we persist. */
  projectId?: string;
  /** H-async — server-authoritative task row to mirror progress/status into. */
  taskId?: string;
}

export interface SummarizeJobResult {
  mode: "brief_decompose" | "campaign_summary";
  /** brief_decompose: the draft Campaign created from the brief. */
  projectId?: string;
  sellingPoint?: string;
  scene?: string;
  sceneType?: string;
  styleKeywords: string[];
  summary?: string;
  highlights: string[];
}

export async function runSummarizeJob(
  job: Job<SummarizeJobData>,
): Promise<SummarizeJobResult> {
  const data = job.data;
  const taskId = data.taskId;
  try {
    await job.updateProgress(10);
    await markRunning(taskId, 10);

    const request = SummarizeRequest.parse({
      mode: data.mode,
      text: data.text,
      ...(data.context ? { context: data.context } : {}),
    });

    const _t0 = Date.now();
    let raw: unknown;
    try {
      raw = await ai.summarize(request);
    } catch (aiErr) {
      await recordUsage({
        workspaceId: data.workspaceId,
        kind: "SUMMARIZE",
        status: "FAILED",
        latencyMs: Date.now() - _t0,
      });
      throw aiErr;
    }
    const result = SummarizeResponse.parse(raw);
    await recordUsage({
      workspaceId: data.workspaceId,
      kind: "SUMMARIZE",
      status: "SUCCEEDED",
      latencyMs: Date.now() - _t0,
    });
    await job.updateProgress(70);
    await setProgress(taskId, 70);

    let projectId = data.projectId;

    if (data.mode === "campaign_summary") {
      // Persist onto the targeted Campaign — re-scope the write to the
      // workspace so a stale/foreign job can't touch another tenant's project.
      if (projectId && result.summary) {
        await prisma.project.updateMany({
          where: { id: projectId, workspaceId: data.workspaceId },
          data: { aiSummary: result.summary },
        });
      }
    } else {
      // brief_decompose — 立项 a draft Campaign seeded with the decomposed
      // summary (falls back to the brief's first line for a name). The raw
      // brief is saved on the description; the seeds ride back to the client.
      const firstLine = (data.text.split("\n")[0] ?? "").trim();
      const name =
        (result.sellingPoint?.trim() || firstLine || data.text.trim()).slice(
          0,
          24,
        ) || "新 Campaign";
      const project = await prisma.project.create({
        data: {
          workspaceId: data.workspaceId,
          name,
          description: data.text.trim().slice(0, 2000),
          status: "DRAFT",
          ...(result.summary ? { aiSummary: result.summary } : {}),
        },
        select: { id: true },
      });
      projectId = project.id;
    }

    await job.updateProgress(100);
    await markSucceeded(taskId, { refId: projectId });
    return {
      mode: data.mode,
      ...(projectId ? { projectId } : {}),
      ...(result.sellingPoint ? { sellingPoint: result.sellingPoint } : {}),
      ...(result.scene ? { scene: result.scene } : {}),
      ...(result.sceneType ? { sceneType: result.sceneType } : {}),
      styleKeywords: result.styleKeywords,
      ...(result.summary ? { summary: result.summary } : {}),
      highlights: result.highlights,
    };
  } catch (err) {
    await markFailed(taskId, String(err));
    throw err;
  }
}

export function createSummarizeWorker() {
  const worker = new Worker<SummarizeJobData, SummarizeJobResult>(
    "summarize",
    runSummarizeJob,
    { connection, prefix: queuePrefix, concurrency: 2 },
  );
  worker.on("failed", (job, err) => {
    console.error(`[summarize] job ${job?.id} failed:`, err);
  });
  worker.on("completed", (job) => {
    console.log(`[summarize] job ${job.id} completed`);
  });
  return worker;
}
