import { z } from "zod";
import { BrandKitRecognizeInput } from "@brandai/contracts";
import { brandKitImportTask, readBrandKitImportTask } from "@/lib/brand-kit-import";
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
const StartRecognizeInput = BrandKitRecognizeInput;

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
      select: { id: true, url: true, source: true },
    });
    if (assets.length !== new Set(input.assetIds).size) {
      throw new ApiException(400, "No matching assets in this workspace");
    }

    // H-async — server-authoritative task row so the recognize view is
    // refresh-resumable (`?task=`) with a real progress %.
    const task = input.mutationId
      ? await brandKitImportTask(wsId, user.id, "RECOGNIZE", input.mutationId, input)
      : await createTask({ workspaceId: wsId, kind: "RECOGNIZE" });
    if ("status" in task && task.status !== "PENDING") return ok({ taskId: task.id, jobId: "jobId" in task ? task.jobId : undefined, status: task.status }, { status: 202 });
    const jobData: RecognizeJobData = {
      workspaceId: wsId,
      // K7 — thread each asset's provenance so the AI service applies the
      // strict initial-host SSRF check to WEBSITE-harvested library assets
      // (DNS-rebinding guard); UPLOAD/storage keeps the trusting default.
      assets: assets.map((a) => ({ id: a.id, url: a.url, source: a.source })),
      taskId: task.id,
      ...(input.targetType ? { targetType: input.targetType } : {}),
    };
    const job = await recognizeQueue.add("recognize", jobData, {
      ...(input.mutationId ? { jobId: task.id } : {}),
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

    const mutationId = new URL(req.url).searchParams.get("mutationId");
    if (mutationId) return ok(await readBrandKitImportTask(wsId, user.id, "RECOGNIZE", z.string().uuid().parse(mutationId)));
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
