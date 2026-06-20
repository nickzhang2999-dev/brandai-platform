import { prisma } from "@brandai/db";
import { handleError, ok, requireUser, ApiException } from "@/lib/api";
import { requireOwnedWorkspace, requireWorkspaceRole } from "@/lib/workspace";
import { describeQueue } from "@/lib/queue";
import { createTask } from "@/lib/async-tasks";
import type { DescribeJobData } from "@/lib/workers/describe.worker";

/**
 * E9/E10 — start an async asset auto-tagging job (§2: never await the VLM in the
 * handler). Body: none. The handler does auth → fast DB check → persist an
 * AsyncTask (kind=DESCRIBE) → enqueue → 202. The worker calls AI `/v1/describe`
 * and writes Asset.aiTags / Asset.aiDescription; the client polls the task via
 * GET /api/workspaces/[wsId]/tasks/[taskId] (or this route's GET ?jobId=).
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ wsId: string; assetId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId, assetId } = await params;
    await requireWorkspaceRole(wsId, user.id, "EDITOR");

    const asset = await prisma.asset.findFirst({
      where: { id: assetId, workspaceId: wsId },
      select: { id: true, url: true, category: true, mimeType: true, source: true },
    });
    if (!asset) throw new ApiException(404, "Asset not found");
    // Only image assets can be visually described.
    if (!asset.mimeType.startsWith("image/")) {
      throw new ApiException(400, "Only image assets can be auto-tagged");
    }

    const task = await createTask({ workspaceId: wsId, kind: "DESCRIBE" });
    const jobData: DescribeJobData = {
      workspaceId: wsId,
      assetId: asset.id,
      url: asset.url,
      category: asset.category,
      source: asset.source,
      taskId: task.id,
    };
    const job = await describeQueue.add("describe", jobData, {
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

    const job = await describeQueue.getJob(jobId);
    if (!job || (job.data as DescribeJobData)?.workspaceId !== wsId) {
      throw new ApiException(404, "Job not found");
    }

    const state = await job.getState();
    const status = JOB_STATE_MAP[state] ?? "PENDING";
    return ok({
      jobId: job.id,
      status,
      progress: typeof job.progress === "number" ? job.progress : 0,
      tagCount:
        typeof job.returnvalue?.tagCount === "number"
          ? job.returnvalue.tagCount
          : 0,
      failedReason: status === "FAILED" ? job.failedReason : undefined,
    });
  } catch (err) {
    return handleError(err);
  }
}
