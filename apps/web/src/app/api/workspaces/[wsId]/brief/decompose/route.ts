import { z } from "zod";
import { prisma } from "@brandai/db";
import { handleError, ok, parse, requireUser, ApiException } from "@/lib/api";
import { requireOwnedWorkspace, requireWorkspaceRole } from "@/lib/workspace";
import { summarizeQueue } from "@/lib/queue";
import { createTask } from "@/lib/async-tasks";
import type { SummarizeJobData } from "@/lib/workers/summarize.worker";

/**
 * B2 · 首页 AI 拆解 — start an async brief decomposition (§2: never await the
 * VLM in the handler). Body: { text }. The worker calls AI /v1/summarize
 * (mode=brief_decompose), 立项 a draft Campaign seeded with the AI summary, and
 * returns the creation seeds. The client polls the task, then reads the seeds
 * via this route's GET ?jobId= and navigates to the workspace prefilled.
 */
const StartInput = z.object({
  text: z.string().min(1).max(4000),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    await requireWorkspaceRole(wsId, user.id, "EDITOR");

    const input = parse(StartInput, await req.json());

    const ws = await prisma.brandWorkspace.findUnique({
      where: { id: wsId },
      select: { name: true },
    });

    const task = await createTask({ workspaceId: wsId, kind: "SUMMARIZE" });
    const jobData: SummarizeJobData = {
      workspaceId: wsId,
      mode: "brief_decompose",
      text: input.text,
      ...(ws?.name ? { context: { brandName: ws.name } } : {}),
      taskId: task.id,
    };
    const job = await summarizeQueue.add("summarize", jobData, {
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

    const job = await summarizeQueue.getJob(jobId);
    if (!job || (job.data as SummarizeJobData)?.workspaceId !== wsId) {
      throw new ApiException(404, "Job not found");
    }

    const state = await job.getState();
    const status = JOB_STATE_MAP[state] ?? "PENDING";
    const rv = (job.returnvalue ?? {}) as Record<string, unknown>;
    return ok({
      jobId: job.id,
      status,
      progress: typeof job.progress === "number" ? job.progress : 0,
      result: status === "SUCCEEDED" ? rv : undefined,
      failedReason: status === "FAILED" ? job.failedReason : undefined,
    });
  } catch (err) {
    return handleError(err);
  }
}
