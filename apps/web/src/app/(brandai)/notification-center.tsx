"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import type {
  NotificationItem,
  NotificationsResponse,
} from "@brandai/contracts";
import { apiFetch } from "@/lib/client";

/**
 * A3 / L3 — top-bar notification center (bell + unread badge + in-app inbox).
 *
 * Polls `GET /api/workspaces/[wsId]/notifications` (terminal generate/edit/
 * recognize/parse-manual/describe/ingest events, derived from real server
 * state). Unread = items newer than a client-persisted `lastSeenAt` marker
 * (localStorage, per-workspace) — no migration. Opening the panel marks all
 * current items seen. Consistent with the §2.3 queue widget idiom (the queue
 * widget shows LIVE progress; this is the persistent TERMINAL history).
 */

const POLL_MS = 20_000;

function seenKey(wsId: string) {
  return `brandai:notif-seen:${wsId}`;
}
function readLastSeen(wsId: string): number {
  if (typeof window === "undefined") return 0;
  const v = window.localStorage.getItem(seenKey(wsId));
  const n = v ? Date.parse(v) : 0;
  return Number.isNaN(n) ? 0 : n;
}

const KIND_ICON: Record<string, string> = {
  GENERATE: "✸",
  EDIT: "✎",
  RECOGNIZE: "✦",
  PARSE_MANUAL: "▦",
  DESCRIBE: "❝",
  INGEST: "⤓",
};

export function NotificationCenter({ wsId }: { wsId: string }) {
  const [open, setOpen] = useState(false);
  const [lastSeen, setLastSeen] = useState<number>(0);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Hydrate the persisted marker on mount (avoids SSR/client mismatch).
  useEffect(() => {
    setLastSeen(readLastSeen(wsId));
  }, [wsId]);

  const { data } = useQuery<NotificationsResponse>({
    queryKey: ["brandai-notifications", wsId],
    enabled: !!wsId,
    refetchInterval: POLL_MS,
    queryFn: () =>
      apiFetch<NotificationsResponse>(
        `/api/workspaces/${wsId}/notifications`,
      ),
  });

  const items = useMemo(() => data?.items ?? [], [data]);
  const unread = useMemo(
    () => items.filter((it) => Date.parse(it.createdAt) > lastSeen).length,
    [items, lastSeen],
  );

  // Opening the inbox marks the newest item's timestamp as seen.
  function markSeen() {
    const newest = items[0]?.createdAt;
    const stamp = newest ?? new Date().toISOString();
    if (typeof window !== "undefined") {
      window.localStorage.setItem(seenKey(wsId), stamp);
    }
    setLastSeen(Date.parse(stamp));
  }

  function toggle() {
    setOpen((o) => {
      const next = !o;
      if (next) markSeen();
      return next;
    });
  }

  // Click-away + Escape close.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={panelRef} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-label="通知"
        aria-expanded={open}
        className="relative flex h-9 w-9 items-center justify-center rounded-full border border-border bg-card text-muted-foreground transition-colors hover:border-primary/30 hover:text-primary"
      >
        <span className="text-base leading-none">◔</span>
        {unread > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground">
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute right-0 top-11 z-50 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-3xl border border-border bg-card shadow-[0_24px_70px_rgba(124,92,255,0.18)]">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <span className="text-sm font-semibold">通知</span>
            <span className="text-xs text-muted-foreground">
              {items.length} 条近期
            </span>
          </div>
          {items.length === 0 ? (
            <div className="px-4 py-10 text-center text-xs text-muted-foreground">
              暂无通知。出图、改图、识别等任务完成后会在这里提醒。
            </div>
          ) : (
            <ul className="max-h-[26rem] overflow-y-auto">
              {items.map((it) => (
                <NotificationRow key={it.id} item={it} />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

function NotificationRow({ item }: { item: NotificationItem }) {
  const failed = item.status === "FAILED";
  const icon = KIND_ICON[item.kind] ?? "•";
  const body = (
    <div className="flex gap-3 px-4 py-3 transition-colors hover:bg-muted/40">
      <span
        className={[
          "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-2xl text-sm",
          failed
            ? "bg-destructive/10 text-destructive"
            : "bg-accent-soft text-primary",
        ].join(" ")}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[13px] font-medium text-foreground">
            {item.title}
          </span>
          <span
            className={[
              "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
              failed
                ? "bg-destructive/10 text-destructive"
                : "bg-success/10 text-success",
            ].join(" ")}
          >
            {failed ? "失败" : "完成"}
          </span>
        </div>
        {item.detail ? (
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {item.detail}
          </p>
        ) : null}
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          {formatRelative(item.createdAt)}
        </p>
      </div>
    </div>
  );
  return (
    <li className="border-b border-border last:border-b-0">
      {item.href ? (
        <Link href={item.href} className="block">
          {body}
        </Link>
      ) : (
        body
      )}
    </li>
  );
}

/** Compact relative time (本地化中文)，给收件箱行用。 */
function formatRelative(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} 天前`;
  return new Date(then).toLocaleDateString("zh-CN");
}
