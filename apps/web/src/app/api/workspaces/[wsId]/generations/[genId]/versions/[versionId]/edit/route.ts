import { prisma } from "@brandai/db";
import { EditVersionInput, WatermarkOverlayInput } from "@brandai/contracts";
import { ApiException, handleError, ok, parse, requireUser } from "@/lib/api";
import { requireOwnedWorkspace, requireWorkspaceRole } from "@/lib/workspace";
import { editQueue } from "@/lib/queue";
import { createTask } from "@/lib/async-tasks";
import { getVersionLineage } from "@/lib/generations";
import type { EditJobData } from "@/lib/workers/edit.worker";

/**
 * POST → 二次编辑: validate `EditVersionInput` (op + op-specific payload),
 *        enqueue a BullMQ `edit` job and return `{ jobId, lineage }`. The
 *        worker (lib/workers/edit.worker.ts) calls the AI `/v1/edit`,
 *        re-validates with the frozen `EditResponse`, and creates a NEW
 *        child GenerationVersion (parentVersionId = this version) — the
 *        source image is never overwritten.
 *
 * GET  → poll the edit job + return the (refreshed) version lineage so the
 *        client can render the new child once it lands. Same job-poll
 *        pattern as M3 (Queue.getJob(id).getState() — no Job model, schema
 *        frozen).
 */

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

async function loadOwnedVersion(
  wsId: string,
  genId: string,
  versionId: string,
  userId: string,
) {
  await requireOwnedWorkspace(wsId, userId);
  const generation = await prisma.generation.findUnique({
    where: { id: genId },
  });
  if (!generation || generation.workspaceId !== wsId) {
    throw new ApiException(404, "Generation not found");
  }
  const version = await prisma.generationVersion.findUnique({
    where: { id: versionId },
  });
  if (!version || version.generationId !== genId) {
    throw new ApiException(404, "Version not found in this generation");
  }
  return { generation, version };
}

export async function POST(
  req: Request,
  {
    params,
  }: {
    params: Promise<{
      wsId: string;
      genId: string;
      versionId: string;
    }>;
  },
) {
  try {
    const user = await requireUser();
    const { wsId, genId, versionId } = await params;
    await loadOwnedVersion(wsId, genId, versionId, user.id);
    // G6 — 二次编辑属于内容写操作:编辑+(EDITOR/OWNER)。
    await requireWorkspaceRole(wsId, user.id, "EDITOR");

    const input = parse(EditVersionInput, await req.json());
    const watermarkOverlays = (input.watermarkOverlays ?? []).map((overlay) =>
      WatermarkOverlayInput.parse(overlay),
    );

    const task = await createTask({ workspaceId: wsId, kind: "EDIT" });
    const jobData: EditJobData = {
      workspaceId: wsId,
      generationId: genId,
      sourceVersionId: versionId,
      op: input.op,
      payload: input.payload ?? {},
      watermarkOverlays,
      taskId: task.id,
    };
    const job = await editQueue.add("edit", jobData, {
      removeOnComplete: 50,
      removeOnFail: 50,
    });
    await prisma.asyncTask.update({
      where: { id: task.id },
      data: { jobId: job.id },
    });

    const lineage = await getVersionLineage(versionId);
    return ok({ jobId: job.id, taskId: task.id, lineage }, { status: 202 });
  } catch (err) {
    return handleError(err);
  }
}

export async function GET(
  req: Request,
  {
    params,
  }: {
    params: Promise<{
      wsId: string;
      genId: string;
      versionId: string;
    }>;
  },
) {
  try {
    const user = await requireUser();
    const { wsId, genId, versionId } = await params;
    await loadOwnedVersion(wsId, genId, versionId, user.id);

    const lineage = await getVersionLineage(versionId);
    const jobId = new URL(req.url).searchParams.get("jobId");

    let job:
      | {
          jobId: string;
          status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";
          progress: number;
          failedReason?: string;
        }
      | undefined;
    if (jobId) {
      const j = await editQueue.getJob(jobId);
      if (j && (j.data as EditJobData)?.sourceVersionId === versionId) {
        const state = await j.getState();
        const status = JOB_STATE_MAP[state] ?? "PENDING";
        job = {
          jobId: String(j.id),
          status,
          progress: typeof j.progress === "number" ? j.progress : 0,
          failedReason: status === "FAILED" ? j.failedReason : undefined,
        };
      }
    }

    return ok({ lineage, job });
  } catch (err) {
    return handleError(err);
  }
}
