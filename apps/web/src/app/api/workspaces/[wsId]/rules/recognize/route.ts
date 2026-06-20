import { z } from "zod";
import { prisma } from "@brandai/db";
import { handleError, ok, parse, requireUser, ApiException } from "@/lib/api";
import { requireOwnedWorkspace, requireWorkspaceRole } from "@/lib/workspace";
import { recognizeQueue } from "@/lib/queue";
import { createTask } from "@/lib/async-tasks";
import type { RecognizeJobData } from "@/lib/workers/recognize.worker";

/**
 * Start an async brand-style recognition job.
 *
 * Body: { assetIds: string[] } — assets the user picked from the library.
 * Enqueues a BullMQ `recognize` job; the returned `jobId` is polled via
 * GET /api/workspaces/[wsId]/rules/recognize?jobId=... for status. The
 * worker (lib/workers/recognize.worker.ts) calls the AI service and writes
 * DRAFT BrandRule rows with evidence.
 */
const StartRecognizeInput = z.object({
  assetIds: z.array(z.string()).min(1),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    await requireWorkspaceRole(wsId, user.id, "EDITOR");

    const input = parse(StartRecognizeInput, await req.json());
    const assets = await prisma.asset.findMany({
      where: {
        workspaceId: wsId,
        id: { in: input.assetIds },
        // P1.3 — never feed deprecated / unavailable assets into recognition.
        availableForGeneration: true,
        deprecatedAt: null,
      },
      select: { id: true, url: true },
    });
    if (assets.length === 0) {
      throw new ApiException(400, "No matching assets in this workspace");
    }

    // H-async — server-authoritative task row so the recognize view is
    // refresh-resumable (`?task=`) with a real progress %.
    const task = await createTask({ workspaceId: wsId, kind: "RECOGNIZE" });
    const jobData: RecognizeJobData = {
      workspaceId: wsId,
      assets: assets.map((a) => ({ id: a.id, url: a.url })),
      taskId: task.id,
    };
    const job = await recognizeQueue.add("recognize", jobData, {
      removeOnComplete: 50,
      removeOnFail: 50,
    });
    await prisma.asyncTask.update({
      where: { id: task.id },
      data: { jobId: job.id },
    });

    return ok(
      { jobId: job.id, taskId: task.id, status: "PENDING" as const },
      { status: 202 },
    );
  } catch (err) {
    return handleError(err);
  }
}

const JOB_STATE_MAP: Record<
  string,
  "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED"
> = {
  waiting: "PENDING",
  delayed: "PENDING",
  "waiting-children": "PENDING",
  prioritized: "PENDING",
  active: "RUNNING",
  completed: "SUCCEEDED",
  failed: "FAILED",
};

export async function GET(
  req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    await requireOwnedWorkspace(wsId, user.id);

    const jobId = new URL(req.url).searchParams.get("jobId");
    if (!jobId) throw new ApiException(400, "jobId is required");

    const job = await recognizeQueue.getJob(jobId);
    if (!job || (job.data as RecognizeJobData)?.workspaceId !== wsId) {
      throw new ApiException(404, "Job not found");
    }

    const state = await job.getState();
    const status = JOB_STATE_MAP[state] ?? "PENDING";
    return ok({
      jobId: job.id,
      status,
      progress: typeof job.progress === "number" ? job.progress : 0,
      ruleCount: Array.isArray(job.returnvalue?.ruleIds)
        ? job.returnvalue.ruleIds.length
        : 0,
      failedReason: status === "FAILED" ? job.failedReason : undefined,
    });
  } catch (err) {
    return handleError(err);
  }
}
