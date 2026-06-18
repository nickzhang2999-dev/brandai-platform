import Link from "next/link";
import {
  Badge,
  Button,
  ColorSwatch,
  Eyebrow,
  FieldLabel,
  Panel,
  StyleTag,
} from "@brandai/ui";
import { auth } from "@/auth";

/**
 * Public landing — "品牌视觉能力展示空间" (UI 风格定义 §5).
 *
 * Editorial AI Workspace language: warm-minimal, gallery-like, serif display +
 * mono kickers, generous whitespace, large rounded cards. Every "visual" is
 * composed from design tokens (swatches / type samples / tags) so nothing
 * depends on external imagery — the page itself demonstrates the product's
 * design sensibility. Marketing-only; auth/routes are untouched.
 */

const HERO_SWATCHES = [
  { name: "Off White", hex: "#F7F4EF" },
  { name: "Warm Sand", hex: "#E8DFD2" },
  { name: "Burgundy", hex: "#6E1F2B" },
  { name: "Deep Olive", hex: "#3E4A36" },
  { name: "Muted Gold", hex: "#B89B5E" },
];

const HERO_TAGS = [
  "暖色自然光",
  "低饱和色彩",
  "现代东方感",
  "强留白",
  "高对比排版",
];

const WORKFLOW_STEPS = [
  {
    n: "01",
    label: "上传 / 读取",
    desc: "导入官网、Logo、产品图与历史视觉,建立品牌资产底座。",
  },
  {
    n: "02",
    label: "AI 分析",
    desc: "识别色彩、字体、版式与语气,抽取品牌视觉 DNA。",
  },
  {
    n: "03",
    label: "风格系统",
    desc: "把零散资产固化为可确认、可复用的品牌视觉系统。",
  },
  {
    n: "04",
    label: "生成 / 修正",
    desc: "基于规范受控生成,而非自由画图;逐版对比与修正。",
  },
  {
    n: "05",
    label: "沉淀规范",
    desc: "确认后的系统沉淀为团队可长期协作的品牌规范。",
  },
];

const USE_CASES = [
  {
    title: "品牌手册",
    desc: "色彩、字体、版式与应用规则,形成可交付的视觉规范。",
    tag: "VI System",
  },
  {
    title: "社媒视觉",
    desc: "按品牌系统批量产出小红书、微博等渠道一致的视觉方向。",
    tag: "Social",
  },
  {
    title: "Campaign KV",
    desc: "活动主视觉在统一调性下延展,保持品牌识别度。",
    tag: "Key Visual",
  },
  {
    title: "门店物料",
    desc: "线下海报、陈列与物料,沿用同一套视觉语言。",
    tag: "Retail",
  },
  {
    title: "产品页视觉",
    desc: "电商主图与卖点图受控生成,符合规范且可校验。",
    tag: "E-commerce",
  },
];

const SYSTEM_FONTS = [
  { sample: "品牌叙事", role: "标题 · 思源宋体", note: "Editorial 衬线,带杂志与设计感" },
  { sample: "界面与正文", role: "正文 · 思源黑体", note: "保证长文本与界面可读性" },
  { sample: "BRAND · DNA · 01", role: "标签 · Mono", note: "数据、状态与来源用等宽呈现" },
];

const VOICE_TAGS = ["专业可信", "克制高级", "有温度", "系统化", "现代东方"];

export default async function Home() {
  const session = await auth();
  const startHref = session ? "/workspaces" : "/login";
  const startLabel = session ? "进入工作台" : "开始体验";

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Top bar */}
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <div className="flex items-baseline gap-3">
          <span className="font-serif text-xl tracking-tight">OpenVisual</span>
          <span className="hidden font-mono text-[11px] uppercase tracking-[0.25em] text-muted-foreground sm:inline">
            Brand Visual AI
          </span>
        </div>
        <Link href={startHref}>
          <Button variant="ghost" size="sm">
            {startLabel}
          </Button>
        </Link>
      </header>

      {/* 1 · Hero — asymmetric ~7:5 */}
      <section className="mx-auto grid max-w-6xl items-center gap-12 px-6 pb-20 pt-10 md:pt-16 lg:grid-cols-12 lg:gap-10">
        <div className="lg:col-span-7">
          <Eyebrow tone="accent">Editorial AI Workspace · 品牌视觉</Eyebrow>
          <h1 className="mt-5 font-serif text-4xl leading-[1.12] tracking-tight md:text-6xl">
            输入一个官网,
            <br />
            生成一套可确认的
            <br />
            <span className="text-primary">品牌视觉系统</span>。
          </h1>
          <p className="mt-6 max-w-lg text-base leading-relaxed text-muted-foreground">
            不是生成单张图,而是理解、固化并延展你的品牌视觉系统。
            上传品牌资产,AI 识别 VI 规则,按规范受控生成电商图与活动 KV,
            并沉淀为团队可长期协作的品牌规范。
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-4">
            <Link href={startHref}>
              <Button size="lg">{startLabel}</Button>
            </Link>
            <Link href="#workflow">
              <Button size="lg" variant="outline">
                了解工作流
              </Button>
            </Link>
          </div>
        </div>

        {/* Right · floating brand canvas, built from tokens only */}
        <div className="lg:col-span-5">
          <div className="relative">
            <div
              aria-hidden
              className="absolute -inset-6 -z-10 rounded-[2.5rem] bg-card/60 blur-2xl"
            />
            <div className="rounded-3xl border border-foreground/10 bg-card p-7 shadow-sm md:p-8">
              <div className="flex items-center justify-between">
                <Eyebrow>Brand Canvas</Eyebrow>
                <Badge tone="risk">AI 识别中</Badge>
              </div>

              {/* color row */}
              <div className="mt-6">
                <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                  色彩系统 · COLOR
                </div>
                <div className="mt-3 flex gap-3">
                  {HERO_SWATCHES.map((s) => (
                    <div
                      key={s.hex}
                      className="h-11 flex-1 rounded-xl border border-foreground/10 shadow-sm"
                      style={{ backgroundColor: s.hex }}
                      aria-label={`${s.name} ${s.hex}`}
                    />
                  ))}
                </div>
              </div>

              {/* type sample mini-panel */}
              <div className="mt-6 rounded-2xl border border-foreground/10 bg-background p-5">
                <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                  字体系统 · TYPE
                </div>
                <div className="mt-2 font-serif text-2xl leading-tight">
                  现代东方 · 品牌叙事
                </div>
                <div className="mt-1 text-sm text-muted-foreground">
                  思源宋体 / 思源黑体 · 高级而克制
                </div>
              </div>

              {/* feature pills */}
              <div className="mt-6">
                <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                  风格特征 · STYLE
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {HERO_TAGS.map((t) => (
                    <StyleTag key={t}>{t}</StyleTag>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 2 · Brand Visual Intelligence — one-screen statement */}
      <section className="border-y border-foreground/10 bg-card/40">
        <div className="mx-auto max-w-4xl px-6 py-24 text-center md:py-28">
          <Eyebrow tone="accent" className="text-center">
            Brand Visual Intelligence
          </Eyebrow>
          <h2 className="mt-6 font-serif text-3xl leading-snug tracking-tight md:text-5xl">
            不是生成单图,
            <br className="hidden sm:block" />
            而是理解并复用整套品牌视觉系统。
          </h2>
          <p className="mx-auto mt-8 max-w-2xl text-base leading-relaxed text-muted-foreground">
            从颜色、字体、版式到语气,AI 把你品牌中隐含的一致性显性化、结构化、
            可确认。每一次生成都来自同一套被理解的系统,而非一次性的随机创作。
          </p>
        </div>
      </section>

      {/* 3 · Workflow stepper */}
      <section id="workflow" className="mx-auto max-w-6xl px-6 py-24">
        <div className="max-w-2xl">
          <Eyebrow tone="accent">Workflow · 工作流</Eyebrow>
          <h2 className="mt-4 font-serif text-3xl tracking-tight md:text-4xl">
            从资料到规范的五步闭环
          </h2>
        </div>
        <ol className="mt-12 grid gap-px overflow-hidden rounded-3xl border border-foreground/10 bg-foreground/10 md:grid-cols-5">
          {WORKFLOW_STEPS.map((step) => (
            <li key={step.n} className="flex flex-col gap-3 bg-card p-6">
              <span className="font-mono text-xs uppercase tracking-[0.2em] text-accent">
                {step.n}
              </span>
              <span className="font-serif text-lg">{step.label}</span>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {step.desc}
              </p>
            </li>
          ))}
        </ol>
      </section>

      {/* 4 · Use Cases — quiet cards */}
      <section className="border-t border-foreground/10 bg-card/40">
        <div className="mx-auto max-w-6xl px-6 py-24">
          <div className="max-w-2xl">
            <Eyebrow tone="accent">Use Cases · 应用场景</Eyebrow>
            <h2 className="mt-4 font-serif text-3xl tracking-tight md:text-4xl">
              一套系统,贯穿所有出口
            </h2>
          </div>
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {USE_CASES.map((u) => (
              <div
                key={u.title}
                className="flex h-full flex-col gap-3 rounded-2xl border border-foreground/10 bg-background p-7 shadow-sm transition-colors hover:border-accent"
              >
                <div className="flex items-center justify-between">
                  <h3 className="font-serif text-xl">{u.title}</h3>
                  <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                    {u.tag}
                  </span>
                </div>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {u.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 5 · Brand System Preview — systematized field cards */}
      <section className="mx-auto max-w-6xl px-6 py-24">
        <div className="max-w-2xl">
          <Eyebrow tone="accent">Brand System · 系统化字段</Eyebrow>
          <h2 className="mt-4 font-serif text-3xl tracking-tight md:text-4xl">
            把品牌讲成可读的系统
          </h2>
        </div>

        <div className="mt-12 grid gap-6 lg:grid-cols-3">
          {/* Color field */}
          <Panel className="lg:col-span-1">
            <FieldLabel>色彩 · COLOR</FieldLabel>
            <div className="mt-5 flex flex-wrap gap-4">
              {HERO_SWATCHES.map((s) => (
                <ColorSwatch key={s.hex} hex={s.hex} name={s.name} />
              ))}
            </div>
            <p className="mt-5 text-sm leading-relaxed text-muted-foreground">
              暖白与浅砂为底,石墨为字,勃艮第与橄榄作强调 —— 克制而有识别度。
            </p>
          </Panel>

          {/* Type field */}
          <Panel className="lg:col-span-1">
            <FieldLabel>字体 · TYPE</FieldLabel>
            <div className="mt-5 flex flex-col gap-4">
              {SYSTEM_FONTS.map((f) => (
                <div
                  key={f.role}
                  className="rounded-2xl border border-foreground/10 bg-background px-5 py-4"
                >
                  <div
                    className={
                      f.role.includes("Mono")
                        ? "font-mono text-base tracking-wide"
                        : f.role.includes("标题")
                          ? "font-serif text-2xl leading-tight"
                          : "text-lg"
                    }
                  >
                    {f.sample}
                  </div>
                  <div className="mt-1 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
                    {f.role}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {f.note}
                  </div>
                </div>
              ))}
            </div>
          </Panel>

          {/* Layout + Voice field */}
          <div className="flex flex-col gap-6 lg:col-span-1">
            <Panel>
              <FieldLabel>版式 · LAYOUT</FieldLabel>
              <div className="mt-5 flex flex-col gap-2.5">
                <div className="h-2.5 w-1/3 rounded-full bg-primary/80" />
                <div className="h-2 w-3/4 rounded-full bg-foreground/15" />
                <div className="h-2 w-2/3 rounded-full bg-foreground/15" />
                <div className="mt-2 h-16 w-full rounded-xl border border-foreground/10 bg-muted" />
              </div>
              <p className="mt-5 text-sm leading-relaxed text-muted-foreground">
                大留白、不对称栅格、统一圆角 —— 杂志式的呼吸感。
              </p>
            </Panel>

            <Panel>
              <FieldLabel>语气 · VOICE</FieldLabel>
              <div className="mt-5 flex flex-wrap gap-2">
                {VOICE_TAGS.map((t) => (
                  <StyleTag key={t}>{t}</StyleTag>
                ))}
              </div>
            </Panel>
          </div>
        </div>
      </section>

      {/* 6 · CTA footer */}
      <section className="border-t border-foreground/10 bg-card/40">
        <div className="mx-auto max-w-4xl px-6 py-28 text-center">
          <Eyebrow tone="accent" className="text-center">
            Get Started
          </Eyebrow>
          <h2 className="mt-6 font-serif text-3xl leading-snug tracking-tight md:text-5xl">
            开始建立你的品牌视觉系统
          </h2>
          <p className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-muted-foreground">
            从一个官网或一组资产出发,让 AI 把你的品牌讲成一套可确认、可复用的系统。
          </p>
          <div className="mt-10 flex justify-center">
            <Link href={startHref}>
              <Button size="lg">{startLabel}</Button>
            </Link>
          </div>
        </div>
      </section>

      <footer className="mx-auto flex max-w-6xl flex-col gap-2 px-6 py-10 sm:flex-row sm:items-center sm:justify-between">
        <span className="font-serif text-base">OpenVisual</span>
        <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
          Brand Visual AI · Editorial AI Workspace
        </span>
      </footer>
    </div>
  );
}
