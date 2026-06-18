import { brandKnowledge } from "@/lib/brandai-mock";
import { Chip } from "../_ui";

/**
 * P03 · 品牌知识库 — 把品牌规则（视觉/内容/调性）沉淀为 AI 可调用的结构化知识。
 * docs/02 §P03：顶部 AI 共创区 + 上传网格(6) + 品牌核心知识卡 + AI 知识摘要。
 */
const PROMPT_CHIPS = [
  "生成高端护肤品牌知识库",
  "梳理品牌视觉语言",
  "提炼品牌语气与话术",
  "整理 Logo 使用规范",
];

export default function BrandKnowledgePage() {
  const kb = brandKnowledge;
  return (
    <div className="mx-auto max-w-[1180px] px-10 py-10">
      {/* Hero */}
      <section className="text-center">
        <h1 className="text-[34px] font-semibold tracking-tight">
          AI 助手 · 共创你的品牌知识库
        </h1>
        <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">
          上传品牌资料，AI 帮你解析、整理并生成结构化的品牌知识库，让每一次生成都遵循品牌规范。
        </p>
        <div className="mx-auto mt-6 flex max-w-2xl items-end gap-3 rounded-[34px] border border-primary/15 bg-card p-3 pl-6 shadow-[0_24px_70px_rgba(124,92,255,0.12)]">
          <textarea
            rows={2}
            placeholder="描述你的品牌，或粘贴品牌介绍，AI 会自动梳理成结构化知识库…"
            className="min-h-[52px] flex-1 resize-none border-0 bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground"
          />
          <button className="h-11 shrink-0 rounded-[18px] bg-gradient-to-br from-primary to-accent px-6 text-sm font-medium text-primary-foreground shadow-[0_12px_28px_rgba(124,92,255,0.26)]">
            生成
          </button>
        </div>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {PROMPT_CHIPS.map((p) => (
            <button
              key={p}
              className="rounded-full border border-border bg-card px-3.5 py-1.5 text-xs text-muted-foreground hover:border-primary/30 hover:text-primary"
            >
              {p}
            </button>
          ))}
        </div>
      </section>

      {/* Upload grid */}
      <section className="mt-10 grid grid-cols-3 gap-3.5 lg:grid-cols-6">
        {kb.uploadCards.map((u) => (
          <button
            key={u.title}
            className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border bg-card p-4 text-center transition-colors hover:border-primary/40 hover:bg-accent-soft/40"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-accent-soft text-lg text-primary">
              {u.icon}
            </span>
            <span className="text-xs font-medium">{u.title}</span>
            <span className="text-[10px] text-muted-foreground">{u.desc}</span>
          </button>
        ))}
      </section>

      {/* Core knowledge modules */}
      <section className="mt-12">
        <h2 className="mb-4 text-2xl font-semibold">品牌核心知识</h2>
        <div className="grid gap-[18px] md:grid-cols-2 lg:grid-cols-3">
          {kb.modules.map((m) => (
            <div
              key={m.title}
              className="flex flex-col gap-3 rounded-3xl border border-border bg-card p-5 shadow-[0_8px_24px_rgba(30,30,60,0.06)]"
            >
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-2xl bg-accent-soft text-base text-primary">
                  {m.icon}
                </span>
                <span className="text-[15px] font-semibold">{m.title}</span>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">{m.body}</p>
              {"swatches" in m && m.swatches ? (
                <div className="mt-1 flex gap-2">
                  {m.swatches.map((hex) => (
                    <span
                      key={hex}
                      className="h-7 w-7 rounded-lg border border-border"
                      style={{ backgroundColor: hex }}
                      title={hex}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </section>

      {/* AI summary */}
      <section className="mt-12 rounded-3xl border border-primary/15 bg-gradient-to-br from-accent-soft/70 to-card p-7 shadow-[0_8px_24px_rgba(30,30,60,0.06)]">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-card text-sm text-primary">
            ✦
          </span>
          <span className="text-sm font-semibold">AI 知识摘要 · {kb.brandName}</span>
        </div>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-foreground/80">{kb.aiSummary}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {kb.keywords.map((k) => (
            <Chip key={k}>{k}</Chip>
          ))}
        </div>
      </section>
    </div>
  );
}
