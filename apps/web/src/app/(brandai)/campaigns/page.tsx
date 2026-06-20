"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project } from "@brandai/contracts";
import { Button } from "@brandai/ui";
import { apiFetch } from "@/lib/client";
import { useBrand } from "../brand-context";
import { Chip, gradientFor, PageHeader, ProgressBar, StatusBadge } from "../_ui";

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

export default function CampaignsPage() {
  const { wsId, brandName } = useBrand();
  const qc = useQueryClient();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [filterKey, setFilterKey] = useState("all");
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);

  const { data: projects = [], isLoading } = useQuery({
    queryKey: ["brandai-projects", wsId],
    queryFn: () => apiFetch<Project[]>(`/api/workspaces/${wsId}/projects`),
  });

  const filtered = useMemo(() => {
    const f = FILTERS.find((x) => x.key === filterKey);
    return projects.filter((p) => {
      if (f?.status && (p.status ?? "DRAFT") !== f.status) return false;
      if (q && !p.name.toLowerCase().includes(q.toLowerCase())) return false;
      return true;
    });
  }, [projects, filterKey, q]);

  const active =
    filtered.find((p) => p.id === activeId) ?? filtered[0] ?? projects[0];

  return (
    <div className="mx-auto max-w-[1180px] px-10 py-10">
      <PageHeader
        title="Campaign 项目"
        subtitle={`集中管理「${brandName}」的所有营销项目`}
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
          placeholder="搜索项目名称…"
          className="h-10 flex-1 rounded-full border border-border bg-card px-4 text-sm outline-none focus:border-primary/40 focus:shadow-[0_0_0_4px_rgba(124,92,255,0.08)]"
        />
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilterKey(f.key)}
            className={[
              "h-9 rounded-full px-4 text-sm transition-colors",
              filterKey === f.key
                ? "bg-accent-soft font-medium text-primary"
                : "border border-border bg-card text-muted-foreground hover:bg-muted",
            ].join(" ")}
          >
            {f.label}
          </button>
        ))}
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
                "该项目尚无 AI 摘要。进入工作台出图、补充需求后，这里会沉淀项目进展与下一步建议。"}
            </p>
            {active?.channels && active.channels.length > 0 ? (
              <div className="mt-4">
                <div className="mb-2 text-xs text-muted-foreground">投放渠道</div>
                <div className="flex flex-wrap gap-1.5">
                  {active.channels.map((ch) => (
                    <Chip key={ch}>{ch}</Chip>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="mt-5 flex flex-col gap-2">
              <a href={active ? `/workspace?project=${active.id}` : "/workspace"}>
                <Button variant="primary" className="w-full justify-center">
                  进入工作台出图
                </Button>
              </a>
            </div>
          </aside>
        </div>
      )}

      {creating ? (
        <CreateDialog
          wsId={wsId}
          onClose={() => setCreating(false)}
          onCreated={(p) => {
            qc.invalidateQueries({ queryKey: ["brandai-projects", wsId] });
            setActiveId(p.id);
            setCreating(false);
          }}
        />
      ) : null}
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
  onClose,
  onCreated,
}: {
  wsId: string;
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
          填写项目名称与简介，稍后可在工作台围绕它出图。
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
