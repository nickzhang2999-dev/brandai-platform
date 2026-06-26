"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BrandRule, Project, TaskState } from "@brandai/contracts";
import { Button } from "@brandai/ui";
import { apiFetch } from "@/lib/client";
import { useBrand } from "../brand-context";
import {
  Chip,
  gradientFor,
  PageHeader,
  ProgressBar,
  StatusBadge,
} from "../_ui";

/**
 * P02 · Campaign 项目 — 左侧项目卡列表 + 右侧 AI 摘要面板。真实数据：
 * GET/POST /api/workspaces/[wsId]/projects（Project ↔ Campaign 映射）。
 */
type Status = "DRAFT" | "IN_PROGRESS" | "COMPLETED";
const FILTERS: { key: string; label: string; status?: Status }[] = [
  { key: "all", label: "全部状态" },
  { key: "ip", label: "进行中", status: "IN_PROGRESS" },
  { key: "draft", label: "草稿", status: "DRAFT" },
  { key: "done", label: "已完成", status: "COMPLETED" },
];

type SortKey = "recent" | "name" | "progress";
const SORTS: { key: SortKey; label: string }[] = [
  { key: "recent", label: "最近创建" },
  { key: "name", label: "名称 A-Z" },
  { key: "progress", label: "进度" },
];

type RangeKey = "all" | "7" | "30" | "90";
const RANGES: { key: RangeKey; label: string; days?: number }[] = [
  { key: "all", label: "全部时间" },
  { key: "7", label: "近 7 天", days: 7 },
  { key: "30", label: "近 30 天", days: 30 },
  { key: "90", label: "近 90 天", days: 90 },
];

export default function CampaignsPage() {
  const { wsId, brandName } = useBrand();
  const qc = useQueryClient();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [filterKey, setFilterKey] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("recent");
  const [rangeKey, setRangeKey] = useState<RangeKey>("all");
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  // Lifecycle action target: which transition the confirm dialog is for.
  const [confirmAction, setConfirmAction] = useState<LifecycleAction | null>(
    null,
  );
  const [editingSummary, setEditingSummary] = useState(false);
  // H4 · 查看项目规范侧边面板 — read-only brand knowledge (confirmed rules).
  const [viewingRules, setViewingRules] = useState(false);
  // Snapshot the project a dialog targets, captured at open time, resolved from
  // the FULL projects list (not the filter-derived `active`). Otherwise changing
  // a filter while a dialog is open could re-target the confirm/summary action
  // to a different visible project.
  const [dialogProjectId, setDialogProjectId] = useState<string | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["brandai-projects-all"] });
    qc.invalidateQueries({ queryKey: ["brandai-projects", wsId] });
  };

  const { data: projects = [], isLoading } = useQuery({
    queryKey: ["brandai-projects", wsId],
    queryFn: () => apiFetch<Project[]>(`/api/workspaces/${wsId}/projects`),
  });

  const filtered = useMemo(() => {
    const f = FILTERS.find((x) => x.key === filterKey);
    const range = RANGES.find((x) => x.key === rangeKey);
    const cutoff =
      range?.days != null ? Date.now() - range.days * 86_400_000 : null;
    const needle = q.trim().toLowerCase();

    const list = projects.filter((p) => {
      if (f?.status && (p.status ?? "DRAFT") !== f.status) return false;
      if (needle) {
        const inName = p.name.toLowerCase().includes(needle);
        const inBrand = brandName.toLowerCase().includes(needle);
        if (!inName && !inBrand) return false;
      }
      if (cutoff != null) {
        const t = Date.parse(p.createdAt);
        if (Number.isNaN(t) || t < cutoff) return false;
      }
      return true;
    });

    const sorted = [...list];
    sorted.sort((a, b) => {
      switch (sortKey) {
        case "name":
          return a.name.localeCompare(b.name, "zh-Hans-CN");
        case "progress":
          return (b.progress ?? 0) - (a.progress ?? 0);
        case "recent":
        default:
          return (
            (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0)
          );
      }
    });
    return sorted;
  }, [projects, filterKey, q, sortKey, rangeKey, brandName]);

  // Only ever select from the FILTERED set — falling back to projects[0] when
  // filters match nothing would make the summary panel + lifecycle actions
  // (补充需求 / 提交终审 / 归档) operate on a project that isn't shown.
  const active = filtered.find((p) => p.id === activeId) ?? filtered[0] ?? null;
  // Dialog target is the snapshotted id resolved against ALL projects, so it is
  // stable regardless of list filtering while the dialog is open.
  const dialogProject = projects.find((p) => p.id === dialogProjectId) ?? null;

  return (
    <div className="mx-auto max-w-[1180px] px-10 py-10">
      <PageHeader
        title="Campaign 项目"
        subtitle={`集中管理「${brandName}」品牌下的营销项目`}
        action={
          <Button size="lg" onClick={() => setCreating(true)}>
            ＋ 创建新 Campaign
          </Button>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索项目 / 品牌名称…"
          className="h-10 flex-1 rounded-full border border-border bg-card px-4 text-sm outline-none focus:border-primary/40 focus:shadow-[0_0_0_4px_rgba(124,92,255,0.08)]"
        />
        <select
          value={filterKey}
          onChange={(e) => setFilterKey(e.target.value)}
          aria-label="项目状态"
          className="h-9 rounded-full border border-border bg-card px-4 text-sm text-muted-foreground outline-none transition-colors hover:bg-muted focus:border-primary/40 focus:shadow-[0_0_0_4px_rgba(124,92,255,0.08)]"
        >
          {FILTERS.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </select>
        <select
          value={rangeKey}
          onChange={(e) => setRangeKey(e.target.value as RangeKey)}
          aria-label="时间范围"
          className="h-9 rounded-full border border-border bg-card px-4 text-sm text-muted-foreground outline-none transition-colors hover:bg-muted focus:border-primary/40 focus:shadow-[0_0_0_4px_rgba(124,92,255,0.08)]"
        >
          {RANGES.map((r) => (
            <option key={r.key} value={r.key}>
              {r.label}
            </option>
          ))}
        </select>
        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
          aria-label="排序方式"
          className="h-9 rounded-full border border-border bg-card px-4 text-sm text-muted-foreground outline-none transition-colors hover:bg-muted focus:border-primary/40 focus:shadow-[0_0_0_4px_rgba(124,92,255,0.08)]"
        >
          {SORTS.map((s) => (
            <option key={s.key} value={s.key}>
              {`排序：${s.label}`}
            </option>
          ))}
        </select>
      </div>

      {isLoading ? (
        <div className="rounded-3xl border border-border bg-card p-16 text-center text-sm text-muted-foreground">
          加载中…
        </div>
      ) : projects.length === 0 ? (
        <EmptyState onCreate={() => setCreating(true)} />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
          <div className="flex flex-col gap-[18px]">
            {filtered.map((c) => {
              const isActive = c.id === active?.id;
              const status = (c.status ?? "DRAFT") as Status;
              return (
                <button
                  key={c.id}
                  onClick={() => setActiveId(c.id)}
                  className={[
                    "grid grid-cols-[190px_1fr] gap-[18px] rounded-3xl border bg-card p-4 text-left transition-all",
                    isActive
                      ? "border-primary/40 shadow-[0_18px_50px_rgba(124,92,255,0.12)]"
                      : "border-border shadow-[0_8px_24px_rgba(30,30,60,0.06)] hover:border-primary/25",
                  ].join(" ")}
                >
                  <div
                    className="h-[150px] rounded-[20px]"
                    style={{ background: gradientFor(c.id) }}
                  />
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <StatusBadge status={status} />
                      {c.archivedAt ? <Chip>已归档</Chip> : null}
                      <span className="text-xs text-muted-foreground">
                        {brandName}
                      </span>
                    </div>
                    <div className="text-[17px] font-semibold">{c.name}</div>
                    <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                      {c.description || c.campaign || "暂无描述"}
                    </p>
                    {c.tags && c.tags.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {c.tags.map((t) => (
                          <Chip key={t}>{t}</Chip>
                        ))}
                      </div>
                    ) : null}
                    <ProgressBar value={c.progress ?? 0} />
                  </div>
                </button>
              );
            })}
            {filtered.length === 0 ? (
              <div className="rounded-3xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
                没有符合条件的项目
              </div>
            ) : null}
          </div>

          <aside className="sticky top-6 h-fit rounded-3xl border border-border bg-card p-6 shadow-[0_8px_24px_rgba(30,30,60,0.06)]">
            <div className="mb-1 flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-accent-soft text-sm text-primary">
                ✦
              </span>
              <span className="text-sm font-semibold">AI 项目摘要</span>
            </div>
            <div className="mt-3 text-[15px] font-semibold">
              {active?.name ?? "—"}
            </div>
            <p className="mt-2 rounded-2xl bg-accent-soft/60 p-4 text-xs leading-relaxed text-foreground/80">
              {active?.aiSummary ||
                "该项目尚无 AI 摘要。点击下方「AI 自动生成摘要」，或进入工作台出图、补充需求后，这里会沉淀项目进展与下一步建议。"}
            </p>
            {active ? (
              <AutoSummaryButton
                wsId={active.workspaceId}
                projectId={active.id}
                onDone={invalidate}
              />
            ) : null}
            {active ? (
              <div className="mt-2 text-[11px] text-muted-foreground">
                当前状态：
                <span className="font-medium text-foreground/80">
                  {active.archivedAt
                    ? "已归档"
                    : STATUS_LABEL[(active.status ?? "DRAFT") as Status]}
                </span>
              </div>
            ) : null}
            {active?.channels && active.channels.length > 0 ? (
              <div className="mt-4">
                <div className="mb-2 text-xs text-muted-foreground">
                  投放渠道
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {active.channels.map((ch) => (
                    <Chip key={ch}>{ch}</Chip>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="mt-5 flex flex-col gap-2">
              <a
                href={active ? `/workspace?project=${active.id}` : "/workspace"}
              >
                <Button variant="primary" className="w-full justify-center">
                  进入工作台出图
                </Button>
              </a>
              <Button
                variant="outline"
                className="w-full justify-center"
                disabled={!active}
                onClick={() => {
                  if (!active) return;
                  setDialogProjectId(active.id);
                  setEditingSummary(true);
                }}
              >
                补充需求
              </Button>
              <Button
                variant="outline"
                className="w-full justify-center"
                onClick={() => setViewingRules(true)}
              >
                查看规范
              </Button>
              <Button
                variant="outline"
                className="w-full justify-center"
                disabled={!active || (active.status ?? "DRAFT") !== "DRAFT"}
                onClick={() => {
                  if (!active) return;
                  setDialogProjectId(active.id);
                  setConfirmAction("submit");
                }}
              >
                提交终审
              </Button>
              <Button
                variant="outline"
                className="w-full justify-center"
                disabled={!active || (active.status ?? "DRAFT") === "COMPLETED"}
                onClick={() => {
                  if (!active) return;
                  setDialogProjectId(active.id);
                  setConfirmAction("archive");
                }}
              >
                归档项目
              </Button>
            </div>
          </aside>
        </div>
      )}

      {creating ? (
        <CreateDialog
          wsId={wsId}
          brandName={brandName}
          onClose={() => setCreating(false)}
          onCreated={(p) => {
            invalidate();
            setActiveId(p.id);
            setCreating(false);
          }}
        />
      ) : null}

      {dialogProject && confirmAction ? (
        <ConfirmActionDialog
          wsId={dialogProject.workspaceId}
          project={dialogProject}
          action={confirmAction}
          onClose={() => setConfirmAction(null)}
          onDone={() => {
            invalidate();
            setConfirmAction(null);
          }}
        />
      ) : null}

      {dialogProject && editingSummary ? (
        <SummaryDialog
          wsId={dialogProject.workspaceId}
          project={dialogProject}
          onClose={() => setEditingSummary(false)}
          onDone={() => {
            invalidate();
            setEditingSummary(false);
          }}
        />
      ) : null}

      {viewingRules ? (
        <RulesPanel
          wsId={active?.workspaceId ?? wsId}
          brandName={brandName}
          onClose={() => setViewingRules(false)}
        />
      ) : null}
    </div>
  );
}

const POLL_INTERVAL_MS = 2500;
const POLL_CAP_MS = 6 * 60 * 1000; // §2.2 有界中间态
type StartResponse = { jobId: string; taskId: string; status: string };

/**
 * C8 · Campaign AI 摘要自动生成 — server-authoritative summarize (§2). POST →
 * 202 {taskId} → poll GET /tasks/[taskId] (bounded to 6 min) → on SUCCEEDED the
 * worker has already written Project.aiSummary, so refetch the projects list.
 */
function AutoSummaryButton({
  wsId,
  projectId,
  onDone,
}: {
  wsId: string;
  projectId: string;
  onDone: () => void;
}) {
  const [taskId, setTaskId] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const startedAt = useRef(0);

  // Reset any in-flight poll when the targeted campaign changes.
  useEffect(() => {
    setTaskId(null);
    setTimedOut(false);
  }, [projectId]);

  const start = useMutation({
    mutationFn: () => {
      startedAt.current = Date.now();
      setTimedOut(false);
      return apiFetch<StartResponse>(
        `/api/workspaces/${wsId}/projects/${projectId}/summarize`,
        { method: "POST" },
      );
    },
    onSuccess: (res) => setTaskId(res.taskId),
  });

  const { data: task } = useQuery<TaskState>({
    queryKey: ["brandai-task", wsId, taskId],
    queryFn: () =>
      apiFetch<TaskState>(`/api/workspaces/${wsId}/tasks/${taskId}`),
    enabled: !!taskId,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      if (s === "SUCCEEDED" || s === "FAILED") return false;
      if (Date.now() - startedAt.current > POLL_CAP_MS) return false;
      return POLL_INTERVAL_MS;
    },
  });

  useEffect(() => {
    if (!taskId) return;
    const t = setInterval(() => {
      if (Date.now() - startedAt.current > POLL_CAP_MS) setTimedOut(true);
    }, 3000);
    return () => clearInterval(t);
  }, [taskId]);

  const status = task?.status ?? (taskId ? "PENDING" : null);
  const running =
    !!taskId && status !== "SUCCEEDED" && status !== "FAILED" && !timedOut;

  // Refetch the project once on success so the freshly-written aiSummary shows.
  const firedForRef = useRef<string | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => {
    if (status === "SUCCEEDED" && taskId && firedForRef.current !== taskId) {
      firedForRef.current = taskId;
      onDoneRef.current();
    }
  }, [status, taskId]);

  // §2.4 — a SUCCEEDED that lands right around the 6-min cap must not be hidden
  // by the timedOut flag (the cap-interval can flip it on the same tick the poll
  // observes success), so let an observed success win over the timeout copy.
  const failed = status === "FAILED" || (timedOut && status !== "SUCCEEDED");

  return (
    <div className="mt-2">
      <Button
        variant="outline"
        className="w-full justify-center"
        disabled={running || start.isPending}
        onClick={() => {
          if (running || start.isPending) return;
          start.mutate();
        }}
      >
        {running
          ? status === "RUNNING"
            ? "AI 生成摘要中…"
            : "正在受理…"
          : "✦ AI 自动生成摘要"}
      </Button>
      {running ? (
        <p className="mt-1.5 text-[11px] text-primary">
          AI 正在根据项目信息与品牌规则生成摘要，可离开稍后查看…
        </p>
      ) : null}
      {start.isError ? (
        <p className="mt-1.5 text-[11px] text-destructive">
          {(start.error as Error).message}
        </p>
      ) : null}
      {failed && !start.isError ? (
        <p className="mt-1.5 text-[11px] text-destructive">
          摘要生成未完成（可能超时或失败），请重试。
        </p>
      ) : null}
    </div>
  );
}

// H4 · 查看项目规范 — 规则类型展示元信息（对齐知识库页 TYPE_META）。
const RULE_TYPE_META: Record<string, { label: string; icon: string }> = {
  logo: { label: "Logo 使用规范", icon: "◐" },
  color: { label: "品牌色彩系统", icon: "◉" },
  font: { label: "字体规范", icon: "Aa" },
  copy: { label: "品牌语气 / 文案", icon: "❝" },
  imagery: { label: "视觉参考", icon: "▦" },
  layout: { label: "版式规范", icon: "▤" },
  graphic: { label: "设计元素", icon: "✦" },
};
const RULE_TYPE_ORDER = [
  "logo",
  "color",
  "font",
  "copy",
  "imagery",
  "layout",
  "graphic",
];
const STRENGTH_META: Record<string, { label: string; cls: string }> = {
  STRONG: { label: "强约束", cls: "bg-accent-soft text-primary" },
  WEAK: { label: "弱约束", cls: "bg-muted text-muted-foreground" },
  FORBIDDEN: { label: "禁用", cls: "bg-destructive/10 text-destructive" },
};

/**
 * H4 · 查看项目规范（侧边面板）— read-only view of the brand's CONFIRMED brand
 * knowledge, grouped by rule type. Reuses GET /api/workspaces/[wsId]/rules
 * (same endpoint the 知识库 page + generate worker consume); shows only
 * CONFIRMED rules (the ones that actually constrain出图). No editing here — the
 * 知识库 page owns rule authoring/confirmation.
 */
function RulesPanel({
  wsId,
  brandName,
  onClose,
}: {
  wsId: string;
  brandName: string;
  onClose: () => void;
}) {
  const { data: rules = [], isLoading } = useQuery({
    queryKey: ["brandai-rules", wsId],
    queryFn: () => apiFetch<BrandRule[]>(`/api/workspaces/${wsId}/rules`),
  });
  const confirmed = rules.filter((r) => r.status === "CONFIRMED");
  const groups = RULE_TYPE_ORDER.map((type) => ({
    type,
    meta: RULE_TYPE_META[type]!,
    items: confirmed.filter((r) => r.type === type),
  })).filter((g) => g.items.length > 0);

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-foreground/30 backdrop-blur-sm"
      onClick={onClose}
    >
      <aside
        className="flex h-full w-full max-w-md flex-col border-l border-border bg-card shadow-[-24px_0_70px_rgba(30,30,60,0.18)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-border p-6">
          <div>
            <div className="text-lg font-semibold">项目品牌规范</div>
            <p className="mt-1 text-sm text-muted-foreground">
              「{brandName}」已确认的品牌知识库规则，出图时受控生效。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {isLoading ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              加载中…
            </div>
          ) : groups.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border p-8 text-center">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-2xl text-primary">
                ◎
              </div>
              <div className="text-sm font-semibold">暂无已确认规范</div>
              <p className="mx-auto mt-2 max-w-xs text-xs leading-relaxed text-muted-foreground">
                去「品牌知识库」沉淀并确认 Logo / 色彩 / 字体 /
                调性等规则，确认后 会在这里展示并约束出图。
              </p>
              <a href="/brand-knowledge">
                <Button variant="outline" className="mt-4">
                  前往品牌知识库
                </Button>
              </a>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {groups.map((g) => (
                <div
                  key={g.type}
                  className="rounded-2xl border border-border bg-background p-4"
                >
                  <div className="mb-3 flex items-center gap-2">
                    <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-accent-soft text-sm text-primary">
                      {g.meta.icon}
                    </span>
                    <span className="text-sm font-semibold">
                      {g.meta.label}
                    </span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {g.items.length} 条
                    </span>
                  </div>
                  <ul className="flex flex-col gap-2.5">
                    {g.items.map((r) => {
                      const s =
                        STRENGTH_META[r.strength] ?? STRENGTH_META.WEAK!;
                      return (
                        <li
                          key={r.id}
                          className="flex items-start gap-2 text-sm leading-relaxed"
                        >
                          <span
                            className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${s.cls}`}
                          >
                            {s.label}
                          </span>
                          <span className="text-foreground/90">
                            {r.summary}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-border p-4">
          <a href="/brand-knowledge">
            <Button variant="outline" className="w-full justify-center">
              管理品牌知识库
            </Button>
          </a>
        </div>
      </aside>
    </div>
  );
}

type LifecycleAction = "submit" | "archive";

const STATUS_LABEL: Record<Status, string> = {
  DRAFT: "草稿",
  IN_PROGRESS: "进行中",
  COMPLETED: "已完成",
};

// Honest mapping onto the real CampaignStatus enum (DRAFT/IN_PROGRESS/COMPLETED):
// there is no dedicated REVIEW status, so 「提交终审」moves to IN_PROGRESS
// (closest "under review / in progress" state) and 「归档项目」to COMPLETED.
const ACTION_META: Record<
  LifecycleAction,
  { title: string; body: string; cta: string; nextStatus: Status }
> = {
  submit: {
    title: "提交终审",
    body: "提交后项目将进入「进行中」状态，进入评审与出图阶段。可继续在工作台出图。",
    cta: "确认提交",
    nextStatus: "IN_PROGRESS",
  },
  archive: {
    title: "归档项目",
    body: "归档后项目将标记为「已完成」，从进行中的工作中收起。你仍可随时查看其历史产出。",
    cta: "确认归档",
    nextStatus: "COMPLETED",
  },
};

function ConfirmActionDialog({
  wsId,
  project,
  action,
  onClose,
  onDone,
}: {
  wsId: string;
  project: Project;
  action: LifecycleAction;
  onClose: () => void;
  onDone: () => void;
}) {
  const meta = ACTION_META[action];
  const mutation = useMutation({
    mutationFn: () =>
      apiFetch<Project>(`/api/workspaces/${wsId}/projects/${project.id}`, {
        method: "PATCH",
        // P02 归档 — archive 落 archivedAt（区别于普通「已完成」），提交终审仍走 status。
        body: JSON.stringify(
          action === "archive"
            ? { archive: true }
            : { status: meta.nextStatus },
        ),
      }),
    onSuccess: onDone,
  });

  return (
    <ModalShell onClose={onClose}>
      <div className="text-lg font-semibold">{meta.title}</div>
      <p className="mt-1 text-sm text-muted-foreground">「{project.name}」</p>
      <p className="mt-4 rounded-2xl bg-accent-soft/60 p-4 text-sm leading-relaxed text-foreground/80">
        {meta.body}
      </p>
      {mutation.isError ? (
        <p className="mt-3 text-sm text-destructive">
          {(mutation.error as Error).message}
        </p>
      ) : null}
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          取消
        </Button>
        <Button disabled={mutation.isPending} onClick={() => mutation.mutate()}>
          {mutation.isPending ? "处理中…" : meta.cta}
        </Button>
      </div>
    </ModalShell>
  );
}

function SummaryDialog({
  wsId,
  project,
  onClose,
  onDone,
}: {
  wsId: string;
  project: Project;
  onClose: () => void;
  onDone: () => void;
}) {
  const [summary, setSummary] = useState(project.aiSummary ?? "");
  const mutation = useMutation({
    mutationFn: () =>
      apiFetch<Project>(`/api/workspaces/${wsId}/projects/${project.id}`, {
        method: "PATCH",
        body: JSON.stringify({ aiSummary: summary.trim() }),
      }),
    onSuccess: onDone,
  });

  return (
    <ModalShell onClose={onClose}>
      <div className="text-lg font-semibold">补充需求 / 项目摘要</div>
      <p className="mt-1 text-sm text-muted-foreground">
        补充这个 Campaign 的目标、进展与下一步，沉淀为 AI 项目摘要。
      </p>
      <div className="mt-5">
        <Field label="项目摘要">
          <textarea
            autoFocus
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            rows={6}
            placeholder="如：本期主打夏季新品，已完成 KV 主视觉初稿，下一步补充电商详情页…"
            className="w-full resize-none rounded-2xl border border-border bg-background p-3 text-sm outline-none focus:border-primary/40 focus:shadow-[0_0_0_4px_rgba(124,92,255,0.08)]"
          />
        </Field>
      </div>
      {mutation.isError ? (
        <p className="mt-3 text-sm text-destructive">
          {(mutation.error as Error).message}
        </p>
      ) : null}
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          取消
        </Button>
        <Button disabled={mutation.isPending} onClick={() => mutation.mutate()}>
          {mutation.isPending ? "保存中…" : "保存"}
        </Button>
      </div>
    </ModalShell>
  );
}

/** 共享浮层外壳（与 CreateDialog 同款圆角/阴影/遮罩）。 */
function ModalShell({
  onClose,
  children,
}: {
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-3xl border border-border bg-card p-6 shadow-[0_24px_70px_rgba(30,30,60,0.18)]"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="rounded-3xl border border-dashed border-border bg-card p-16 text-center">
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-2xl text-primary">
        ◳
      </div>
      <div className="text-lg font-semibold">还没有 Campaign</div>
      <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
        创建你的第一个营销项目，围绕它管理需求、出图与交付。
      </p>
      <Button size="lg" className="mt-6" onClick={onCreate}>
        ＋ 创建新 Campaign
      </Button>
    </div>
  );
}

function CreateDialog({
  wsId,
  brandName,
  onClose,
  onCreated,
}: {
  wsId: string;
  brandName: string;
  onClose: () => void;
  onCreated: (p: Project) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [channels, setChannels] = useState("");

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch<Project>(`/api/workspaces/${wsId}/projects`, {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          channels: channels
            .split(/[,，\s]+/)
            .map((s) => s.trim())
            .filter(Boolean),
          status: "DRAFT",
        }),
      }),
    onSuccess: onCreated,
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-3xl border border-border bg-card p-6 shadow-[0_24px_70px_rgba(30,30,60,0.18)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-lg font-semibold">创建新 Campaign</div>
        <p className="mt-1 text-sm text-muted-foreground">
          当前品牌：{brandName}。创建后项目、素材与出图记录都归属于该品牌。
        </p>
        <div className="mt-5 flex flex-col gap-4">
          <Field label="项目名称">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：夏季新品上市 Campaign"
              className="h-11 w-full rounded-2xl border border-border bg-background px-3 text-sm outline-none focus:border-primary/40 focus:shadow-[0_0_0_4px_rgba(124,92,255,0.08)]"
            />
          </Field>
          <Field label="项目简介">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="一句话描述这个 Campaign 的目标与方向"
              className="w-full resize-none rounded-2xl border border-border bg-background p-3 text-sm outline-none focus:border-primary/40 focus:shadow-[0_0_0_4px_rgba(124,92,255,0.08)]"
            />
          </Field>
          <Field label="投放渠道（逗号分隔，可选）">
            <input
              value={channels}
              onChange={(e) => setChannels(e.target.value)}
              placeholder="小红书, 抖音, 天猫"
              className="h-11 w-full rounded-2xl border border-border bg-background px-3 text-sm outline-none focus:border-primary/40 focus:shadow-[0_0_0_4px_rgba(124,92,255,0.08)]"
            />
          </Field>
        </div>
        {mutation.isError ? (
          <p className="mt-3 text-sm text-destructive">
            {(mutation.error as Error).message}
          </p>
        ) : null}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={!name.trim() || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? "创建中…" : "创建"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
