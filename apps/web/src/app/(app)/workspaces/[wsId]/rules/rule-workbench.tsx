"use client";

import { useEffect, useMemo, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  Asset,
  BrandRule,
  RecognizeResponse,
  RuleSnapshotSummary,
  RestoreRuleSnapshotResult,
  RuleStrength,
  RuleType,
  TaskState,
} from "@brandai/contracts";
import {
  Button,
  Badge,
  Input,
  Textarea,
  Spinner,
  Panel,
  SectionHeading,
  FieldLabel,
  StyleTag,
  MiniStat,
  ColorSwatch,
  ConsistencyScoreCard,
  AIInsightPanel,
} from "@brandai/ui";
import { apiFetch, assetThumbUrl } from "@/lib/client";
import { VIModuleForm } from "./vi-module-form";

type Tab = "rules" | "colors" | "versions";

type ColorSystem = NonNullable<RecognizeResponse["colorSystem"]>;

interface JobStatus {
  jobId: string;
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";
  progress?: number;
  ruleCount?: number;
  failedReason?: string;
}

const RULE_TYPE_LABELS: Record<string, string> = {
  color: "色彩",
  font: "字体",
  layout: "版式构图",
  imagery: "影像风格",
  copy: "文案语气",
  logo: "Logo 规范",
};

const RULE_TYPE_ORDER: RuleType[] = [
  "color",
  "font",
  "layout",
  "imagery",
  "copy",
  "logo",
];

const STRENGTHS: { value: RuleStrength; label: string }[] = [
  { value: "STRONG", label: "强规则" },
  { value: "WEAK", label: "弱规则" },
  { value: "FORBIDDEN", label: "慎用 / 禁用" },
];

function strengthTone(s: RuleStrength): "strong" | "weak" | "danger" {
  if (s === "STRONG") return "strong";
  if (s === "FORBIDDEN") return "danger";
  return "weak";
}

function statusTone(
  s: BrandRule["status"],
): "pass" | "danger" | "neutral" {
  if (s === "CONFIRMED") return "pass";
  if (s === "REJECTED") return "danger";
  return "neutral";
}

export function RuleWorkbench({
  wsId,
  initialAssets,
  initialRules,
}: {
  wsId: string;
  initialAssets: Asset[];
  initialRules: BrandRule[];
}) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("rules");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [jobId, setJobId] = useState<string | null>(null);
  // VI-manual parsing reuses the recognition machinery: a VI_DOC asset → a
  // parse-manual job → DRAFT rules in the SAME confirm/edit/reject list below.
  const viDocs = useMemo(
    () => initialAssets.filter((a) => a.category === "VI_DOC"),
    [initialAssets],
  );
  const [manualAssetId, setManualAssetId] = useState<string>("");
  const [manualJobId, setManualJobId] = useState<string | null>(null);

  const { data: rules = initialRules } = useQuery({
    queryKey: ["rules", wsId],
    queryFn: () => apiFetch<BrandRule[]>(`/api/workspaces/${wsId}/rules`),
    initialData: initialRules,
  });

  // Poll the BullMQ job state until it terminates.
  const { data: job } = useQuery({
    queryKey: ["recognize-job", wsId, jobId],
    enabled: !!jobId,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === "SUCCEEDED" || s === "FAILED" ? false : 1500;
    },
    queryFn: () =>
      apiFetch<JobStatus>(
        `/api/workspaces/${wsId}/rules/recognize?jobId=${jobId}`,
      ),
  });

  const recognizing =
    !!jobId && job?.status !== "SUCCEEDED" && job?.status !== "FAILED";

  // H-async — server-authoritative resume. Keep the recognize/parse-manual task
  // id in the URL (?task=) so a refresh re-attaches to the running job + its
  // real progress, mirroring the generate `?gen=` pattern.
  function syncTaskUrl(id: string | null) {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("task", id);
    else url.searchParams.delete("task");
    window.history.replaceState(null, "", url.toString());
  }

  const start = useMutation({
    mutationFn: () =>
      apiFetch<{ jobId: string; taskId: string }>(
        `/api/workspaces/${wsId}/rules/recognize`,
        {
          method: "POST",
          body: JSON.stringify({ assetIds: [...selected] }),
        },
      ),
    onSuccess: (r) => {
      setJobId(r.jobId);
      syncTaskUrl(r.taskId);
    },
  });

  // Poll the parse-manual job — same shape / lifecycle as the recognize job.
  const { data: manualJob } = useQuery({
    queryKey: ["parse-manual-job", wsId, manualJobId],
    enabled: !!manualJobId,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === "SUCCEEDED" || s === "FAILED" ? false : 1500;
    },
    queryFn: () =>
      apiFetch<JobStatus>(
        `/api/workspaces/${wsId}/rules/parse-manual?jobId=${manualJobId}`,
      ),
  });

  const parsing =
    !!manualJobId &&
    manualJob?.status !== "SUCCEEDED" &&
    manualJob?.status !== "FAILED";

  const parseManual = useMutation({
    mutationFn: () =>
      apiFetch<{ jobId: string; taskId: string }>(
        `/api/workspaces/${wsId}/rules/parse-manual`,
        {
          method: "POST",
          body: JSON.stringify({ assetId: manualAssetId }),
        },
      ),
    onSuccess: (r) => {
      setManualJobId(r.jobId);
      syncTaskUrl(r.taskId);
    },
  });

  // Resume after a refresh: read ?task=, re-attach to a still-running job (by
  // kind) or just refresh the rules if it already finished.
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("task");
    if (!t) return;
    apiFetch<TaskState>(`/api/workspaces/${wsId}/tasks/${t}`)
      .then((task) => {
        if (
          (task.status === "RUNNING" || task.status === "PENDING") &&
          task.jobId
        ) {
          if (task.kind === "PARSE_MANUAL") setManualJobId(task.jobId);
          else setJobId(task.jobId);
        } else {
          qc.invalidateQueries({ queryKey: ["rules", wsId] });
          syncTaskUrl(null);
        }
      })
      .catch(() => syncTaskUrl(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When the job terminates, refresh the rule list once and stop polling.
  // P3.4 — on FAILED, intentionally keep `jobId` set so the FAILED card +
  // 重试 button stays mounted; the retry handler clears jobId itself when
  // the user re-fires the mutation. On SUCCEEDED we still clear, because
  // there's no actionable next step.
  useEffect(() => {
    if (job?.status === "SUCCEEDED") {
      qc.invalidateQueries({ queryKey: ["rules", wsId] });
      setJobId(null);
      syncTaskUrl(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.status, qc, wsId]);

  // Same lifecycle for the parse-manual job — DRAFT rules land in the list.
  useEffect(() => {
    if (manualJob?.status === "SUCCEEDED") {
      qc.invalidateQueries({ queryKey: ["rules", wsId] });
      setManualJobId(null);
      syncTaskUrl(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manualJob?.status, qc, wsId]);

  const grouped = useMemo(() => {
    const map = new Map<string, BrandRule[]>();
    for (const r of rules) {
      const arr = map.get(r.type) ?? [];
      arr.push(r);
      map.set(r.type, arr);
    }
    return map;
  }, [rules]);

  const confirmedCount = rules.filter(
    (r) => r.status === "CONFIRMED",
  ).length;

  // Color System payload is persisted by the worker onto the first
  // `color` rule's value (the Prisma schema is frozen, no Job model).
  const colorSystem = useMemo<ColorSystem | null>(() => {
    for (const r of rules) {
      const cs = (r.value as Record<string, unknown>)?.colorSystem;
      if (cs) return cs as ColorSystem;
    }
    return null;
  }, [rules]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const tabs: { value: Tab; label: string }[] = [
    { value: "rules", label: "规则与证据" },
    { value: "colors", label: "Color System 报告" },
    { value: "versions", label: "版本管理" },
  ];

  return (
    <div className="flex flex-col gap-10">
      {/* Demoted stat strip — mono numbers over warm sand */}
      <section className="rounded-2xl border border-foreground/10 bg-card/40 px-6 py-5">
        <div className="grid grid-cols-3 gap-6">
          <MiniStat label="RULES" value={rules.length} hint="规则总数" />
          <MiniStat
            label="CONFIRMED"
            value={confirmedCount}
            hint="已确认 · 供 M3 生成调用"
          />
          <MiniStat
            label="ASSETS"
            value={initialAssets.length}
            hint="可发起识别的素材"
          />
        </div>
      </section>

      {/* Editorial pill tabs */}
      <div className="flex flex-wrap gap-2">
        {tabs.map((t) => {
          const active = tab === t.value;
          return (
            <button
              key={t.value}
              type="button"
              onClick={() => setTab(t.value)}
              className={`rounded-full border px-4 py-1.5 font-mono text-xs uppercase tracking-[0.15em] transition-colors ${
                active
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-foreground/15 text-foreground/70 hover:bg-muted"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === "rules" ? (
        <>
          <Panel className="flex flex-col gap-6">
            <SectionHeading
              eyebrow="RECOGNIZE · 发起识别"
              title="发起风格识别"
              action={
                <Button
                  disabled={
                    selected.size === 0 ||
                    start.isPending ||
                    recognizing
                  }
                  onClick={() => start.mutate()}
                >
                  {start.isPending || recognizing ? <Spinner /> : null}
                  识别选中素材（{selected.size}）
                </Button>
              }
            />

            {recognizing ? (
              <div className="rounded-2xl border border-foreground/10 bg-muted px-5 py-4 text-sm text-muted-foreground">
                识别中… {job?.status ?? "PENDING"} ·{" "}
                {job?.progress ?? 0}%
              </div>
            ) : null}
            {job?.status === "FAILED" ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-destructive/30 bg-destructive/10 px-5 py-4 text-sm text-destructive">
                <span>识别失败：{job.failedReason ?? "未知错误"}</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={start.isPending || selected.size === 0}
                  onClick={() => {
                    setJobId(null);
                    syncTaskUrl(null);
                    start.mutate();
                  }}
                >
                  重试
                </Button>
              </div>
            ) : null}

            {initialAssets.length === 0 ? (
              <div className="flex flex-col items-start gap-3 rounded-2xl border border-dashed border-foreground/15 bg-muted/40 px-6 py-8">
                <p className="text-sm text-muted-foreground">
                  暂无资产，先去资产库上传或从官网读取。
                </p>
              </div>
            ) : (
              <div>
                <FieldLabel className="mb-4">
                  选择素材 · {selected.size} / {initialAssets.length}
                </FieldLabel>
                <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4">
                  {initialAssets.map((a) => {
                    const on = selected.has(a.id);
                    return (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => toggle(a.id)}
                        className={`group flex flex-col gap-2 text-left transition ${
                          on ? "opacity-100" : "opacity-90 hover:opacity-100"
                        }`}
                      >
                        <div
                          className={`relative aspect-square overflow-hidden rounded-2xl border shadow-sm transition-all ${
                            on
                              ? "border-accent ring-2 ring-accent"
                              : "border-foreground/10 group-hover:-translate-y-0.5 group-hover:shadow-md"
                          }`}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={a.url}
                            alt={a.fileName}
                            className="h-full w-full bg-muted object-cover transition-transform duration-300 group-hover:scale-105"
                          />
                          {on ? (
                            <span className="absolute right-2 top-2 rounded-full bg-accent px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-ink">
                              选中
                            </span>
                          ) : null}
                        </div>
                        <span className="truncate font-mono text-[11px] text-muted-foreground">
                          {a.fileName}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </Panel>

          {/* VI-manual parsing — reuses the recognition machinery: pick a
              VI_DOC asset, parse it into DRAFT rules in the SAME list below. */}
          <Panel className="flex flex-col gap-6">
            <SectionHeading
              eyebrow="PARSE · 解析 VI 手册"
              title="解析 VI 手册"
              action={
                <Button
                  disabled={
                    !manualAssetId || parseManual.isPending || parsing
                  }
                  onClick={() => parseManual.mutate()}
                >
                  {parseManual.isPending || parsing ? <Spinner /> : null}
                  解析手册
                </Button>
              }
            />

            {parsing ? (
              <div className="rounded-2xl border border-foreground/10 bg-muted px-5 py-4 text-sm text-muted-foreground">
                解析中… {manualJob?.status ?? "PENDING"} ·{" "}
                {manualJob?.progress ?? 0}%
              </div>
            ) : null}
            {manualJob?.status === "FAILED" ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-destructive/30 bg-destructive/10 px-5 py-4 text-sm text-destructive">
                <span>解析失败：{manualJob.failedReason ?? "未知错误"}</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={parseManual.isPending || !manualAssetId}
                  onClick={() => {
                    setManualJobId(null);
                    syncTaskUrl(null);
                    parseManual.mutate();
                  }}
                >
                  重试
                </Button>
              </div>
            ) : null}

            {viDocs.length === 0 ? (
              <div className="flex flex-col items-start gap-3 rounded-2xl border border-dashed border-foreground/15 bg-muted/40 px-6 py-8">
                <p className="text-sm text-muted-foreground">
                  暂无 VI 手册，先在资产库上传一份「VI 手册」(PDF) 即可解析。
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <FieldLabel>选择 VI 手册</FieldLabel>
                <select
                  value={manualAssetId}
                  onChange={(e) => setManualAssetId(e.target.value)}
                  className="w-full rounded-2xl border border-foreground/15 bg-card px-4 py-2.5 font-mono text-sm text-foreground/80 focus:border-primary focus:outline-none"
                >
                  <option value="">— 选择一份手册 —</option>
                  {viDocs.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.fileName}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  解析后会得到带证据的规则草案，落入下方同一确认 / 修改 / 拒绝列表。
                </p>
              </div>
            )}
          </Panel>

          {RULE_TYPE_ORDER.filter((t) => grouped.has(t)).map((t) => (
            <section key={t} className="flex flex-col gap-5">
              <SectionHeading
                eyebrow={`${t.toUpperCase()} · ${grouped.get(t)!.length} 条`}
                title={RULE_TYPE_LABELS[t] ?? t}
              />
              <div className="flex flex-col gap-5">
                {grouped.get(t)!.map((r) => (
                  <RuleCard
                    key={r.id}
                    wsId={wsId}
                    rule={r}
                    assets={initialAssets}
                  />
                ))}
              </div>
            </section>
          ))}

          {rules.length === 0 ? (
            <div className="flex flex-col items-center gap-5 rounded-3xl border border-dashed border-foreground/15 bg-card/50 px-6 py-16 text-center">
              <p className="font-serif text-xl text-foreground/80">
                还没有风格规则
              </p>
              <p className="max-w-sm text-sm text-muted-foreground">
                选择素材发起识别后，AI 会给出带证据的规则草案 —— 每条都看证据，再决定确认 / 修改 / 拒绝。
              </p>
            </div>
          ) : null}
        </>
      ) : tab === "colors" ? (
        <ColorSystemReport colorSystem={colorSystem} />
      ) : (
        <RuleVersionsPanel wsId={wsId} confirmedCount={confirmedCount} />
      )}
    </div>
  );
}

function RuleVersionsPanel({
  wsId,
  confirmedCount,
}: {
  wsId: string;
  confirmedCount: number;
}) {
  const qc = useQueryClient();
  const [label, setLabel] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const { data: snapshots = [], isLoading } = useQuery({
    queryKey: ["rule-snapshots", wsId],
    queryFn: () =>
      apiFetch<{ snapshots: RuleSnapshotSummary[] }>(
        `/api/workspaces/${wsId}/rules/snapshots`,
      ).then((r) => r.snapshots),
  });

  const save = useMutation({
    mutationFn: () =>
      apiFetch<RuleSnapshotSummary>(`/api/workspaces/${wsId}/rules/snapshots`, {
        method: "POST",
        body: JSON.stringify({ label: label.trim(), note: note.trim() || undefined }),
      }),
    onSuccess: (s) => {
      setLabel("");
      setNote("");
      setMsg({ ok: true, text: `已保存版本「${s.label}」(${s.ruleCount} 条确认规则)` });
      qc.invalidateQueries({ queryKey: ["rule-snapshots", wsId] });
    },
    onError: (e) =>
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }),
  });

  const restore = useMutation({
    mutationFn: (id: string) =>
      apiFetch<RestoreRuleSnapshotResult>(
        `/api/workspaces/${wsId}/rules/snapshots/${id}/restore`,
        { method: "POST" },
      ),
    onSuccess: (r) => {
      setMsg({
        ok: true,
        text: `已回滚:恢复 ${r.restored} 条、退役 ${r.retired} 条(回滚前已自动备份)`,
      });
      // The library changed — refresh the rules list AND the snapshot list
      // (the auto-backup adds a new row).
      qc.invalidateQueries({ queryKey: ["rules", wsId] });
      qc.invalidateQueries({ queryKey: ["rule-snapshots", wsId] });
    },
    onError: (e) =>
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }),
  });

  function onRestore(s: RuleSnapshotSummary) {
    const ok = window.confirm(
      `回滚到版本「${s.label}」?\n\n当前确认规则会被该版本覆盖(不在版本内的规则将退役为拒绝)。回滚前会自动备份当前状态,可再次回滚找回。`,
    );
    if (ok) restore.mutate(s.id);
  }

  function fmt(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 16).replace("T", " ");
  }

  const busy = restore.isPending;

  return (
    <div className="flex flex-col gap-8">
      <Panel className="flex flex-col gap-5">
        <SectionHeading
          eyebrow="SNAPSHOT · 保存当前版本"
          title="保存规则版本"
        />
        <p className="text-sm text-muted-foreground">
          为当前 <span className="font-mono">{confirmedCount}</span> 条已确认规则打一个版本快照,日后可一键回滚到此刻状态。
        </p>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <FieldLabel>版本名称</FieldLabel>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="例如:春节大促规则 v1"
              maxLength={120}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <FieldLabel>备注(可选)</FieldLabel>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="这一版改了什么 / 为什么存"
              maxLength={500}
            />
          </div>
          <div>
            <Button
              disabled={!label.trim() || save.isPending}
              onClick={() => {
                setMsg(null);
                save.mutate();
              }}
            >
              {save.isPending ? <Spinner /> : null}
              保存为新版本
            </Button>
          </div>
        </div>
        {msg ? (
          <div
            className={`rounded-2xl border px-5 py-3 text-sm ${
              msg.ok
                ? "border-success/30 bg-success/10 text-success"
                : "border-destructive/30 bg-destructive/10 text-destructive"
            }`}
          >
            {msg.text}
          </div>
        ) : null}
      </Panel>

      <section className="flex flex-col gap-5">
        <SectionHeading
          eyebrow={`HISTORY · ${snapshots.length} 个版本`}
          title="版本历史"
        />
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> 加载中…
          </div>
        ) : snapshots.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-3xl border border-dashed border-foreground/15 bg-card/50 px-6 py-14 text-center">
            <p className="font-serif text-xl text-foreground/80">还没有版本</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              确认好一组规则后,在上方保存一个版本,日后改乱了可一键回滚。
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {snapshots.map((s) => (
              <article
                key={s.id}
                className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-foreground/10 bg-card p-5 shadow-sm"
              >
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="font-serif text-lg text-foreground">
                      {s.label}
                    </span>
                    <Badge tone="neutral">{s.ruleCount} 条规则</Badge>
                  </div>
                  {s.note ? (
                    <span className="text-sm text-muted-foreground">{s.note}</span>
                  ) : null}
                  <span className="font-mono text-xs text-muted-foreground">
                    {fmt(s.createdAt)}
                  </span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => onRestore(s)}
                >
                  {busy ? <Spinner /> : null}
                  回滚到此版本
                </Button>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function RuleCard({
  wsId,
  rule,
  assets,
}: {
  wsId: string;
  rule: BrandRule & { structured?: Record<string, unknown> | null };
  assets: Asset[];
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [summary, setSummary] = useState(rule.summary);
  const [showFields, setShowFields] = useState(false);

  const update = useMutation({
    mutationFn: (body: {
      status?: BrandRule["status"];
      strength?: RuleStrength;
      summary?: string;
    }) =>
      apiFetch<BrandRule>(
        `/api/workspaces/${wsId}/rules/${rule.id}`,
        { method: "PATCH", body: JSON.stringify(body) },
      ),
    onSuccess: () => {
      setEditing(false);
      qc.invalidateQueries({ queryKey: ["rules", wsId] });
    },
  });

  const assetById = useMemo(
    () => new Map(assets.map((a) => [a.id, a])),
    [assets],
  );

  // Map rule strength/status onto the AIInsightPanel tone vocabulary.
  const insightTone: "pass" | "risk" | "danger" | "neutral" =
    rule.status === "REJECTED" || rule.strength === "FORBIDDEN"
      ? "danger"
      : rule.strength === "STRONG"
        ? "pass"
        : "neutral";

  // Evidence notes become the panel's textual evidence list (the imagery is
  // rendered separately below as large thumbnails — the panel API is text-only).
  const evidenceNotes = rule.evidence
    .map((ev) => {
      const asset = assetById.get(ev.assetId);
      const label = asset?.fileName ?? ev.assetId;
      return ev.note ? `${label} — ${ev.note}` : label;
    })
    .filter(Boolean);

  const strengthLabel =
    STRENGTHS.find((s) => s.value === rule.strength)?.label ?? rule.strength;

  return (
    // P3.2 polish — bg-background instead of bg-card so the card pops one
    // layer above the warm-sand Panel it sits inside. hover:shadow-md gives
    // a subtle cue without violating §9.3 "克制阴影".
    <article className="group flex flex-col gap-5 rounded-3xl border border-foreground/10 bg-background p-6 shadow-[0_1px_0_0_rgb(0_0_0/0.04)] transition-shadow hover:shadow-md md:p-7">
      {/* Rule type / strength / status tags */}
      <div className="flex flex-wrap items-center gap-2">
        <StyleTag>{RULE_TYPE_LABELS[rule.type] ?? rule.type}</StyleTag>
        <Badge tone={strengthTone(rule.strength)}>{strengthLabel}</Badge>
        <Badge tone={statusTone(rule.status)}>{rule.status}</Badge>
      </div>

      {/* AI conclusion + textual evidence rendered as an insight panel */}
      {editing ? (
        <div className="flex flex-col gap-2">
          <FieldLabel>规则描述</FieldLabel>
          <Textarea
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
          />
        </div>
      ) : (
        <AIInsightPanel
          conclusion={rule.summary}
          tone={insightTone}
          evidence={evidenceNotes.length > 0 ? evidenceNotes : undefined}
          // Slightly recessed well inside the now-bg-background RuleCard.
          // Layer rhythm: Panel(card/warm-sand) → RuleCard(background/off-white) → AIInsightPanel(card/warm-sand).
          className="border-foreground/10 bg-card"
        />
      )}

      {/* Large evidence imagery — every rule is backed by visible evidence */}
      {rule.evidence.length > 0 ? (
        <section>
          <FieldLabel className="mb-3">证据 · 每条都看证据</FieldLabel>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {rule.evidence.map((ev, i) => {
              const asset = assetById.get(ev.assetId);
              const thumb =
                ev.thumbnailUrl ??
                (asset ? assetThumbUrl(wsId, asset.id, asset.url) : undefined);
              return (
                <figure
                  key={i}
                  className="flex flex-col gap-2 overflow-hidden rounded-2xl border border-foreground/10 bg-muted/40 p-3"
                >
                  {thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={thumb}
                      alt={asset?.fileName ?? ev.assetId}
                      className="aspect-video w-full rounded-xl border border-foreground/10 object-cover"
                    />
                  ) : (
                    <div className="aspect-video w-full rounded-xl bg-muted" />
                  )}
                  <figcaption className="flex flex-col gap-0.5">
                    <span className="truncate font-mono text-[11px] text-foreground/70">
                      {asset?.fileName ?? ev.assetId}
                    </span>
                    {ev.note ? (
                      <span className="text-xs text-muted-foreground">
                        {ev.note}
                      </span>
                    ) : null}
                  </figcaption>
                </figure>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* Actions — confirm / edit / reject / strength controls preserved */}
      <div className="flex flex-wrap items-center gap-2 border-t border-foreground/10 pt-5">
        {editing ? (
          <>
            <Button
              size="sm"
              disabled={update.isPending}
              onClick={() => update.mutate({ summary })}
            >
              {update.isPending ? <Spinner /> : null}
              保存修改
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setEditing(false);
                setSummary(rule.summary);
              }}
            >
              取消
            </Button>
          </>
        ) : (
          <>
            <Button
              size="sm"
              disabled={
                update.isPending || rule.status === "CONFIRMED"
              }
              onClick={() => update.mutate({ status: "CONFIRMED" })}
            >
              确认
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setEditing(true)}
            >
              修改
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowFields((s) => !s)}
            >
              {showFields ? "收起结构化字段" : "展开结构化字段"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={
                update.isPending || rule.status === "REJECTED"
              }
              onClick={() => update.mutate({ status: "REJECTED" })}
            >
              拒绝
            </Button>
            <span className="ml-1 flex flex-wrap items-center gap-1.5">
              <FieldLabel className="mr-1">强弱</FieldLabel>
              {STRENGTHS.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  disabled={
                    update.isPending || rule.strength === s.value
                  }
                  onClick={() =>
                    update.mutate({ strength: s.value })
                  }
                  className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                    rule.strength === s.value
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-foreground/15 text-foreground/70 hover:bg-muted"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </span>
          </>
        )}
      </div>

      {showFields ? (
        <div className="rounded-2xl border border-foreground/10 bg-muted/40 p-5">
          <VIModuleForm wsId={wsId} rule={rule} />
        </div>
      ) : null}
    </article>
  );
}

function ColorSystemReport({
  colorSystem,
}: {
  colorSystem: ColorSystem | null;
}) {
  if (!colorSystem) {
    return (
      <div className="flex flex-col items-center gap-5 rounded-3xl border border-dashed border-foreground/15 bg-card/50 px-6 py-16 text-center">
        <p className="font-serif text-xl text-foreground/80">
          还没有 Color System 报告
        </p>
        <p className="max-w-sm text-sm text-muted-foreground">
          发起一次包含色彩素材的识别，AI 会给出对比度 / 一致性评分、推荐色板与禁用色。
        </p>
      </div>
    );
  }

  return (
    <Panel className="flex flex-col gap-8">
      <SectionHeading
        eyebrow="COLOR SYSTEM · 色彩体系报告"
        title="色彩体系"
      />

      {/* Scores — large editorial score cards */}
      <div className="grid gap-4 sm:grid-cols-2">
        <ConsistencyScoreCard
          label="对比度 · CONTRAST"
          score={colorSystem.contrastScore}
          hint="可读性 / WCAG 友好度"
        />
        <ConsistencyScoreCard
          label="品牌一致性 · CONSISTENCY"
          score={colorSystem.consistencyScore}
          hint="素材间色彩统一程度"
        />
      </div>

      {/* Recommended palette — ColorSwatch row */}
      <section className="flex flex-col gap-4">
        <FieldLabel>推荐色板 · PALETTE</FieldLabel>
        <div className="flex flex-wrap gap-5">
          {colorSystem.palette.map((c) => (
            <ColorSwatch key={c} hex={c} />
          ))}
        </div>
      </section>

      {colorSystem.pairing.length > 0 ? (
        <section className="flex flex-col gap-4 border-t border-foreground/10 pt-6">
          <FieldLabel>推荐配色 · PAIRING</FieldLabel>
          <div className="flex flex-wrap gap-3">
            {colorSystem.pairing.map(([a, b], i) => (
              <div
                key={i}
                className="flex overflow-hidden rounded-2xl border border-foreground/10 shadow-sm"
              >
                <div className="h-14 w-24" style={{ backgroundColor: a }} />
                <div className="h-14 w-24" style={{ backgroundColor: b }} />
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {colorSystem.restrictions.length > 0 ? (
        <section className="flex flex-col gap-3 border-t border-foreground/10 pt-6">
          <FieldLabel>禁用色 · RESTRICTIONS</FieldLabel>
          <ul className="flex flex-col gap-2">
            {colorSystem.restrictions.map((r, i) => (
              <li
                key={i}
                className="flex items-center gap-2.5 text-sm text-muted-foreground"
              >
                <Badge tone="danger">禁用</Badge>
                {r}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </Panel>
  );
}
