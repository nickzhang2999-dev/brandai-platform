import { prisma } from "@brandai/db";
import type { AsyncTaskKind, TaskState } from "@brandai/contracts";

/**
 * H-async — create / update / read server-authoritative async task rows. The
 * update helpers are best-effort (they swallow errors) so task bookkeeping can
 * never sink the underlying job.
 */

export async function createTask(input: {
  workspaceId: string;
  kind: AsyncTaskKind;
  jobId?: string;
}): Promise<{ id: string }> {
  const row = await prisma.asyncTask.create({
    data: {
      workspaceId: input.workspaceId,
      kind: input.kind,
      jobId: input.jobId ?? null,
      status: "PENDING",
      progress: 0,
    },
    select: { id: true },
  });
  return row;
}

async function safeUpdate(taskId: string | undefined, data: Record<string, unknown>) {
  if (!taskId) return;
  try {
    await prisma.asyncTask.update({ where: { id: taskId }, data });
  } catch (err) {
    console.error("[async-task] update failed:", err);
  }
}

export const markRunning = (taskId?: string, progress = 5) =>
  safeUpdate(taskId, { status: "RUNNING", progress });
export const setProgress = (taskId: string | undefined, progress: number) =>
  safeUpdate(taskId, { progress });
export const markSucceeded = (
  taskId: string | undefined,
  ref?: { refId?: string; refCount?: number },
) =>
  safeUpdate(taskId, {
    status: "SUCCEEDED",
    progress: 100,
    refId: ref?.refId ?? null,
    refCount: ref?.refCount ?? 0,
  });
export const markFailed = (taskId: string | undefined, error: string) =>
  safeUpdate(taskId, { status: "FAILED", error: error.slice(0, 500) });

export async function getTask(
  workspaceId: string,
  taskId: string,
): Promise<TaskState | null> {
  const t = await prisma.asyncTask.findUnique({ where: { id: taskId } });
  if (!t || t.workspaceId !== workspaceId) return null;
  return {
    id: t.id,
    workspaceId: t.workspaceId,
    kind: t.kind as TaskState["kind"],
    status: t.status as TaskState["status"],
    progress: t.progress,
    ...(t.jobId ? { jobId: t.jobId } : {}),
    ...(t.refId ? { refId: t.refId } : {}),
    refCount: t.refCount,
    ...(t.error ? { error: t.error } : {}),
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}
