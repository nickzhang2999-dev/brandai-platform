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

/**
 * 写「成功」终态，**写不成就抛**。
 *
 * `safeUpdate` 吞异常是给进度更新用的：进度写丢了无所谓，下一拍会补。终态不一样
 * ——写丢了任务会永远停在 RUNNING：图层已经提交、BullMQ 判 job 成功，而客户端
 * 那边（"除非服务端明确说 404/403 否则保住线索、保持锁着"）会一直锁着等一个
 * 永远不来的完成通知。
 *
 * 调用方必须已经**认领过终态**（decompose worker 里的 `settled = true`），并在
 * 捕获到这里抛出的异常时把认领让出去，好让失败路径接手回滚 + 标 FAILED。
 *
 * 只给分层用，不动其它 kind 的既有行为——那属于扩范围。
 */
export async function markSucceededOrThrow(
  taskId: string | undefined,
  ref?: { refId?: string; refCount?: number },
): Promise<void> {
  if (!taskId) return;
  await prisma.asyncTask.update({
    where: { id: taskId },
    data: {
      status: "SUCCEEDED",
      progress: 100,
      refId: ref?.refId ?? null,
      refCount: ref?.refCount ?? 0,
    },
  });
}

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
