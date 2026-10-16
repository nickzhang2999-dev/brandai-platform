"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, type QueryKey } from "@tanstack/react-query";
import { apiFetch } from "./client";

export const TASK_POLL_WINDOW_MS = 6 * 60_000;
export const TASK_POLL_PAUSED_MESSAGE = "自动查询已暂停，任务可能仍在后台处理；可继续查询或去队列查看。不会自动重新生成。";
export const isTaskTerminal = (status?: string | null) => ["SUCCEEDED", "FAILED", "READY", "CANCELLED", "NOT_REQUESTED"].includes(status ?? "");

/** A foreground observation window, not the server's job lifetime. Multi-size
 * jobs may legitimately run longer. Only an explicit resume/new task renews
 * this window; React rerenders and progress messages never do. */
export function useBoundedTaskPoll({ taskKey, active = true, startedAt, intervalMs = 2500 }: {
  taskKey: string | null; active?: boolean; startedAt?: { current: number }; intervalMs?: number;
}) {
  const clock = useRef({ key: taskKey, from: startedAt?.current || Date.now(), paused: false });
  if (clock.current.key !== taskKey) clock.current = { key: taskKey, from: startedAt?.current || Date.now(), paused: false };
  const [revision, update] = useState(0);
  const remaining = useCallback(() => Math.max(0, TASK_POLL_WINDOW_MS - (Date.now() - clock.current.from)), []);
  const expired = useCallback(() => clock.current.paused || remaining() <= 0, [remaining]);
  const resume = useCallback(() => { clock.current.from = Date.now(); clock.current.paused = false; update(value => value + 1); }, []);
  const pause = useCallback(() => { clock.current.paused = true; update(value => value + 1); }, []);
  const setTimedOut = useCallback((value: boolean) => { if (value) pause(); else resume(); }, [pause, resume]);
  useEffect(() => {
    if (!taskKey || !active || clock.current.paused || remaining() <= 0) return;
    const timer = setTimeout(() => update(value => value + 1), remaining());
    return () => clearTimeout(timer);
  }, [taskKey, active, revision, remaining]);
  const timedOut = !!taskKey && active && expired();
  const interval = useCallback((status?: string | null): number | false =>
    !taskKey || !active || isTaskTerminal(status) || expired() ? false : Math.min(intervalMs, Math.max(1, remaining())),
  [taskKey, active, intervalMs, expired, remaining]);
  return { timedOut, resume, pause, setTimedOut, remaining, expired, interval };
}

/** React Query integration: cancellation on context changes, per-read timeout,
 * and a manual resume that reads the same task instead of posting it again. */
export function useBoundedTaskQuery<T>({ queryKey, taskKey, enabled = true, queryFn, getStatus, startedAt, intervalMs = 2500 }: {
  queryKey: QueryKey; taskKey: string | null; enabled?: boolean;
  queryFn: (signal: AbortSignal) => Promise<T>; getStatus: (data: T | undefined) => string | null | undefined;
  startedAt?: { current: number }; intervalMs?: number;
}) {
  const budget = useBoundedTaskPoll({ taskKey, active: enabled, startedAt, intervalMs });
  const query = useQuery<T>({ queryKey, enabled: !!taskKey && enabled && !budget.timedOut, retry: false,
    refetchOnWindowFocus: false, refetchOnReconnect: false,
    queryFn: ({ signal }) => queryFn(AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(20_000, budget.remaining())))])),
    refetchInterval: q => budget.interval(getStatus(q.state.data)),
  });
  const terminal = isTaskTerminal(getStatus(query.data));
  const resume = useCallback(() => {
    if (!taskKey || terminal) return;
    const wasPaused = budget.timedOut;
    budget.resume();
    // A failed GET can happen before the budget expires. In that case enabled
    // stays true, so explicitly read now rather than waiting for an interval.
    // An expired observer refetches once through its false -> true transition.
    if (!wasPaused) void query.refetch();
  }, [taskKey, terminal, budget.timedOut, budget.resume, query.refetch]);
  return { ...query, timedOut: !terminal && budget.timedOut, resume, setTimedOut: budget.setTimedOut };
}

export type AsyncTaskReceipt = { taskId: string; status: string };
export type AsyncTaskView<T> = { id: string; status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED"; progress: number; result?: T; error?: string };
export function useAsyncTaskResult<T>(workspaceId: string, taskId: string | null) {
  return useBoundedTaskQuery<AsyncTaskView<T>>({ queryKey: ["async-task-result", workspaceId, taskId],
    taskKey: taskId ? JSON.stringify([workspaceId, taskId]) : null,
    queryFn: signal => apiFetch(`/api/workspaces/${workspaceId}/tasks/${taskId}`, { signal }), getStatus: data => data?.status,
  });
}
