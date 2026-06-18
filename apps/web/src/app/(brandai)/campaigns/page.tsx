"use client";

import { useState } from "react";
import { Button } from "@brandai/ui";
import { campaigns } from "@/lib/brandai-mock";
import { Chip, PageHeader, ProgressBar, StatusBadge } from "../_ui";

/**
 * P02 · Campaign 项目 — 左侧项目卡列表 + 右侧 AI 摘要面板。
 * docs/02 §P02：搜索/筛选/排序 + 项目卡（缩略图/状态/标签/进度/时间线）+
 * 右栏 AI 摘要 + 5 个快捷动作。
 */
const FILTERS = ["全部状态", "进行中", "草稿", "已完成"];
const ACTIONS = ["继续创作", "补充需求", "查看项目规范", "提交终审", "归档项目"];

export default function CampaignsPage() {
  const [activeId, setActiveId] = useState(campaigns[0]!.campaignId);
  const [filter, setFilter] = useState("全部状态");
  const active = campaigns.find((c) => c.campaignId === activeId) ?? campaigns[0]!;

  return (
    <div className="mx-auto max-w-[1180px] px-10 py-10">
      <PageHeader
        title="Campaign 项目"
        subtitle="集中管理品牌的所有营销项目"
        action={<Button size="lg">＋ 创建新 Campaign</Button>}
      />

      {/* Search + filters */}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <input
          placeholder="搜索项目名称 / 品牌…"
          className="h-10 flex-1 rounded-full border border-border bg-card px-4 text-sm outline-none focus:border-primary/40 focus:shadow-[0_0_0_4px_rgba(124,92,255,0.08)]"
        />
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={[
              "h-9 rounded-full px-4 text-sm transition-colors",
              filter === f
                ? "bg-accent-soft font-medium text-primary"
                : "border border-border bg-card text-muted-foreground hover:bg-muted",
            ].join(" ")}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Two-column: list + AI summary */}
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="flex flex-col gap-[18px]">
          {campaigns.map((c) => {
            const isActive = c.campaignId === activeId;
            return (
              <button
                key={c.campaignId}
                onClick={() => setActiveId(c.campaignId)}
                className={[
                  "grid grid-cols-[190px_1fr] gap-[18px] rounded-3xl border bg-card p-4 text-left transition-all",
                  isActive
                    ? "border-primary/40 shadow-[0_18px_50px_rgba(124,92,255,0.12)]"
                    : "border-border shadow-[0_8px_24px_rgba(30,30,60,0.06)] hover:border-primary/25",
                ].join(" ")}
              >
                <div className="h-[150px] rounded-[20px]" style={{ background: c.cover }} />
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <StatusBadge status={c.status} />
                    <span className="text-xs text-muted-foreground">{c.brandName}</span>
                  </div>
                  <div className="text-[17px] font-semibold">{c.campaignName}</div>
                  <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                    {c.description}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {c.tags.map((t) => (
                      <Chip key={t}>{t}</Chip>
                    ))}
                  </div>
                  <ProgressBar value={c.progress} />
                  <div className="text-[11px] text-muted-foreground">
                    {c.startDate} — {c.endDate}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {/* AI summary panel */}
        <aside className="sticky top-6 h-fit rounded-3xl border border-border bg-card p-6 shadow-[0_8px_24px_rgba(30,30,60,0.06)]">
          <div className="mb-1 flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-accent-soft text-sm text-primary">
              ✦
            </span>
            <span className="text-sm font-semibold">AI 项目摘要</span>
          </div>
          <div className="mt-3 text-[15px] font-semibold">{active.campaignName}</div>
          <p className="mt-2 rounded-2xl bg-accent-soft/60 p-4 text-xs leading-relaxed text-foreground/80">
            {active.aiSummary}
          </p>
          <div className="mt-4">
            <div className="mb-2 text-xs text-muted-foreground">投放渠道</div>
            <div className="flex flex-wrap gap-1.5">
              {active.channels.map((ch) => (
                <Chip key={ch}>{ch}</Chip>
              ))}
            </div>
          </div>
          <div className="mt-5 flex flex-col gap-2">
            {ACTIONS.map((a, i) => (
              <Button key={a} variant={i === 0 ? "primary" : "outline"} className="w-full justify-center">
                {a}
              </Button>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
