"use client";

import { PageHeader } from "../_ui";

/**
 * P06 · 模板库（占位）— 即将上线。把高频出图配置（prompt / 风格关键词 / 品牌
 * 约束 / 参考图）沉淀为可复用模板，一键带入工作台出图。一期先放占位骨架，
 * 不造模板假数据；接 BFF 后按同名字段替换数据源。
 */
export default function TemplatesPage() {
  return (
    <div className="mx-auto max-w-[1180px] px-10 py-10">
      <PageHeader
        title="模板库"
        subtitle="把高频出图配置沉淀为可复用模板，下次一键带入工作台"
      />

      <div className="rounded-3xl border border-dashed border-border bg-card p-16 text-center shadow-[0_8px_24px_rgba(30,30,60,0.06)]">
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-3xl bg-accent-soft text-3xl text-primary">
          ▱
        </div>
        <div className="text-lg font-semibold">模板库即将上线</div>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
          把高频出图配置（提示词、风格关键词、品牌约束与参考图）沉淀为可复用模板，
          团队成员一键带入工作台，保持品牌一致性的同时大幅提速。
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <span className="rounded-full border border-border bg-muted px-3 py-1 text-[11px] text-muted-foreground">
            提示词模板
          </span>
          <span className="rounded-full border border-border bg-muted px-3 py-1 text-[11px] text-muted-foreground">
            风格预设
          </span>
          <span className="rounded-full border border-border bg-muted px-3 py-1 text-[11px] text-muted-foreground">
            场景套件
          </span>
        </div>
      </div>
    </div>
  );
}
