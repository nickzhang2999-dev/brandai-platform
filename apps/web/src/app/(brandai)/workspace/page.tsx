"use client";

import { useState } from "react";
import { assets, workspace } from "@/lib/brandai-mock";

/**
 * P05 · AI 工作台 — 左画布 + 变体条，右 prompt 面板（关键词/品牌约束/参考/配额）。
 * docs/02 §P05。注意（CLAUDE.md §2）：真实出图必须 server-authoritative——
 * "提交制作" 落 PENDING + 入队 worker，客户端轮询；此处先做交互骨架与受理态。
 */
export default function WorkspacePage() {
  const ws = workspace;
  const [variant, setVariant] = useState(ws.variants[0]!.id);
  const [prompt, setPrompt] = useState(ws.prompt);
  const [submitting, setSubmitting] = useState(false);
  const current = ws.variants.find((v) => v.id === variant) ?? ws.variants[0]!;
  const refAssets = assets.filter((a) => ws.references.includes(a.assetId));

  function submit() {
    // 一期占位：真实链路应 POST → AsyncTask(PENDING) → BullMQ → worker → apps/ai。
    setSubmitting(true);
    setTimeout(() => setSubmitting(false), 1800);
  }

  return (
    <div className="flex h-screen flex-col">
      {/* Canvas bar */}
      <div className="flex items-center justify-between border-b border-border bg-card px-6 py-3">
        <div className="text-sm text-muted-foreground">{ws.breadcrumb}</div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <button className="rounded-lg px-2 py-1 hover:bg-muted">↶</button>
          <button className="rounded-lg px-2 py-1 hover:bg-muted">↷</button>
          <span className="rounded-lg border border-border px-2.5 py-1 text-xs">100%</span>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[1fr_380px]">
        {/* Canvas */}
        <div className="flex min-h-0 flex-col bg-background p-6">
          <div className="flex flex-1 items-center justify-center overflow-hidden rounded-3xl border border-border bg-card p-6">
            <div
              className="aspect-[4/5] h-full max-h-[520px] rounded-2xl shadow-[0_26px_80px_rgba(124,92,255,0.24)]"
              style={{ background: current.cover }}
            />
          </div>
          {/* Variant strip */}
          <div className="mt-4 flex gap-3">
            {ws.variants.map((v) => (
              <button
                key={v.id}
                onClick={() => setVariant(v.id)}
                className={[
                  "h-[82px] w-[118px] overflow-hidden rounded-[18px] border-2 transition-colors",
                  v.id === variant ? "border-primary" : "border-transparent hover:border-border",
                ].join(" ")}
                style={{ background: v.cover }}
                title={v.title}
              />
            ))}
          </div>
        </div>

        {/* Prompt panel */}
        <aside className="flex min-h-0 flex-col gap-5 overflow-y-auto border-l border-border bg-card p-6">
          <div>
            <div className="mb-2 flex items-center justify-between text-sm font-semibold">
              <span>AI 提示词</span>
              <span className="text-xs font-normal text-muted-foreground">
                {prompt.length}/{ws.promptLimit}
              </span>
            </div>
            <textarea
              value={prompt}
              maxLength={ws.promptLimit}
              onChange={(e) => setPrompt(e.target.value)}
              rows={5}
              className="w-full resize-none rounded-2xl border border-border bg-background p-3 text-sm outline-none focus:border-primary/40 focus:shadow-[0_0_0_4px_rgba(124,92,255,0.08)]"
            />
          </div>

          <div>
            <div className="mb-2 text-sm font-semibold">风格关键词</div>
            <div className="flex flex-wrap gap-1.5">
              {ws.styleKeywords.map((k) => (
                <span key={k} className="rounded-full bg-accent-soft px-3 py-1 text-xs text-primary">
                  {k}
                </span>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-2 text-sm font-semibold">品牌约束</div>
            <div className="rounded-2xl border border-primary/15 bg-accent-soft/50 p-3">
              <div className="flex items-center gap-2 text-sm font-medium text-primary">
                <span>◎</span> {ws.brandConstraint.name}
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {ws.brandConstraint.desc}
              </p>
            </div>
          </div>

          <div>
            <div className="mb-2 text-sm font-semibold">参考素材</div>
            <div className="flex gap-2">
              {refAssets.map((a) => (
                <div
                  key={a.assetId}
                  className="h-14 w-14 rounded-xl border border-border"
                  style={{ background: a.cover }}
                  title={a.fileName}
                />
              ))}
              <button className="flex h-14 w-14 items-center justify-center rounded-xl border border-dashed border-border text-lg text-muted-foreground hover:border-primary/40 hover:text-primary">
                +
              </button>
            </div>
          </div>

          <div className="mt-auto">
            <button
              onClick={submit}
              disabled={submitting}
              className="h-12 w-full rounded-[18px] bg-gradient-to-br from-primary to-accent text-sm font-medium text-primary-foreground shadow-[0_12px_28px_rgba(124,92,255,0.26)] disabled:opacity-70"
            >
              {submitting ? "AI 正在生成…" : "提交制作"}
            </button>
            <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
              <span>今日剩余额度：{ws.quota.remaining}/{ws.quota.limit} 次</span>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              内容由 AI 生成，请注意核对准确性。
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
