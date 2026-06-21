"use client";

import { useRouter } from "next/navigation";
import { Button } from "@brandai/ui";
import { generationTemplates } from "@/lib/brandai-mock";
import { gradientFor, PageHeader } from "../_ui";

/**
 * P06 · 模板库（G1）— 把高频出图配置（场景 / 画面类型 / 风格关键词 / 卖点起手式）
 * 沉淀为可复用模板，一键带入工作台。模板是产品常量（lib/brandai-mock.ts::
 * generationTemplates），不是伪造数据，也不是假"生成结果"——点击只把配置经 query
 * 参数带进 `/workspace`，由用户在真实 worker→apps/ai→真 provider 管线里出图。
 */
export default function TemplatesPage() {
  const router = useRouter();

  function useTemplate(key: string) {
    const t = generationTemplates.find((x) => x.key === key);
    if (!t) return;
    const qs = new URLSearchParams({
      sceneType: t.sceneType,
      scene: t.scene,
      brief: t.sellingPoint,
      style: t.styleKeywords.join(","),
    });
    router.push(`/workspace?${qs.toString()}`);
  }

  return (
    <div className="mx-auto max-w-[1180px] px-10 py-10">
      <PageHeader
        title="模板库"
        subtitle="把高频出图配置沉淀为可复用模板，一键带入工作台出图"
      />

      <div className="mb-6 rounded-2xl border border-primary/15 bg-accent-soft/50 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
        模板预填场景、画面类型、风格关键词与卖点起手式；带入工作台后仍可自由编辑，
        再由真实 AI 受控出图。模板本身不含生成图片，仅作为配置起点。
      </div>

      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {generationTemplates.map((t) => (
          <div
            key={t.key}
            className="flex flex-col overflow-hidden rounded-3xl border border-border bg-card shadow-[0_8px_24px_rgba(30,30,60,0.06)] transition-all hover:border-primary/25 hover:shadow-[0_18px_50px_rgba(124,92,255,0.12)]"
          >
            <div
              className="flex h-32 items-center justify-center text-4xl text-primary-foreground"
              style={{ background: gradientFor(t.key) }}
            >
              {t.icon}
            </div>
            <div className="flex flex-1 flex-col p-5">
              <div className="text-[15px] font-semibold">{t.name}</div>
              <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                {t.desc}
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {t.styleKeywords.slice(0, 4).map((k) => (
                  <span
                    key={k}
                    className="rounded-full bg-accent-soft px-2.5 py-1 text-[11px] text-primary"
                  >
                    {k}
                  </span>
                ))}
              </div>
              <div className="mt-5">
                <Button
                  className="w-full justify-center"
                  onClick={() => useTemplate(t.key)}
                >
                  用此模板出图
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
