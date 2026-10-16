import { prisma, type Prisma } from "@brandai/db";
import { createWorkerDeadline, settleWorkerCleanup, LEGACY_TASK_QUEUE_MS, LEGACY_TASK_RUN_MS } from "./worker-deadline";

export const LEGACY_TASK_KINDS = ["EDIT", "RECOGNIZE", "PARSE_MANUAL", "DESCRIBE", "SUMMARIZE", "INGEST"] as const;
type LegacyKind = typeof LEGACY_TASK_KINDS[number];
export interface LegacyTaskContext {
  signal: AbortSignal;
  check(): void;
  write<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
  succeed(ref?: { refId?: string; refCount?: number }): Promise<void>;
}

/** Claim once before any paid call. A stalled/replayed job never buys again. */
export async function runLegacyTask<T>(
  input: { taskId?: string; workspaceId: string; kind: LegacyKind },
  work: (context: LegacyTaskContext) => Promise<T>,
): Promise<T> {
  if (!input.taskId) throw new Error("任务缺少持久化凭据，请重新提交；未调用模型");
  const deadline = createWorkerDeadline(LEGACY_TASK_RUN_MS, input.kind);
  const scope = { id: input.taskId, workspaceId: input.workspaceId, kind: input.kind };
  let claimed = false;
  const activeWhere = () => ({ ...scope, status: "RUNNING" as const, expiresAt: deadline.expiresAt });
  const failAttempt = (error: unknown) => settleWorkerCleanup(prisma.asyncTask.updateMany({ where: activeWhere(), data: {
    status: "FAILED", error: String(error).slice(0, 500),
  } }));
  const context: LegacyTaskContext = {
    signal: deadline.signal,
    check: () => deadline.check(),
    async write(work) {
      deadline.check();
      return prisma.$transaction(async tx => {
        deadline.check();
        // The conditional write locks this exact attempt through the business
        // mutation. A timeout/cleanup cannot interleave and resurrect a result.
        const lease = await tx.asyncTask.updateMany({ where: {
          ...activeWhere(), AND: [{ expiresAt: { gt: new Date() } }],
        }, data: { updatedAt: new Date() } });
        if (lease.count !== 1) throw new Error("任务已结束或执行凭据已失效，停止写入");
        deadline.check();
        const value = await work(tx);
        deadline.check(); // Throw inside the transaction to roll back late work.
        return value;
      }, { maxWait: 1_000, timeout: 5_000 });
    },
    async succeed(ref) {
      await context.write(async tx => {
        await tx.asyncTask.updateMany({ where: activeWhere(), data: {
          status: "SUCCEEDED", progress: 100, error: null,
          refId: ref?.refId ?? null, refCount: ref?.refCount ?? 0,
        } });
      });
    },
  };
  try {
    const claim = await deadline.run(prisma.asyncTask.updateMany({ where: {
      ...scope, status: "PENDING", expiresAt: null,
      createdAt: { gte: new Date(Date.now() - LEGACY_TASK_QUEUE_MS) },
    }, data: { status: "RUNNING", progress: 5, error: null, expiresAt: deadline.expiresAt } }).then(async claim => {
      // If the DB completes a claim after the outer race already returned,
      // close only the row this attempt actually claimed; never run the work.
      if (claim.count === 1 && deadline.signal.aborted) await failAttempt(deadline.signal.reason);
      return claim;
    }));
    if (claim.count !== 1) throw new Error("任务已经开始、结束或排队过期；不会重复调用模型");
    claimed = true;
    deadline.check();
    return await deadline.run(work(context));
  } catch (error) {
    deadline.abort(error);
    if (claimed) await failAttempt(error);
    throw error;
  } finally { deadline.dispose(); }
}

/** Deliberately excludes Studio receipts, DECOMPOSE and compliance outboxes. */
export async function sweepStaleLegacyTasks(now = new Date()): Promise<number> {
  let total = 0;
  for (const kind of LEGACY_TASK_KINDS) {
    const result = await prisma.asyncTask.updateMany({ where: { kind, OR: [
      { status: "PENDING", expiresAt: null, createdAt: { lt: new Date(now.getTime() - LEGACY_TASK_QUEUE_MS) } },
      { status: "RUNNING", expiresAt: { lte: now } },
      // In-flight rows created before deadlines were introduced.
      { status: "RUNNING", expiresAt: null, updatedAt: { lt: new Date(now.getTime() - LEGACY_TASK_RUN_MS - 60_000) } },
    ] }, data: { status: "FAILED", error: "任务排队或执行超时，已停止；请确认结果后重新提交" } });
    total += result.count;
  }
  return total;
}
