import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@brandai/db";
import { Button } from "@brandai/ui";
import { auth } from "@/auth";
import { getWorkspaceStats, listRecentVersions } from "@/lib/generations";

export const dynamic = "force-dynamic";

const SCENE_TYPE_LABELS: Record<string, string> = {
  ECOM_MAIN: "电商主图",
  SCENE: "场景图",
  SOCIAL_POSTER: "社媒海报",
  CAMPAIGN_KV: "活动 KV",
  SELLING_POINT: "产品卖点图",
};

type Swatch = { name?: string; hex: string };

/**
 * Defensively pull a color palette out of a confirmed `color` BrandRule.
 * Prefer the strongly-typed `structured.palette` ({ name?, hex? }[]); fall
 * back to a loosely-shaped legacy `value` (palette array, or array of hex
 * strings). Returns only entries that look like real colors.
 */
function extractSwatches(rule: {
  structured: unknown;
  value: unknown;
}): Swatch[] {
  const seen = new Set<string>();
  const out: Swatch[] = [];

  const push = (name: unknown, hex: unknown) => {
    if (typeof hex !== "string") return;
    const h = hex.trim();
    if (!/^#?[0-9a-fA-F]{3,8}$/.test(h)) return;
    const normalized = h.startsWith("#") ? h : `#${h}`;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      name: typeof name === "string" && name.trim() ? name.trim() : undefined,
      hex: normalized,
    });
  };

  const readPalette = (raw: unknown) => {
    if (!raw || typeof raw !== "object") return;
    const palette = (raw as Record<string, unknown>).palette;
    if (!Array.isArray(palette)) return;
    for (const entry of palette) {
      if (typeof entry === "string") {
        push(undefined, entry);
      } else if (entry && typeof entry === "object") {
        const e = entry as Record<string, unknown>;
        push(e.name, e.hex ?? e.color ?? e.value);
      }
    }
  };

  readPalette(rule.structured);
  if (out.length === 0) readPalette(rule.value);
  // Final fallback: a legacy `value` that is itself an array of hex strings.
  if (out.length === 0 && Array.isArray(rule.value)) {
    for (const entry of rule.value) push(undefined, entry);
  }
  return out;
}

/** Defensively pull a primary font name out of a confirmed `font` BrandRule. */
function extractFont(rule: { structured: unknown; value: unknown }):
  | string
  | null {
  const fromObj = (raw: unknown): string | null => {
    if (!raw || typeof raw !== "object") return null;
    const o = raw as Record<string, unknown>;
    const candidate = o.primary_font ?? o.family ?? o.name;
    return typeof candidate === "string" && candidate.trim()
      ? candidate.trim()
      : null;
  };
  return fromObj(rule.structured) ?? fromObj(rule.value);
}

export default async function WorkspaceDashboard({
  params,
}: {
  params: Promise<{ wsId: string }>;
}) {
  const { wsId } = await params;
  const session = await auth();
  const userId = session!.user!.id;

  const workspace = await prisma.brandWorkspace.findUnique({
    where: { id: wsId },
  });
  if (!workspace || workspace.ownerId !== userId) notFound();

  const [stats, recentVersions, colorRules, fontRules] = await Promise.all([
    getWorkspaceStats(wsId),
    listRecentVersions(wsId, 8),
    prisma.brandRule.findMany({
      where: { workspaceId: wsId, type: "color", status: "CONFIRMED" },
      orderBy: { updatedAt: "desc" },
      select: { id: true, structured: true, value: true },
    }),
    prisma.brandRule.findMany({
      where: { workspaceId: wsId, type: "font", status: "CONFIRMED" },
      orderBy: { updatedAt: "desc" },
      select: { id: true, structured: true, value: true },
    }),
  ]);

  const base = `/workspaces/${wsId}`;

  const swatches = colorRules
    .flatMap((rule) => extractSwatches(rule))
    .slice(0, 8);
  const fonts = Array.from(
    new Set(
      fontRules
        .map((rule) => extractFont(rule))
        .filter((f): f is string => Boolean(f)),
    ),
  ).slice(0, 3);

  const statItems = [
    { label: "ASSETS", value: stats.assets, hint: "品牌素材" },
    { label: "RULES", value: stats.confirmedRules, hint: "已确认规则" },
    { label: "GENERATIONS", value: stats.generations, hint: "生成记录" },
    { label: "FINAL", value: stats.finalVersions, hint: "最终交付版" },
  ];

  const nextSteps = [
    {
      title: "上传素材",
      desc: "导入 Logo、产品图、官网视觉，建立品牌资产底座。",
      href: `${base}/assets`,
    },
    {
      title: "AI 识别风格",
      desc: "让 AI 抽取色彩、字体与版式,固化为品牌规则。",
      href: `${base}/rules`,
    },
    {
      title: "批量生成",
      desc: "基于品牌系统受控生成电商主图、社媒与 KV 视觉。",
      href: `${base}/generate`,
    },
  ];

  return (
    <div className="mx-auto max-w-6xl">
      {/* 1 · Page header — editorial, not admin */}
      <header className="mb-10 flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-3 font-mono text-xs uppercase tracking-[0.25em] text-muted-foreground">
            WORKSPACE · 品牌视觉总览
          </div>
          <h1 className="font-serif text-4xl leading-tight md:text-5xl">
            {workspace.name}
          </h1>
          <p className="mt-3 max-w-xl text-sm text-muted-foreground">
            {workspace.industry
              ? `${workspace.industry} · 品牌视觉系统工作台`
              : "你的品牌视觉系统工作台 — 资产、规则与生成的统一现场。"}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-3">
          <Link href={`${base}/generate`}>
            <Button>开始生成</Button>
          </Link>
          <Link href={`${base}/assets`}>
            <Button variant="ghost">进入资产库</Button>
          </Link>
        </div>
      </header>

      {/* 2 · Brand DNA panel — THE visual center */}
      <section className="rounded-3xl border border-foreground/10 bg-card p-8 shadow-sm md:p-10">
        <div className="mb-8 flex items-baseline justify-between gap-4">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-[0.25em] text-accent">
              BRAND DNA
            </div>
            <h2 className="mt-2 font-serif text-2xl md:text-3xl">
              品牌视觉 DNA
            </h2>
          </div>
          <Link
            href={`${base}/rules`}
            className="hidden font-mono text-xs uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground sm:block"
          >
            管理规则 →
          </Link>
        </div>

        {/* 色彩系统 */}
        <div className="mb-8">
          <div className="mb-4 font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
            色彩系统 · COLOR
          </div>
          {swatches.length > 0 ? (
            <div className="flex flex-wrap gap-5">
              {swatches.map((swatch) => (
                <div key={swatch.hex} className="flex flex-col gap-2">
                  <div
                    className="h-16 w-16 rounded-2xl border border-foreground/10 shadow-sm"
                    style={{ backgroundColor: swatch.hex }}
                    aria-label={swatch.name ?? swatch.hex}
                  />
                  <div className="flex flex-col leading-tight">
                    {swatch.name ? (
                      <span className="text-xs text-foreground/70">
                        {swatch.name}
                      </span>
                    ) : null}
                    <span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
                      {swatch.hex}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-start gap-3 rounded-2xl border border-dashed border-foreground/15 bg-muted/40 px-6 py-8">
              <p className="text-sm text-muted-foreground">
                AI 识别后,品牌主色会在这里成型。
              </p>
              <Link
                href={`${base}/rules`}
                className="font-mono text-xs uppercase tracking-wide text-primary transition-colors hover:text-primary/80"
              >
                去识别 →
              </Link>
            </div>
          )}
        </div>

        {/* 字体 / 关键词 */}
        {fonts.length > 0 ? (
          <div className="border-t border-foreground/10 pt-6">
            <div className="mb-3 font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
              字体系统 · TYPE
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {fonts.map((font) => (
                <span
                  key={font}
                  className="rounded-full border border-foreground/15 bg-muted px-3 py-1 text-xs text-foreground/80"
                >
                  {font}
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      {/* 3 · 近期生成 gallery */}
      <section className="mt-12">
        <div className="mb-5 flex items-baseline justify-between gap-4">
          <h2 className="font-serif text-2xl md:text-3xl">近期生成</h2>
          {recentVersions.length > 0 ? (
            <Link
              href={`${base}/assets`}
              className="font-mono text-xs uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
            >
              资产库 →
            </Link>
          ) : null}
        </div>

        {recentVersions.length === 0 ? (
          <div className="flex flex-col items-center gap-5 rounded-3xl border border-dashed border-foreground/15 bg-card/50 px-6 py-16 text-center">
            <p className="font-serif text-xl text-foreground/80">
              还没有生成图
            </p>
            <p className="max-w-sm text-sm text-muted-foreground">
              基于你的品牌系统,生成第一组受控的视觉方向。
            </p>
            <Link href={`${base}/generate`}>
              <Button>开始第一张 →</Button>
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4">
            {recentVersions.map((version) => (
              <Link
                key={version.id}
                href={`${base}/projects/${version.projectId}`}
                className="group flex flex-col gap-2.5"
              >
                <div className="relative aspect-square overflow-hidden rounded-2xl border border-foreground/10 bg-muted shadow-sm transition-all duration-200 group-hover:-translate-y-1 group-hover:shadow-md">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={version.imageUrl}
                    alt={`${SCENE_TYPE_LABELS[version.sceneType] ?? version.sceneType} 生成图`}
                    className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                  />
                </div>
                <span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
                  {SCENE_TYPE_LABELS[version.sceneType] ?? version.sceneType}
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* 4 · 概览数据 — demoted slim strip */}
      <section className="mt-12 rounded-2xl border border-foreground/10 bg-card/40 px-6 py-5">
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
          {statItems.map((item) => (
            <div key={item.label} className="flex flex-col gap-0.5">
              <span className="font-mono text-2xl text-foreground">
                {item.value}
              </span>
              <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                {item.label}
              </span>
              <span className="text-xs text-muted-foreground">
                {item.hint}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* 5 · 下一步 推荐动作 */}
      <section className="mt-12">
        <div className="mb-5 font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
          NEXT · 推荐动作
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {nextSteps.map((step) => (
            <Link key={step.href} href={step.href}>
              <div className="flex h-full flex-col gap-2 rounded-2xl border border-foreground/10 bg-card p-6 shadow-sm transition-colors hover:border-accent">
                <div className="font-serif text-lg">{step.title}</div>
                <p className="text-sm text-muted-foreground">{step.desc}</p>
              </div>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
