"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BrandRule, Evidence } from "@brandai/contracts";
import { apiFetch, assetThumbUrl } from "@/lib/client";
import { useBrand } from "../brand-context";
import { Chip } from "../_ui";

/**
 * P03 · 品牌知识库 — 把品牌规则沉淀为 AI 可调用的结构化知识。真实数据：
 * GET/POST/PATCH /api/workspaces/[wsId]/rules。已确认(CONFIRMED)的规则会在
 * 工作台出图时被 worker 加载用于受控生成。
 *
 * D4–D10 · 8 类知识从「通用规则卡」恢复为 RICH 结构化卡：色彩→真实色块，
 * Logo→do/don't，字体→字族预览，语调→禁用词，视觉/版式/设计→结构化要点。
 * 所有字段访问都对 value 缺字段降级（fall back 到 summary），绝不崩。
 */
const TYPE_META: Record<string, { label: string; short: string; icon: string }> = {
  logo: { label: "Logo 使用规范", short: "Logo", icon: "◐" },
  color: { label: "品牌色彩系统", short: "色彩", icon: "◉" },
  font: { label: "字体规范", short: "字体", icon: "Aa" },
  copy: { label: "品牌语气 / 文案", short: "语调", icon: "❝" },
  imagery: { label: "视觉参考", short: "视觉", icon: "▦" },
  layout: { label: "版式规范", short: "版式", icon: "▤" },
  graphic: { label: "设计元素", short: "设计", icon: "✦" },
};
/** 卡片分组顺序（让 8 类读成结构化知识库而非平铺列表）。 */
const CATEGORY_ORDER: string[] = [
  "color",
  "logo",
  "font",
  "copy",
  "imagery",
  "layout",
  "graphic",
];
const TYPE_OPTIONS = Object.entries(TYPE_META).map(([value, m]) => ({
  value,
  label: m.label,
}));

const STRENGTH_META: Record<string, { label: string; cls: string }> = {
  STRONG: { label: "强约束", cls: "bg-accent-soft text-primary" },
  WEAK: { label: "弱约束", cls: "bg-muted text-muted-foreground" },
  FORBIDDEN: { label: "禁用", cls: "bg-destructive/10 text-destructive" },
};

// ── value-shape helpers (tolerate absence / several shapes, never throw) ──────

type Val = Record<string, unknown>;

function asStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function asArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function isHex(s: string): boolean {
  return /^#?[0-9a-fA-F]{3,8}$/.test(s.trim());
}
function normHex(s: string): string {
  const t = s.trim();
  return t.startsWith("#") ? t : `#${t}`;
}

type Swatch = { hex: string; role?: string; label?: string };

/**
 * 从 color rule 的 value 抽出色块。容忍多形态：
 *   value.palette: ["#aaa", …]            （recognize/parse-manual 主路径）
 *   value.colors:  ["#aaa", …] | [{hex, role}]
 *   value.colorSystem.palette: [...]      （recognize 把 colorSystem 挂第一条 color rule）
 *   裸 hex 值散落在 value 顶层字段（如 {primary:"#..."}）
 */
function extractSwatches(value: Val): Swatch[] {
  const out: Swatch[] = [];
  const seen = new Set<string>();
  const push = (hex: string, role?: string) => {
    const h = normHex(hex).toLowerCase();
    if (seen.has(h)) return;
    seen.add(h);
    out.push({ hex: normHex(hex), ...(role ? { role } : {}) });
  };
  const eat = (raw: unknown, role?: string) => {
    if (typeof raw === "string" && isHex(raw)) push(raw, role);
    else if (raw && typeof raw === "object") {
      const o = raw as Val;
      const hex = asStr(o.hex) ?? asStr(o.color) ?? asStr(o.value);
      const r = asStr(o.role) ?? asStr(o.name) ?? role;
      if (hex && isHex(hex)) push(hex, r ?? undefined);
    }
  };
  // palette / colors arrays
  asArr(value.palette).forEach((c) => eat(c));
  asArr(value.colors).forEach((c) => eat(c));
  // colorSystem.palette (recognize report payload)
  const cs = value.colorSystem;
  if (cs && typeof cs === "object") {
    asArr((cs as Val).palette).forEach((c) => eat(c));
  }
  // role-keyed top-level hex (primary / secondary / accent / neutral …)
  if (out.length === 0) {
    const roleMap: Record<string, string> = {
      primary: "主",
      main: "主",
      secondary: "辅",
      accent: "点缀",
      neutral: "中性",
    };
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "string" && isHex(v)) eat(v, roleMap[k.toLowerCase()] ?? k);
    }
  }
  return out;
}

/** colorSystem 报告里的限制条款（若存在）。 */
function colorRestrictions(value: Val): string[] {
  const cs = value.colorSystem;
  if (cs && typeof cs === "object") {
    return asArr((cs as Val).restrictions)
      .map((r) => asStr(r))
      .filter((s): s is string => !!s);
  }
  return [];
}

/** font 字族预览：display/body 或 fontFamily/families 数组。 */
function extractFonts(value: Val): { name: string; role?: string }[] {
  const out: { name: string; role?: string }[] = [];
  const disp = asStr(value.display);
  const body = asStr(value.body);
  if (disp) out.push({ name: disp, role: "标题" });
  if (body) out.push({ name: body, role: "正文" });
  const ff = asStr(value.fontFamily) ?? asStr(value.family);
  if (ff) out.push({ name: ff });
  asArr(value.families).forEach((f) => {
    if (typeof f === "string" && f.trim()) out.push({ name: f.trim() });
    else if (f && typeof f === "object") {
      const o = f as Val;
      const name = asStr(o.name) ?? asStr(o.family);
      if (name) out.push({ name, ...(asStr(o.role) ? { role: asStr(o.role)! } : {}) });
    }
  });
  return out;
}
/** 把 serif/sans 这类抽象族名映射到可预览的 CSS font-family。 */
function previewFamily(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("serif") && !n.includes("sans")) return "Georgia, 'Noto Serif SC', serif";
  if (n === "sans" || n.includes("sans")) return "Inter, system-ui, sans-serif";
  if (n.includes("mono")) return "ui-monospace, monospace";
  return `'${name}', Inter, system-ui, sans-serif`;
}

/** copy 语调：tone + 禁用词列表（容忍 forbidden/banned/禁用词）。 */
function extractTone(value: Val): { tone: string | null; banned: string[] } {
  const tone =
    asStr(value.tone) ?? asStr(value.voice) ?? asStr(value.style) ?? null;
  const banned = [
    ...asArr(value.forbidden),
    ...asArr(value.banned),
    ...asArr((value as Val)["禁用词"]),
    ...asArr(value.bannedWords),
  ]
    .map((w) => asStr(w))
    .filter((s): s is string => !!s);
  return { tone, banned };
}

/** logo 结构化 do / don't / 尺寸 / 安全间距。 */
function extractLogo(value: Val): {
  dos: string[];
  donts: string[];
  minSize: string | null;
  safeSpace: string | null;
} {
  const list = (k: string[]) =>
    k
      .flatMap((key) => asArr((value as Val)[key]))
      .map((x) => asStr(x))
      .filter((s): s is string => !!s);
  return {
    dos: list(["dos", "do", "allowed"]),
    donts: list(["donts", "dont", "forbidden", "prohibited"]),
    minSize: asStr(value.minSize) ?? asStr(value.minWidth),
    safeSpace: asStr(value.safeSpace) ?? asStr(value.clearSpace),
  };
}

/** imagery/layout/graphic 等：把 value 的标量字段铺成「键 · 值」要点。 */
const KEY_LABELS: Record<string, string> = {
  lighting: "光线",
  depth: "景深",
  grid: "网格",
  clearSpace: "安全间距",
  safeSpace: "安全间距",
  composition: "构图",
  mood: "氛围",
  style: "风格",
  texture: "质感",
  alignment: "对齐",
  spacing: "间距",
  shape: "形状",
};
function genericBullets(value: Val): { label: string; text: string }[] {
  const out: { label: string; text: string }[] = [];
  for (const [k, v] of Object.entries(value)) {
    if (k === "colorSystem") continue; // report payload, not a display bullet
    const label = KEY_LABELS[k] ?? k;
    if (typeof v === "string" && v.trim()) out.push({ label, text: v.trim() });
    else if (typeof v === "number" || typeof v === "boolean")
      out.push({ label, text: String(v) });
    else if (Array.isArray(v)) {
      const items = v.map((x) => asStr(x)).filter((s): s is string => !!s);
      if (items.length) out.push({ label, text: items.join("、") });
    }
  }
  return out;
}

// ── presentational bits ──────────────────────────────────────────────────────

function StrengthBadge({ strength }: { strength: string }) {
  const m = STRENGTH_META[strength] ?? STRENGTH_META.WEAK!;
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${m.cls}`}>
      {m.label}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  return status === "CONFIRMED" ? (
    <span className="rounded-full bg-success/10 px-2.5 py-0.5 text-[11px] font-medium text-success">
      已确认
    </span>
  ) : (
    <span className="rounded-full bg-warning/10 px-2.5 py-0.5 text-[11px] font-medium text-warning">
      草稿
    </span>
  );
}

function EvidenceThumbs({
  wsId,
  evidence,
}: {
  wsId: string;
  evidence: Evidence[];
}) {
  if (!evidence?.length) return null;
  return (
    <div className="flex flex-wrap gap-2 pt-1">
      {evidence.slice(0, 4).map((ev, i) => {
        if (!ev?.assetId) return null;
        return (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={`${ev.assetId}-${i}`}
            src={assetThumbUrl(wsId, ev.assetId, ev.thumbnailUrl ?? "")}
            alt={ev.note ?? "依据"}
            title={ev.note ?? undefined}
            className="h-12 w-12 rounded-xl border border-border object-cover"
          />
        );
      })}
    </div>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </span>
  );
}

/** 单条规则的 RICH body —— 按 type 渲染，缺字段降级到 summary。 */
function RuleBody({ rule }: { rule: BrandRule }) {
  const value = (rule.value ?? {}) as Val;
  const summary = (
    <p className="text-xs leading-relaxed text-muted-foreground">{rule.summary}</p>
  );

  if (rule.type === "color") {
    const swatches = extractSwatches(value);
    const restrictions = colorRestrictions(value);
    if (!swatches.length) return summary;
    return (
      <div className="flex flex-col gap-2.5">
        {summary}
        <div className="flex flex-wrap gap-2">
          {swatches.map((sw, i) => (
            <div
              key={`${sw.hex}-${i}`}
              className="flex items-center gap-2 rounded-full border border-border bg-muted/50 py-1 pl-1 pr-2.5"
            >
              <span
                className="h-6 w-6 rounded-full border border-border"
                style={{ background: sw.hex }}
              />
              <span className="font-mono text-[11px] uppercase text-foreground">
                {sw.hex}
              </span>
              {sw.role ? (
                <span className="text-[10px] text-muted-foreground">{sw.role}</span>
              ) : null}
            </div>
          ))}
        </div>
        {restrictions.length ? (
          <ul className="mt-0.5 flex flex-col gap-1">
            {restrictions.map((r, i) => (
              <li key={i} className="flex gap-1.5 text-[11px] text-muted-foreground">
                <span className="text-primary">·</span>
                {r}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }

  if (rule.type === "logo") {
    const { dos, donts, minSize, safeSpace } = extractLogo(value);
    if (!dos.length && !donts.length && !minSize && !safeSpace) return summary;
    return (
      <div className="flex flex-col gap-2.5">
        {summary}
        {dos.length ? (
          <div className="flex flex-col gap-1">
            <SubHeading>推荐</SubHeading>
            {dos.map((d, i) => (
              <span key={i} className="flex gap-1.5 text-[11px] text-foreground/80">
                <span className="text-success">✓</span>
                {d}
              </span>
            ))}
          </div>
        ) : null}
        {donts.length ? (
          <div className="flex flex-col gap-1">
            <SubHeading>禁止</SubHeading>
            {donts.map((d, i) => (
              <span key={i} className="flex gap-1.5 text-[11px] text-foreground/80">
                <span className="text-destructive">✕</span>
                {d}
              </span>
            ))}
          </div>
        ) : null}
        {minSize || safeSpace ? (
          <div className="flex flex-wrap gap-2 pt-0.5">
            {minSize ? <Chip>最小尺寸 {minSize}</Chip> : null}
            {safeSpace ? <Chip>安全间距 {safeSpace}</Chip> : null}
          </div>
        ) : null}
      </div>
    );
  }

  if (rule.type === "font") {
    const fonts = extractFonts(value);
    if (!fonts.length) return summary;
    return (
      <div className="flex flex-col gap-2.5">
        {summary}
        <div className="flex flex-col gap-2">
          {fonts.map((f, i) => (
            <div
              key={`${f.name}-${i}`}
              className="rounded-2xl border border-border bg-muted/40 px-3 py-2"
            >
              {f.role ? (
                <span className="text-[10px] text-muted-foreground">{f.role}</span>
              ) : null}
              <div
                className="text-lg leading-tight text-foreground"
                style={{ fontFamily: previewFamily(f.name) }}
              >
                {f.name} · Aa 字体预览
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (rule.type === "copy") {
    const { tone, banned } = extractTone(value);
    if (!tone && !banned.length) return summary;
    return (
      <div className="flex flex-col gap-2.5">
        {summary}
        {tone ? (
          <div className="flex items-center gap-2">
            <SubHeading>语调</SubHeading>
            <span className="rounded-full bg-accent-soft px-2.5 py-0.5 text-[11px] text-primary">
              {tone}
            </span>
          </div>
        ) : null}
        {banned.length ? (
          <div className="flex flex-col gap-1">
            <SubHeading>禁用词</SubHeading>
            <div className="flex flex-wrap gap-1.5">
              {banned.map((w, i) => (
                <span
                  key={i}
                  className="rounded-full bg-destructive/10 px-2.5 py-0.5 text-[11px] text-destructive line-through"
                >
                  {w}
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  // imagery / layout / graphic — structured bullets
  const bullets = genericBullets(value);
  if (!bullets.length) return summary;
  return (
    <div className="flex flex-col gap-2.5">
      {summary}
      <ul className="flex flex-col gap-1.5">
        {bullets.map((b, i) => (
          <li key={i} className="flex gap-2 text-[11px] text-foreground/80">
            <span className="shrink-0 rounded-md bg-accent-soft px-1.5 py-0.5 text-[10px] text-primary">
              {b.label}
            </span>
            <span className="leading-relaxed">{b.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RuleCard({
  rule,
  wsId,
  onConfirm,
  confirming,
}: {
  rule: BrandRule;
  wsId: string;
  onConfirm: (id: string) => void;
  confirming: boolean;
}) {
  const meta = TYPE_META[rule.type] ?? { label: rule.type, short: rule.type, icon: "✦" };
  return (
    <div className="flex flex-col gap-3 rounded-3xl border border-border bg-card p-5 shadow-[0_8px_24px_rgba(30,30,60,0.06)]">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-2xl bg-accent-soft text-base text-primary">
            {meta.icon}
          </span>
          <span className="text-[15px] font-semibold">{meta.label}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <StrengthBadge strength={rule.strength} />
          <StatusBadge status={rule.status} />
        </div>
      </div>

      <RuleBody rule={rule} />

      <EvidenceThumbs wsId={wsId} evidence={rule.evidence ?? []} />

      {rule.status !== "CONFIRMED" ? (
        <button
          disabled={confirming}
          onClick={() => onConfirm(rule.id)}
          className="mt-auto self-start rounded-full border border-primary/30 px-3 py-1 text-xs text-primary transition-colors hover:bg-accent-soft disabled:opacity-60"
        >
          确认采用
        </button>
      ) : null}
    </div>
  );
}

export default function BrandKnowledgePage() {
  const { wsId, brandName } = useBrand();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [type, setType] = useState("copy");

  const { data: rules = [], isLoading } = useQuery({
    queryKey: ["brandai-rules", wsId],
    queryFn: () => apiFetch<BrandRule[]>(`/api/workspaces/${wsId}/rules`),
  });

  const add = useMutation({
    mutationFn: () =>
      apiFetch<BrandRule>(`/api/workspaces/${wsId}/rules`, {
        method: "POST",
        body: JSON.stringify({ type, summary: text.trim(), value: {} }),
      }),
    onSuccess: () => {
      setText("");
      qc.invalidateQueries({ queryKey: ["brandai-rules", wsId] });
    },
  });

  const confirm = useMutation({
    mutationFn: (id: string) =>
      apiFetch<BrandRule>(`/api/workspaces/${wsId}/rules/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "CONFIRMED" }),
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["brandai-rules", wsId] }),
  });

  const confirmedCount = rules.filter((r) => r.status === "CONFIRMED").length;

  // group rules by category so the 8 categories read as a structured KB
  const grouped = CATEGORY_ORDER.map((cat) => ({
    cat,
    meta: TYPE_META[cat]!,
    items: rules.filter((r) => r.type === cat),
  })).filter((g) => g.items.length > 0);
  // any rule whose type isn't in CATEGORY_ORDER (defensive)
  const others = rules.filter((r) => !CATEGORY_ORDER.includes(r.type));

  return (
    <div className="mx-auto max-w-[1180px] px-10 py-10">
      <section className="text-center">
        <h1 className="text-[34px] font-semibold tracking-tight">
          AI 助手 · 共创你的品牌知识库
        </h1>
        <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">
          沉淀「{brandName}」的品牌规范，确认后的规则会在每次出图时被自动应用。
        </p>
        <div className="mx-auto mt-6 flex max-w-2xl flex-col gap-3 rounded-[28px] border border-primary/15 bg-card p-4 shadow-[0_24px_70px_rgba(124,92,255,0.12)]">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            placeholder="输入一条品牌规则，如：主色为紫色 #7C5CFF，禁止改色或描边…"
            className="min-h-[52px] w-full resize-none border-0 bg-transparent px-2 py-1 text-sm outline-none placeholder:text-muted-foreground"
          />
          <div className="flex items-center justify-between gap-3">
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="h-10 rounded-2xl border border-border bg-background px-3 text-sm outline-none"
            >
              {TYPE_OPTIONS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            <button
              disabled={!text.trim() || add.isPending}
              onClick={() => add.mutate()}
              className="h-10 shrink-0 rounded-[16px] bg-gradient-to-br from-primary to-accent px-6 text-sm font-medium text-primary-foreground shadow-[0_12px_28px_rgba(124,92,255,0.26)] disabled:opacity-60"
            >
              {add.isPending ? "添加中…" : "添加规则"}
            </button>
          </div>
        </div>
        {add.isError ? (
          <p className="mt-2 text-sm text-destructive">
            {(add.error as Error).message}
          </p>
        ) : null}
      </section>

      <section className="mt-10 grid grid-cols-3 gap-3.5 lg:grid-cols-6">
        {Object.entries(TYPE_META).map(([key, m]) => (
          <a
            key={key}
            href="/assets"
            className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border bg-card p-4 text-center transition-colors hover:border-primary/40 hover:bg-accent-soft/40"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-accent-soft text-lg text-primary">
              {m.icon}
            </span>
            <span className="text-xs font-medium">{m.short}</span>
            <span className="text-[10px] text-muted-foreground">上传资料</span>
          </a>
        ))}
      </section>

      <section className="mt-12">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-2xl font-semibold">品牌核心知识</h2>
          <span className="text-xs text-muted-foreground">
            共 {rules.length} 条 · 已确认 {confirmedCount} 条
          </span>
        </div>

        {isLoading ? (
          <div className="rounded-3xl border border-border bg-card p-12 text-center text-sm text-muted-foreground">
            加载中…
          </div>
        ) : rules.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-border bg-card p-12 text-center text-sm text-muted-foreground">
            还没有品牌规则。在上方输入第一条，AI 出图时即可遵循它。
          </div>
        ) : (
          <div className="flex flex-col gap-10">
            {grouped.map((g) => (
              <div key={g.cat}>
                <div className="mb-3 flex items-center gap-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-accent-soft text-sm text-primary">
                    {g.meta.icon}
                  </span>
                  <h3 className="text-base font-semibold">{g.meta.label}</h3>
                  <span className="text-[11px] text-muted-foreground">
                    {g.items.length} 条
                  </span>
                </div>
                <div className="grid gap-[18px] md:grid-cols-2 lg:grid-cols-3">
                  {g.items.map((r) => (
                    <RuleCard
                      key={r.id}
                      rule={r}
                      wsId={wsId}
                      confirming={confirm.isPending}
                      onConfirm={(id) => confirm.mutate(id)}
                    />
                  ))}
                </div>
              </div>
            ))}
            {others.length ? (
              <div>
                <div className="mb-3 flex items-center gap-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-accent-soft text-sm text-primary">
                    ✦
                  </span>
                  <h3 className="text-base font-semibold">其他</h3>
                </div>
                <div className="grid gap-[18px] md:grid-cols-2 lg:grid-cols-3">
                  {others.map((r) => (
                    <RuleCard
                      key={r.id}
                      rule={r}
                      wsId={wsId}
                      confirming={confirm.isPending}
                      onConfirm={(id) => confirm.mutate(id)}
                    />
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </section>

      <section className="mt-12 rounded-3xl border border-primary/15 bg-gradient-to-br from-accent-soft/70 to-card p-7 shadow-[0_8px_24px_rgba(30,30,60,0.06)]">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-card text-sm text-primary">
            ✦
          </span>
          <span className="text-sm font-semibold">AI 知识摘要 · {brandName}</span>
        </div>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-foreground/80">
          {rules.length === 0
            ? "尚未沉淀品牌规则。建议先确认色彩、字体、Logo 与品牌语气，AI 出图会据此受控生成。"
            : `已沉淀 ${rules.length} 条品牌规则（${confirmedCount} 条已确认并生效）。已确认规则会在工作台每次出图时由 worker 加载，确保结果遵循品牌规范。`}
        </p>
        {rules.length > 0 ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {Array.from(
              new Set(rules.map((r) => TYPE_META[r.type]?.label ?? r.type)),
            ).map((k) => (
              <Chip key={k}>{k}</Chip>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}
