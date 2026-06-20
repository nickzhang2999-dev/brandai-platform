"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { Project } from "@brandai/contracts";
import { apiFetch } from "@/lib/client";
import { quickActions } from "@/lib/brandai-mock";
import { useBrand } from "./brand-context";
import { gradientFor } from "./_ui";

/**
 * P01 · 首页 — AI 入口 + 近期项目速览。真实数据：当前品牌的 Campaign 列表。
 */
type Status = "DRAFT" | "IN_PROGRESS" | "COMPLETED";
const STATUS_META: Record<Status, { label: string; tone: string }> = {
  DRAFT: { label: "草稿", tone: "warning" },
  IN_PROGRESS: { label: "进行中", tone: "primary" },
  COMPLETED: { label: "已完成", tone: "success" },
};

export default function HomePage() {
  const { wsId, brandName, user } = useBrand();
  const router = useRouter();

  const { data: projects = [] } = useQuery({
    queryKey: ["brandai-projects", wsId],
    queryFn: () => apiFetch<Project[]>(`/api/workspaces/${wsId}/projects`),
  });

  // B2 · 首页 brief → 草稿 Campaign。注意：这不是 AI 拆解，只是把这段描述
  // 立项为草稿并把原文透传到工作台出图卖点（honest brief-threading）。
  const [brief, setBrief] = useState("");

  const startFromBrief = useMutation({
    mutationFn: (text: string) => {
      const title =
        text.split("\n")[0]!.trim().slice(0, 24) ||
        text.trim().slice(0, 24);
      return apiFetch<Project>(`/api/workspaces/${wsId}/projects`, {
        method: "POST",
        body: JSON.stringify({
          name: title,
          description: text.trim(),
          status: "DRAFT",
          channels: [],
        }),
      });
    },
    onSuccess: (project) => {
      router.push(
        `/workspace?project=${encodeURIComponent(project.id)}&brief=${encodeURIComponent(
          brief.trim(),
        )}`,
      );
    },
  });

  function handleStart() {
    if (startFromBrief.isPending) return;
    const text = brief.trim();
    if (!text) {
      router.push("/workspace");
      return;
    }
    startFromBrief.mutate(text);
  }

  return (
    <div className="mx-auto max-w-[1180px] px-10 py-10">
      <section className="pt-4 text-center">
        <h1 className="text-[44px] font-[650] leading-tight tracking-tight">
          你好，{user.name}
        </h1>
        <p className="mt-3 text-base text-muted-foreground">
          用一句话描述你的品牌广告需求，BrandAI 帮你拆解、立项并受控出图。
        </p>
      </section>

      <section className="mx-auto mt-8 max-w-3xl">
        <div className="flex items-end gap-3 rounded-[34px] border border-primary/15 bg-card p-3 pl-6 shadow-[0_24px_70px_rgba(124,92,255,0.12)]">
          <textarea
            rows={2}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                handleStart();
              }
            }}
            disabled={startFromBrief.isPending}
            placeholder={`例如：为 ${brandName} 做一组小红书种草主视觉，清透水光风格…`}
            className="min-h-[56px] flex-1 resize-none border-0 bg-transparent py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60"
          />
          <button
            type="button"
            onClick={handleStart}
            disabled={startFromBrief.isPending}
            className="h-11 shrink-0 rounded-[18px] bg-gradient-to-br from-primary to-accent px-6 text-sm font-medium text-primary-foreground shadow-[0_12px_28px_rgba(124,92,255,0.26)] transition-opacity disabled:opacity-70"
          >
            {startFromBrief.isPending
              ? "正在立项…"
              : brief.trim()
                ? "从这段描述开始创作"
                : "去出图"}
          </button>
        </div>
        <p className="mt-2 pl-6 text-xs text-muted-foreground">
          填写后将以这段描述新建草稿 Campaign，并把原文带入工作台作为出图卖点（不做 AI 自动拆解）。
        </p>
        {startFromBrief.isError ? (
          <p className="mt-2 pl-6 text-xs text-destructive">
            立项失败：
            {startFromBrief.error instanceof Error
              ? startFromBrief.error.message
              : "请重试"}
          </p>
        ) : null}
      </section>

      <section className="mt-10 grid grid-cols-2 gap-[18px] lg:grid-cols-4">
        {quickActions.map((a) => (
          <Link
            key={a.title}
            href={a.href}
            className="group flex flex-col gap-3 rounded-3xl border border-border bg-card p-5 shadow-[0_8px_24px_rgba(30,30,60,0.06)] transition-all hover:-translate-y-0.5 hover:border-primary/30"
          >
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-accent-soft text-lg text-primary">
              {a.icon}
            </span>
            <span className="text-[15px] font-semibold">{a.title}</span>
            <span className="text-xs leading-relaxed text-muted-foreground">
              {a.desc}
            </span>
          </Link>
        ))}
      </section>

      <section className="mt-12">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-2xl font-semibold">近期 Campaign</h2>
          <Link href="/campaigns" className="text-sm text-primary hover:underline">
            查看全部
          </Link>
        </div>
        {projects.length === 0 ? (
          <Link
            href="/campaigns"
            className="flex flex-col items-center rounded-3xl border border-dashed border-border bg-card p-12 text-center transition-colors hover:border-primary/30"
          >
            <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-xl text-primary">
              ＋
            </span>
            <span className="text-sm font-medium">创建第一个 Campaign</span>
            <span className="mt-1 text-xs text-muted-foreground">
              围绕营销项目管理需求、出图与交付
            </span>
          </Link>
        ) : (
          <div className="grid auto-cols-[minmax(260px,1fr)] grid-flow-col gap-[18px] overflow-x-auto pb-2">
            {projects.slice(0, 8).map((c) => {
              const s = STATUS_META[(c.status ?? "DRAFT") as Status];
              return (
                <Link
                  key={c.id}
                  href="/campaigns"
                  className="flex flex-col overflow-hidden rounded-3xl border border-border bg-card shadow-[0_8px_24px_rgba(30,30,60,0.06)] transition-all hover:-translate-y-0.5"
                >
                  <div className="h-32" style={{ background: gradientFor(c.id) }} />
                  <div className="flex flex-1 flex-col gap-2 p-4">
                    <div className="flex items-center gap-2">
                      <span className={badgeCls(s.tone)}>{s.label}</span>
                      <span className="text-xs text-muted-foreground">
                        {brandName}
                      </span>
                    </div>
                    <div className="text-sm font-semibold">{c.name}</div>
                    <ProgressBar value={c.progress ?? 0} />
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function badgeCls(tone: string) {
  const map: Record<string, string> = {
    primary: "bg-accent-soft text-primary",
    success: "bg-success/10 text-success",
    warning: "bg-warning/10 text-warning",
  };
  return `rounded-full px-2.5 py-0.5 text-[11px] font-medium ${map[tone] ?? map.primary}`;
}

function ProgressBar({ value }: { value: number }) {
  return (
    <div className="mt-1 flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-gradient-to-r from-primary to-accent"
          style={{ width: `${value}%` }}
        />
      </div>
      <span className="text-[11px] text-muted-foreground">{value}%</span>
    </div>
  );
}
