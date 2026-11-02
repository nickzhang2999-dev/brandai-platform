"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { InspirationReceiveStatus } from "@brandai/contracts";
import { Button } from "@brandai/ui";
import { apiFetch } from "@/lib/client";

const active = (status?: string) => status === "PENDING" || status === "RUNNING";

/** Workspace authenticates the consumer; receiving updates its resolved source library. */
export default function InspirationReceive({ wsId }: { wsId: string }) {
  const cache = useQueryClient();
  const base = `/api/workspaces/${encodeURIComponent(wsId)}/inspiration`;
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(Date.now());
  const submittingRef = useRef(false);
  const alive = useRef(true);
  const completed = useRef<string | null>(null);
  const status = useQuery({
    queryKey: ["inspiration-receive", wsId],
    queryFn: async ({ signal }) => InspirationReceiveStatus.parse(await apiFetch(`${base}/sync`, {
      cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
    })),
    retry: false,
    refetchInterval: query => active(query.state.data?.task?.status) ? 2000 : 15000,
  });
  const task = status.data?.task;
  const expired = Boolean(task && active(task.status) && (!task.expiresAt || Date.parse(task.expiresAt) <= now));
  const running = Boolean(task && active(task.status) && !expired);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    // A fresh authoritative task supersedes transient submit/uncertain text,
    // including failure and timeout. Never leave "正在读取" beside a failure.
    if (task && !status.isFetching) setNotice("");
  }, [status.dataUpdatedAt, status.isFetching, task, expired]);
  useEffect(() => {
    if (!active(task?.status)) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [task?.status]);
  useEffect(() => {
    if (task?.status !== "SUCCEEDED" || completed.current === task.id) return;
    completed.current = task.id;
    setNotice("");
    for (const prefix of ["inspiration", "inspiration-detail", "inspiration-bookmarks"]) {
      void cache.invalidateQueries({ queryKey: [prefix, wsId] });
    }
  }, [task?.id, task?.status, cache, wsId]);

  async function receive() {
    if (submittingRef.current || running || !status.data?.canReceive || status.isError) return;
    submittingRef.current = true; setSubmitting(true); setNotice("");
    try {
      // Cancel an older GET so it cannot overwrite the immediate post-submit refresh.
      await cache.cancelQueries({ queryKey: ["inspiration-receive", wsId] });
      await apiFetch(`${base}/sync`, { method: "POST", signal: AbortSignal.timeout(12000) });
      if (alive.current) setNotice("已提交接收请求，正在读取后台进度。可以离开页面，稍后回来查看。");
    } catch {
      if (alive.current) setNotice("接收请求暂未确认，请查看下方后台状态。请求可能已经受理，系统不会自动重复提交。");
    } finally {
      // Query the durable task even after a lost POST response; never auto-retry POST.
      await status.refetch();
      submittingRef.current = false;
      if (alive.current) setSubmitting(false);
    }
  }

  const disabledReason = status.isPending ? "正在读取接收状态…" : status.isError ? "暂时无法读取接收状态，请刷新后再操作。"
    : !status.data?.enabled ? "灵感接收尚未开放。" : !status.data.configured ? status.data.canReceiveReason || "接收连接尚未配置，请联系管理员。"
      : !status.data.canReceive ? status.data.canReceiveReason || "当前账号不能接收新灵感，请联系公司灵感库管理员；已有案例仍可浏览。" : null;
  return <section aria-label="接收 Omni 灵感" className="mb-4 rounded-2xl border border-border bg-card p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0"><h2 className="text-sm font-semibold">接收 Omni 灵感</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">
        {status.data?.mode === "automatic" ? "Omni 自动整理并发布，公司灵感库自动更新；需要时可立即接收。" : "Omni 自动整理并发布。点击接收后，最新案例进入公司灵感库，各品牌按需收藏引用；撤回持续自动同步。"}
      </p></div>
      <Button type="button" onClick={() => void receive()} disabled={Boolean(disabledReason) || submitting || running}>
        {submitting ? "正在提交…" : running ? task?.status === "PENDING" ? "接收排队中…" : "正在接收…" : "接收最新灵感"}
      </Button>
    </div>
    {disabledReason && <p role="status" className="mt-3 text-xs text-muted-foreground">{disabledReason}</p>}
    {status.data?.sourceLibrary?.kind === "WORKSPACE" && <p className="mt-2 text-xs text-muted-foreground">当前显示品牌原有灵感库；原有内容不会自动转入公司共享范围。</p>}
    {status.isError && <button type="button" className="mt-2 text-xs text-primary underline" onClick={() => void status.refetch()}>重新读取接收状态</button>}
    {notice && <p role="status" className="mt-3 text-xs leading-5 text-muted-foreground">{notice}</p>}
    {task && <div className="mt-3 border-t border-border pt-3 text-xs leading-5" aria-live="polite">
      {running ? <p role="status" className="text-muted-foreground">{task.status === "PENDING" ? "已进入后台队列" : "正在拉取并校验知识包"}，可以刷新或离开页面，任务会继续。最迟处理至 {task.expiresAt ? new Date(task.expiresAt).toLocaleTimeString("zh-CN") : "暂无时限记录"}。</p>
        : expired || task.status === "FAILED" ? <p role="alert" className="text-destructive">{expired ? "本次接收已超时，请先刷新状态；确认未完成后可再次点击接收。" : task.error || "本次接收未完成，可以再次点击接收。"} 已有案例保留。</p>
          : <p role="status" className="text-muted-foreground">最近一次接收检查已完成，案例列表已刷新；没有新发布内容时保留现有版本。</p>}
      <p className="mt-1 text-muted-foreground">最近状态时间：{new Date(task.updatedAt).toLocaleString("zh-CN")}</p>
    </div>}
  </section>;
}
