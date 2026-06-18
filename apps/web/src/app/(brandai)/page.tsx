import Link from "next/link";
import {
  campaigns,
  currentUser,
  quickActions,
  recommendedBrands,
  statusMeta,
} from "@/lib/brandai-mock";

/**
 * P01 · 首页 — AI 入口 + 近期项目速览 + 推荐品牌。
 * docs/02 §P01：问候区 + 居中 AI 输入框 + 4 张快捷卡 + 近期 Campaign 横滑 +
 * 推荐品牌瀑布。
 */
export default function HomePage() {
  return (
    <div className="mx-auto max-w-[1180px] px-10 py-10">
      {/* Greeting */}
      <section className="pt-4 text-center">
        <h1 className="text-[44px] font-[650] leading-tight tracking-tight">
          你好，{currentUser.name.slice(-2)}
        </h1>
        <p className="mt-3 text-base text-muted-foreground">
          用一句话描述你的品牌广告需求，BrandAI 帮你拆解、立项并受控出图。
        </p>
      </section>

      {/* AI input hero */}
      <section className="mx-auto mt-8 max-w-3xl">
        <div className="flex items-end gap-3 rounded-[34px] border border-primary/15 bg-card p-3 pl-6 shadow-[0_24px_70px_rgba(124,92,255,0.12)]">
          <button
            type="button"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-accent-soft text-lg text-primary"
            aria-label="添加附件"
          >
            +
          </button>
          <textarea
            rows={2}
            placeholder="例如：为 LUMINA 夏季新品做一组小红书种草主视觉，清透水光风格…"
            className="min-h-[56px] flex-1 resize-none border-0 bg-transparent py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          <button
            type="button"
            className="h-11 shrink-0 rounded-[18px] bg-gradient-to-br from-primary to-accent px-6 text-sm font-medium text-primary-foreground shadow-[0_12px_28px_rgba(124,92,255,0.26)]"
          >
            发送
          </button>
        </div>
      </section>

      {/* Quick actions */}
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
            <span className="text-xs leading-relaxed text-muted-foreground">{a.desc}</span>
          </Link>
        ))}
      </section>

      {/* Recent campaigns */}
      <section className="mt-12">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-2xl font-semibold">近期 Campaign</h2>
          <Link href="/campaigns" className="text-sm text-primary hover:underline">
            查看全部
          </Link>
        </div>
        <div className="grid auto-cols-[minmax(260px,1fr)] grid-flow-col gap-[18px] overflow-x-auto pb-2">
          {campaigns.map((c) => {
            const s = statusMeta[c.status];
            return (
              <Link
                key={c.campaignId}
                href="/campaigns"
                className="flex flex-col overflow-hidden rounded-3xl border border-border bg-card shadow-[0_8px_24px_rgba(30,30,60,0.06)] transition-all hover:-translate-y-0.5"
              >
                <div className="h-32" style={{ background: c.cover }} />
                <div className="flex flex-1 flex-col gap-2 p-4">
                  <div className="flex items-center gap-2">
                    <span className={badgeCls(s.tone)}>{s.label}</span>
                    <span className="text-xs text-muted-foreground">{c.brandName}</span>
                  </div>
                  <div className="text-sm font-semibold">{c.campaignName}</div>
                  <ProgressBar value={c.progress} />
                </div>
              </Link>
            );
          })}
        </div>
      </section>

      {/* Recommended brands */}
      <section className="mt-12">
        <h2 className="mb-4 text-2xl font-semibold">推荐品牌</h2>
        <div className="[column-gap:18px] sm:columns-2 lg:columns-3">
          {recommendedBrands.map((b, i) => (
            <div
              key={b.brandId}
              className="mb-[18px] break-inside-avoid overflow-hidden rounded-3xl border border-border bg-card shadow-[0_8px_24px_rgba(30,30,60,0.06)]"
            >
              <div style={{ background: b.cover, height: 120 + (i % 3) * 40 }} />
              <div className="flex flex-col gap-2 p-4">
                <div className="flex items-center justify-between">
                  <span className="text-[15px] font-semibold">{b.brandName}</span>
                  <span className="text-xs text-muted-foreground">{b.subtitle}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {b.tags.map((t) => (
                    <span key={t} className={chipCls}>
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/* ── small shared bits (kept local; promote to packages/ui when reused) ── */
const chipCls =
  "rounded-full border border-border bg-muted px-2.5 py-1 text-[11px] text-muted-foreground";

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
