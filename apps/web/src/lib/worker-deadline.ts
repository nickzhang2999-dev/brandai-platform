/** Deadline shared by workers. Late promises may settle, but may not persist. */
export function createWorkerDeadline(timeoutMs: number, label: string) {
  const controller = new AbortController();
  const expiresAt = Date.now() + Math.max(1, timeoutMs);
  const error = new Error(`${label}超时，任务已停止，请查看队列后确认是否重新提交`);
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(error); reject(error); }, Math.max(1, timeoutMs));
  });
  // A caller may take time to begin its race (e.g. claiming a DB receipt).
  void timeout.catch(() => undefined);
  return {
    signal: controller.signal,
    expiresAt: new Date(expiresAt),
    check() {
      if (Date.now() >= expiresAt && !controller.signal.aborted) controller.abort(error);
      controller.signal.throwIfAborted();
    },
    run<T>(work: Promise<T>): Promise<T> { return Promise.race([work, timeout]); },
    abort(reason?: unknown) { controller.abort(reason); },
    dispose() { clearTimeout(timer!); },
  };
}

/** Failure bookkeeping must not keep a worker slot alive after its deadline.
 * Conditional updates may finish later; the periodic scoped sweep is the fallback. */
export async function settleWorkerCleanup(work: Promise<unknown>, timeoutMs = 5_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work, new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
  } catch { /* Keep the original job error; cleanup can recover the row later. */ }
  finally { clearTimeout(timer); }
}

export const LEGACY_TASK_RUN_MS = 5 * 60_000;
export const LEGACY_TASK_QUEUE_MS = 10 * 60_000;
export const GENERATION_TARGET_MS = 3 * 60_000;
export const MAX_GENERATION_RUN_MS = 12 * GENERATION_TARGET_MS + 60_000;
export function generationRunBudgetMs(targetCount?: number): number {
  return targetCount ? Math.max(1, Math.min(12, Math.floor(targetCount))) * GENERATION_TARGET_MS + 60_000 : LEGACY_TASK_RUN_MS;
}
