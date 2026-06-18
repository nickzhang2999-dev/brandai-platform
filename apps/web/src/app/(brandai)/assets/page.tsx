"use client";

import { useState } from "react";
import { Button } from "@brandai/ui";
import { assetFilters, assetStats, assets } from "@/lib/brandai-mock";
import { Chip, PageHeader } from "../_ui";

/**
 * P04 · 素材库 — 统计卡 + 类型筛选 + 素材网格 + 右侧详情面板（AI 标签/描述）。
 * docs/02 §P04。
 */
export default function AssetsPage() {
  const [activeId, setActiveId] = useState(assets[0]!.assetId);
  const [filter, setFilter] = useState("全部");
  const active = assets.find((a) => a.assetId === activeId) ?? assets[0]!;

  return (
    <div className="mx-auto max-w-[1180px] px-10 py-10">
      <PageHeader
        title="素材库"
        subtitle="集中管理品牌图片、视频、文档与参考素材"
        action={
          <div className="flex gap-2">
            <Button variant="outline" size="lg">＋ 新建文件夹</Button>
            <Button size="lg">⬆ 上传素材</Button>
          </div>
        }
      />

      {/* Stats */}
      <div className="mb-6 grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        {assetStats.map((s) => (
          <div
            key={s.label}
            className="rounded-3xl border border-border bg-card p-5 shadow-[0_8px_24px_rgba(30,30,60,0.06)]"
          >
            <div className="text-xs text-muted-foreground">{s.label}</div>
            <div className="mt-1 text-3xl font-semibold">{s.value}</div>
          </div>
        ))}
      </div>

      {/* Search + filters */}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <input
          placeholder="搜索素材名称 / 关键词 / 标签…"
          className="h-10 flex-1 rounded-full border border-border bg-card px-4 text-sm outline-none focus:border-primary/40 focus:shadow-[0_0_0_4px_rgba(124,92,255,0.08)]"
        />
        {assetFilters.map((f) => (
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

      {/* Grid + detail */}
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
          {assets.map((a) => {
            const isActive = a.assetId === activeId;
            return (
              <button
                key={a.assetId}
                onClick={() => setActiveId(a.assetId)}
                className={[
                  "flex flex-col overflow-hidden rounded-3xl border bg-card text-left transition-all",
                  isActive
                    ? "border-primary/40 shadow-[0_18px_50px_rgba(124,92,255,0.12)]"
                    : "border-border shadow-[0_8px_24px_rgba(30,30,60,0.06)] hover:border-primary/25",
                ].join(" ")}
              >
                <div className="h-32" style={{ background: a.cover }} />
                <div className="flex flex-col gap-1.5 p-3">
                  <div className="truncate text-xs font-medium">{a.fileName}</div>
                  <div className="flex flex-wrap gap-1">
                    {a.tags.map((t) => (
                      <Chip key={t}>{t}</Chip>
                    ))}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {/* Detail panel */}
        <aside className="sticky top-6 h-fit rounded-3xl border border-border bg-card p-5 shadow-[0_8px_24px_rgba(30,30,60,0.06)]">
          <div className="h-44 rounded-2xl" style={{ background: active.cover }} />
          <div className="mt-4 text-sm font-semibold">{active.fileName}</div>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            {active.aiDescription}
          </p>

          <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
            <dt className="text-muted-foreground">类型</dt>
            <dd>{active.fileType} · {active.category}</dd>
            <dt className="text-muted-foreground">尺寸</dt>
            <dd>{active.resolution}</dd>
            <dt className="text-muted-foreground">大小</dt>
            <dd>{active.fileSize}</dd>
            <dt className="text-muted-foreground">上传者</dt>
            <dd>{active.uploader}</dd>
            <dt className="text-muted-foreground">上传时间</dt>
            <dd>{active.uploadTime}</dd>
          </dl>

          <div className="mt-4">
            <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="text-primary">✦</span> AI 智能标签
            </div>
            <div className="flex flex-wrap gap-1.5">
              {active.aiTags.map((t) => (
                <span key={t} className="rounded-full bg-accent-soft px-2.5 py-1 text-[11px] text-primary">
                  {t}
                </span>
              ))}
            </div>
          </div>

          <div className="mt-5 flex flex-col gap-2">
            <Button className="w-full justify-center">加入项目</Button>
            <Button variant="outline" className="w-full justify-center">设为参考</Button>
            <Button variant="ghost" className="w-full justify-center">查看来源</Button>
          </div>
        </aside>
      </div>
    </div>
  );
}
