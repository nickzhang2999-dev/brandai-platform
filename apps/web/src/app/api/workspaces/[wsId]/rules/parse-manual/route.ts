import { z } from "zod";
import { BrandKitParseManualInput } from "@brandai/contracts";
import { brandKitImportTask, readBrandKitImportTask } from "@/lib/brand-kit-import";
import { prisma } from "@brandai/db";
import { handleError, ok, parse, requireUser, ApiException } from "@/lib/api";
import { requireOwnedWorkspace, requireWorkspaceRole } from "@/lib/workspace";
import { parseManualQueue } from "@/lib/queue";
import { createTask } from "@/lib/async-tasks";
import type { ParseManualJobData } from "@/lib/workers/parse-manual.worker";

/**
 * Start an async VI-manual parsing job.
 *
 * Body: { assetId: string } — a VI_DOC asset (uploaded brand/VI manual PDF).
 * Enqueues a BullMQ `parse-manual` job; the returned `jobId` is polled via
 * GET /api/workspaces/[wsId]/rules/parse-manual?jobId=... for status. The
 * worker (lib/workers/parse-manual.worker.ts) extracts the PDF text via the
 * AI service and writes DRAFT BrandRule rows — the same recognition machinery
 * and confirm/edit/reject workbench as image-based recognition.
 */
const StartParseManualInput = BrandKitParseManualInput;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    await requireWorkspaceRole(wsId, user.id, "EDITOR");

    const input = parse(StartParseManualInput, await req.json());
    const asset = await prisma.asset.findFirst({
      where: {
        id: input.assetId,
        workspaceId: wsId,
        category: "VI_DOC",
        deprecatedAt: null, availableForGeneration: true,
      },
      select: { id: true, url: true },
    });
    if (!asset) {
      throw new ApiException(400, "No matching VI manual in this workspace");
    }

    const task = input.mutationId
      ? await brandKitImportTask(wsId, user.id, "PARSE_MANUAL", input.mutationId, input)
      : await createTask({ workspaceId: wsId, kind: "PARSE_MANUAL" });
    if ("status" in task && task.status !== "PENDING") return ok({ taskId: task.id, jobId: "jobId" in task ? task.jobId : undefined, status: task.status }, { status: 202 });
    const jobData: ParseManualJobData = {
      workspaceId: wsId,
      assetId: asset.id,
      url: asset.url,
      taskId: task.id,
      ...(input.targetType ? { targetType: input.targetType } : {}),
    };
    const job = await parseManualQueue.add("parse-manual", jobData, {
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
    if (mutationId) return ok(await readBrandKitImportTask(wsId, user.id, "PARSE_MANUAL", z.string().uuid().parse(mutationId)));
    const jobId = new URL(req.url).searchParams.get("jobId");
    if (!jobId) throw new ApiException(400, "jobId is required");

    const job = await parseManualQueue.getJob(jobId);
    if (!job || (job.data as ParseManualJobData)?.workspaceId !== wsId) {
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
