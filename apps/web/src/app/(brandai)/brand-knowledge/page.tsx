"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BrandRule } from "@brandai/contracts";
import { apiFetch } from "@/lib/client";
import { useBrand } from "../brand-context";
import { Chip } from "../_ui";

/**
 * P03 · 品牌知识库 — 把品牌规则沉淀为 AI 可调用的结构化知识。真实数据：
 * GET/POST/PATCH /api/workspaces/[wsId]/rules。已确认(CONFIRMED)的规则会在
 * 工作台出图时被 worker 加载用于受控生成。
 */
const TYPE_META: Record<string, { label: string; icon: string }> = {
  logo: { label: "Logo 使用规范", icon: "◐" },
  color: { label: "品牌色彩系统", icon: "◉" },
  font: { label: "字体规范", icon: "Aa" },
  copy: { label: "品牌语气 / 文案", icon: "❝" },
  imagery: { label: "视觉参考", icon: "▦" },
  layout: { label: "版式规范", icon: "▤" },
  graphic: { label: "设计元素", icon: "✦" },
};
const TYPE_OPTIONS = Object.entries(TYPE_META).map(([value, m]) => ({
  value,
  label: m.label,
}));

export default function BrandKnowledgePage() {
  const { wsId, brandName } = useBrand();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [type, setType] = useState("copy");

  const { data: rules = [], isLoading } = useQuery({
    queryKey: ["brandai-rules", wsId],
    queryFn: () => apiFetch<BrandRule[]>(`/api/workspaces/${wsId}/rules`),
  });

  const add = useMutation({
    mutationFn: () =>
      apiFetch<BrandRule>(`/api/workspaces/${wsId}/rules`, {
        method: "POST",
        body: JSON.stringify({ type, summary: text.trim(), value: {} }),
      }),
    onSuccess: () => {
      setText("");
      qc.invalidateQueries({ queryKey: ["brandai-rules", wsId] });
    },
  });

  const confirm = useMutation({
    mutationFn: (id: string) =>
      apiFetch<BrandRule>(`/api/workspaces/${wsId}/rules/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "CONFIRMED" }),
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["brandai-rules", wsId] }),
  });

  const confirmedCount = rules.filter((r) => r.status === "CONFIRMED").length;

  return (
    <div className="mx-auto max-w-[1180px] px-10 py-10">
      <section className="text-center">
        <h1 className="text-[34px] font-semibold tracking-tight">
          AI 助手 · 共创你的品牌知识库
        </h1>
        <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">
          沉淀「{brandName}」的品牌规范，确认后的规则会在每次出图时被自动应用。
        </p>
        <div className="mx-auto mt-6 flex max-w-2xl flex-col gap-3 rounded-[28px] border border-primary/15 bg-card p-4 shadow-[0_24px_70px_rgba(124,92,255,0.12)]">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            placeholder="输入一条品牌规则，如：主色为紫色 #7C5CFF，禁止改色或描边…"
            className="min-h-[52px] w-full resize-none border-0 bg-transparent px-2 py-1 text-sm outline-none placeholder:text-muted-foreground"
          />
          <div className="flex items-center justify-between gap-3">
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="h-10 rounded-2xl border border-border bg-background px-3 text-sm outline-none"
            >
              {TYPE_OPTIONS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            <button
              disabled={!text.trim() || add.isPending}
              onClick={() => add.mutate()}
              className="h-10 shrink-0 rounded-[16px] bg-gradient-to-br from-primary to-accent px-6 text-sm font-medium text-primary-foreground shadow-[0_12px_28px_rgba(124,92,255,0.26)] disabled:opacity-60"
            >
              {add.isPending ? "添加中…" : "添加规则"}
            </button>
          </div>
        </div>
        {add.isError ? (
          <p className="mt-2 text-sm text-destructive">
            {(add.error as Error).message}
          </p>
        ) : null}
      </section>

      <section className="mt-10 grid grid-cols-3 gap-3.5 lg:grid-cols-6">
        {Object.entries(TYPE_META).map(([key, m]) => (
          <a
            key={key}
            href="/assets"
            className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border bg-card p-4 text-center transition-colors hover:border-primary/40 hover:bg-accent-soft/40"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-accent-soft text-lg text-primary">
              {m.icon}
            </span>
            <span className="text-xs font-medium">{m.label.split(" ")[0]}</span>
            <span className="text-[10px] text-muted-foreground">上传资料</span>
          </a>
        ))}
      </section>

      <section className="mt-12">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-2xl font-semibold">品牌核心知识</h2>
          <span className="text-xs text-muted-foreground">
            共 {rules.length} 条 · 已确认 {confirmedCount} 条
          </span>
        </div>
        {isLoading ? (
          <div className="rounded-3xl border border-border bg-card p-12 text-center text-sm text-muted-foreground">
            加载中…
          </div>
        ) : rules.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-border bg-card p-12 text-center text-sm text-muted-foreground">
            还没有品牌规则。在上方输入第一条，AI 出图时即可遵循它。
          </div>
        ) : (
          <div className="grid gap-[18px] md:grid-cols-2 lg:grid-cols-3">
            {rules.map((r) => {
              const meta = TYPE_META[r.type] ?? { label: r.type, icon: "✦" };
              return (
                <div
                  key={r.id}
                  className="flex flex-col gap-3 rounded-3xl border border-border bg-card p-5 shadow-[0_8px_24px_rgba(30,30,60,0.06)]"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-3">
                      <span className="flex h-9 w-9 items-center justify-center rounded-2xl bg-accent-soft text-base text-primary">
                        {meta.icon}
                      </span>
                      <span className="text-[15px] font-semibold">
                        {meta.label}
                      </span>
                    </div>
                    {r.status === "CONFIRMED" ? (
                      <span className="rounded-full bg-success/10 px-2.5 py-0.5 text-[11px] font-medium text-success">
                        已确认
                      </span>
                    ) : (
                      <span className="rounded-full bg-warning/10 px-2.5 py-0.5 text-[11px] font-medium text-warning">
                        草稿
                      </span>
                    )}
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {r.summary}
                  </p>
                  {r.status !== "CONFIRMED" ? (
                    <button
                      disabled={confirm.isPending}
                      onClick={() => confirm.mutate(r.id)}
                      className="mt-auto self-start rounded-full border border-primary/30 px-3 py-1 text-xs text-primary transition-colors hover:bg-accent-soft disabled:opacity-60"
                    >
                      确认采用
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="mt-12 rounded-3xl border border-primary/15 bg-gradient-to-br from-accent-soft/70 to-card p-7 shadow-[0_8px_24px_rgba(30,30,60,0.06)]">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-card text-sm text-primary">
            ✦
          </span>
          <span className="text-sm font-semibold">AI 知识摘要 · {brandName}</span>
        </div>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-foreground/80">
          {rules.length === 0
            ? "尚未沉淀品牌规则。建议先确认色彩、字体、Logo 与品牌语气，AI 出图会据此受控生成。"
            : `已沉淀 ${rules.length} 条品牌规则（${confirmedCount} 条已确认并生效）。已确认规则会在工作台每次出图时由 worker 加载，确保结果遵循品牌规范。`}
        </p>
        {rules.length > 0 ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {Array.from(new Set(rules.map((r) => TYPE_META[r.type]?.label ?? r.type))).map(
              (k) => (
                <Chip key={k}>{k}</Chip>
              ),
            )}
          </div>
        ) : null}
      </section>
    </div>
  );
}
