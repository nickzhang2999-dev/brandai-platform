"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import type { QueueItem, QueueResponse } from "@brandai/contracts";
import { Badge } from "@brandai/ui";
import { apiFetch } from "@/lib/client";

/**
 * §2.3 — persistent bottom-right queue widget. Polls
 * `GET /api/workspaces/[wsId]/queue` fast while anything is active (2.5s)
 * and backs off (30s) when idle. Hidden entirely when there are no items,
 * and on non-workspace pages (`wsId == null`).
 *
 * The widget shows a coarse status badge + a LIVE elapsed timer for active
 * rows (so the operator knows nothing is silently wedged), the final
 * `durationMs` for terminal rows, and the truncated error for FAILED. Active
 * rows older than 6 minutes get a "超时?" warning style as a client safety
 * net — the server's 5-min watchdog should have already marked them FAILED.
 */
export function QueueWidget({ wsId }: { wsId: string | null }) {
  const [open, setOpen] = useState(false);
  // Ticking clock for the live-elapsed display. Only re-renders when active
  // rows exist (driven by activeCount).
  const [nowTs, setNowTs] = useState(() => Date.now());

  const { data } = useQuery<QueueResponse>({
    queryKey: ["workspace-queue", wsId],
    enabled: !!wsId,
    refetchInterval: (q) => {
      const active = q.state.data?.activeCount ?? 0;
      return active > 0 ? 2500 : 30_000;
    },
    queryFn: () =>
      apiFetch<QueueResponse>(`/api/workspaces/${wsId}/queue`),
  });

  const items = data?.items ?? [];
  const active = data?.activeCount ?? 0;

  useEffect(() => {
    if (active === 0) return;
    // Reset immediately so a widget that re-appears after an idle (30s) poll
    // doesn't flash "00:00" for active rows until the first 1s tick fires.
    setNowTs(Date.now());
    const t = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);

  // Auto-open while anything is active so the user always sees feedback;
  // collapse when idle. The user can still toggle manually.
  useEffect(() => {
    if (active > 0) setOpen(true);
  }, [active]);

  if (!wsId || items.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 w-80 max-w-[calc(100vw-2rem)] font-mono text-xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between rounded-2xl border border-foreground/15 bg-card px-4 py-2.5 shadow-lg shadow-black/10 transition hover:bg-muted/40"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2">
          {active > 0 ? (
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />
          ) : (
            <span className="inline-block h-2 w-2 rounded-full bg-foreground/30" />
          )}
          <span className="uppercase tracking-wide text-foreground/80">
            队列
          </span>
          <span className="text-foreground">
            {active > 0
              ? `${active} 进行中 / ${items.length}`
              : `${items.length} 条`}
          </span>
        </span>
        <span className="text-foreground/50">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <ul className="mt-2 max-h-96 overflow-y-auto rounded-2xl border border-foreground/15 bg-card shadow-lg shadow-black/10">
          {items.map((it) => (
            <QueueRow key={it.id} item={it} nowTs={nowTs} />
          ))}
        </ul>
      )}
    </div>
  );
}

function QueueRow({ item, nowTs }: { item: QueueItem; nowTs: number }) {
  const isActive = item.status === "PENDING" || item.status === "RUNNING";
  const createdAt = useMemo(
    () => new Date(item.createdAt).getTime(),
    [item.createdAt],
  );
  const liveElapsed = nowTs - createdAt;
  const elapsedMs = isActive
    ? Math.max(0, liveElapsed)
    : (item.durationMs ?? null);
  const stale = isActive && liveElapsed > 6 * 60_000;

  const inner = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-foreground/80">{item.sceneType}</span>
        <StatusBadge status={item.status} stale={stale} />
      </div>
      {isActive && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-foreground/10">
          <div
            className="h-full bg-accent transition-all duration-500"
            style={{ width: `${item.progress}%` }}
          />
        </div>
      )}
      <div className="mt-1.5 flex items-center justify-between text-[10px] text-foreground/60">
        <span className="tabular-nums">
          {elapsedMs != null ? formatElapsed(elapsedMs) : "—"}
        </span>
        {item.versionCount > 0 && (
          <span>{item.versionCount} 版本</span>
        )}
      </div>
      {item.status === "FAILED" && item.error && (
        <p
          className="mt-1.5 truncate text-[10px] text-destructive/80"
          title={item.error}
        >
          {item.error}
        </p>
      )}
      {stale && (
        <p className="mt-1.5 text-[10px] text-warning">
          已超过 6 分钟未完成,可能已失败
        </p>
      )}
    </>
  );

  // E · 看得到完成→点得进图 —— 行可点时深链到该出图的工作台(带 Campaign)。
  return (
    <li className="border-b border-foreground/10 last:border-b-0">
      {item.projectId ? (
        <Link
          href={`/workspace?gen=${item.id}&project=${item.projectId}`}
          className="block px-4 py-3 transition-colors hover:bg-muted/40"
        >
          {inner}
        </Link>
      ) : (
        <div className="px-4 py-3">{inner}</div>
      )}
    </li>
  );
}

function StatusBadge({
  status,
  stale,
}: {
  status: QueueItem["status"];
  stale: boolean;
}) {
  if (stale) return <Badge tone="danger">超时?</Badge>;
  switch (status) {
    case "PENDING":
      return <Badge tone="neutral">排队</Badge>;
    case "RUNNING":
      return <Badge tone="strong">运行中</Badge>;
    case "SUCCEEDED":
      return <Badge tone="pass">完成</Badge>;
    case "FAILED":
      return <Badge tone="danger">失败</Badge>;
  }
}

/** mm:ss for short, h:mm:ss for longer. Used by the wizard too. */
export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (hh > 0) return `${hh}:${pad(mm)}:${pad(ss)}`;
  return `${pad(mm)}:${pad(ss)}`;
}
