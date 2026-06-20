"use client";

import { useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { ActivityResponse, ActivityRow } from "@brandai/contracts";
import { Badge, Button } from "@brandai/ui";
import { apiFetch } from "@/lib/client";
import { formatElapsed } from "../../queue-widget";
import { Lightbox } from "@/components/lightbox";

const PAGE_SIZE = 50;

// Readable Chinese labels for the raw UsageLog `kind` enum (the table used to
// show GENERATE / COMPLIANCE … verbatim). There are FIVE kinds, not two.
const KIND_LABEL: Record<string, string> = {
  GENERATE: "生图",
  COMPLIANCE: "合规预检",
  RECOGNIZE: "识别",
  PARSE_MANUAL: "解析说明书",
  EDIT: "编辑",
};
const ALL_KINDS = Object.keys(KIND_LABEL);
const kindLabel = (k: string) => KIND_LABEL[k] ?? k;

type StatusFilter = "" | "SUCCEEDED" | "FAILED";
type ImageFilter = "" | "1" | "0";

/**
 * §2.3 — admin activity log. Per-AI-call rows over UsageLog, with readable
 * type labels, server-side filters (类型 / 状态 / 出图), a thumbnail that opens
 * a lightbox, token + cost columns, and cursor "加载更多". Cost is an ESTIMATE
 * (static price table, see header note) — not a billed amount.
 */
export function ActivityTable() {
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [kinds, setKinds] = useState<string[]>([]); // empty = all
  const [status, setStatus] = useState<StatusFilter>("");
  const [hasImage, setHasImage] = useState<ImageFilter>("");
  const [zoom, setZoom] = useState<ActivityRow | null>(null);

  const q = useInfiniteQuery<ActivityResponse>({
    queryKey: ["admin-activity", kinds, status, hasImage],
    initialPageParam: undefined as string | undefined,
    refetchInterval: autoRefresh ? 10_000 : false,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
      const cursor = pageParam as string | undefined;
      if (cursor) qs.set("cursor", cursor);
      if (kinds.length) qs.set("kind", kinds.join(","));
      if (status) qs.set("status", status);
      if (hasImage) qs.set("hasImage", hasImage);
      return apiFetch<ActivityResponse>(`/api/admin/activity?${qs}`);
    },
  });

  const rows: ActivityRow[] = useMemo(
    () => (q.data?.pages ?? []).flatMap((p) => p.rows),
    [q.data],
  );
  const totals = useMemo(() => {
    const total = rows.length;
    const withLatency = rows.filter((r) => r.latencyMs != null);
    const avgLatency =
      withLatency.length > 0
        ? Math.round(
            withLatency.reduce((s, r) => s + (r.latencyMs ?? 0), 0) /
              withLatency.length,
          )
        : null;
    const withImage = rows.filter((r) => r.imageCount > 0).length;
    const imageRate = total > 0 ? Math.round((withImage / total) * 100) : 0;
    const tokenSum = rows.reduce((s, r) => s + (r.totalTokens ?? 0), 0);
    return { total, avgLatency, imageRate, tokenSum };
  }, [rows]);

  const toggleKind = (k: string) =>
    setKinds((cur) =>
      cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k],
    );

  return (
    <div className="flex flex-col gap-6">
      <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="已加载" value={String(totals.total)} />
        <Stat
          label="平均耗时"
          value={
            totals.avgLatency != null ? formatElapsed(totals.avgLatency) : "—"
          }
        />
        <Stat label="出图率" value={`${totals.imageRate}%`} />
        <Stat
          label="累计 Token"
          value={totals.tokenSum > 0 ? totals.tokenSum.toLocaleString() : "—"}
        />
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
            类型
          </span>
          {ALL_KINDS.map((k) => {
            const on = kinds.includes(k);
            return (
              <button
                key={k}
                type="button"
                onClick={() => toggleKind(k)}
                className={
                  "rounded-full border px-3 py-1 text-xs transition-colors " +
                  (on
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border text-muted-foreground hover:bg-muted")
                }
              >
                {kindLabel(k)}
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <FilterSelect
            label="状态"
            value={status}
            onChange={(v) => setStatus(v as StatusFilter)}
            options={[
              ["", "全部"],
              ["SUCCEEDED", "成功"],
              ["FAILED", "失败"],
            ]}
          />
          <FilterSelect
            label="出图"
            value={hasImage}
            onChange={(v) => setHasImage(v as ImageFilter)}
            options={[
              ["", "全部"],
              ["1", "有图"],
              ["0", "无图"],
            ]}
          />
          <label className="ml-auto flex items-center gap-2 font-mono text-xs uppercase tracking-wide text-muted-foreground">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            自动刷新(10s)
          </label>
          {q.isFetching && (
            <span className="font-mono text-[11px] text-muted-foreground">
              加载中…
            </span>
          )}
        </div>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-border bg-card">
        <table className="w-full min-w-[820px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left font-mono text-xs uppercase tracking-wider text-muted-foreground">
              <th className="px-4 py-3 font-medium">预览</th>
              <th className="px-4 py-3 font-medium">时间(UTC)</th>
              <th className="px-4 py-3 font-medium">类型</th>
              <th className="px-4 py-3 font-medium">耗时</th>
              <th className="px-4 py-3 font-medium">Token</th>
              <th className="px-4 py-3 font-medium">出图</th>
              <th className="px-4 py-3 font-medium">状态</th>
              <th className="px-4 py-3 font-medium">模型</th>
              <th className="px-4 py-3 font-medium">尺寸</th>
              <th className="px-4 py-3 text-right font-medium" title="静态价目表估算,非真实账单">
                成本(估算)
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Row key={r.id} row={r} onZoom={() => setZoom(r)} />
            ))}
            {rows.length === 0 && !q.isLoading ? (
              <tr>
                <td
                  colSpan={10}
                  className="px-5 py-10 text-center text-sm text-muted-foreground"
                >
                  无匹配记录。
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <p className="font-mono text-[11px] text-muted-foreground">
        成本为静态价目表估算(按 OpenAI 公布的 gpt-image 单价),非真实账单;实际计费以
        provider 为准。Token 为 provider 上报值,未上报时显示「—」。
      </p>

      {q.hasNextPage ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => q.fetchNextPage()}
          disabled={q.isFetchingNextPage}
        >
          {q.isFetchingNextPage ? "加载中…" : "加载更多"}
        </Button>
      ) : null}

      <Lightbox
        src={zoom?.imageUrl ?? null}
        alt={zoom ? kindLabel(zoom.kind) : undefined}
        caption={
          zoom
            ? `${kindLabel(zoom.kind)} · ${zoom.model ?? ""} · ${zoom.size ?? ""}`
            : undefined
        }
        onClose={() => setZoom(null)}
      />
    </div>
  );
}

function Row({ row, onZoom }: { row: ActivityRow; onZoom: () => void }) {
  return (
    <tr className="border-b border-border/60 last:border-0">
      <td className="px-4 py-2.5">
        {row.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={row.imageUrl}
            alt=""
            onClick={onZoom}
            className="h-10 w-10 cursor-zoom-in rounded-md border border-border object-cover"
          />
        ) : (
          <div className="h-10 w-10 rounded-md border border-dashed border-border" />
        )}
      </td>
      <td className="px-4 py-2.5 font-mono text-[11px] text-muted-foreground">
        {row.createdAt.replace("T", " ").replace(/\..*$/, "")}
      </td>
      <td className="px-4 py-2.5 text-xs">{kindLabel(row.kind)}</td>
      <td className="px-4 py-2.5 font-mono text-xs tabular-nums">
        {row.latencyMs != null ? formatElapsed(row.latencyMs) : "—"}
      </td>
      <td className="px-4 py-2.5 font-mono text-xs tabular-nums">
        {row.totalTokens != null ? row.totalTokens.toLocaleString() : "—"}
      </td>
      <td className="px-4 py-2.5">
        {row.imageCount > 0 ? (
          <Badge tone="pass">有图 {row.imageCount}</Badge>
        ) : (
          <Badge tone="neutral">无</Badge>
        )}
      </td>
      <td className="px-4 py-2.5">
        {row.status === "SUCCEEDED" ? (
          <Badge tone="pass">成功</Badge>
        ) : (
          <Badge tone="danger">失败</Badge>
        )}
      </td>
      <td className="px-4 py-2.5 font-mono text-xs">
        {row.model ?? row.provider ?? "—"}
      </td>
      <td className="px-4 py-2.5 font-mono text-xs">{row.size ?? "—"}</td>
      <td className="px-4 py-2.5 text-right font-mono text-xs tabular-nums">
        {row.costUsd != null ? `$${row.costUsd.toFixed(4)}` : "—"}
      </td>
    </tr>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <label className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 rounded-lg border border-border bg-background px-2 text-xs text-foreground"
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card px-5 py-4">
      <div className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 font-serif text-3xl text-foreground">{value}</div>
    </div>
  );
}
