"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Asset,
  BrandRule,
  Evidence,
  TaskState,
} from "@brandai/contracts";
import type { AssetCategory } from "@brandai/contracts";
import { Button } from "@brandai/ui";
import {
  BookOpenText,
  Download,
  FileText,
  Image as ImageIcon,
  MessageCircle,
  Minus,
  MoreHorizontal,
  Palette,
  Plus,
  Type as TypeIcon,
  Upload,
  X,
  ZoomIn,
} from "lucide-react";
import { apiFetch, assetThumbUrl } from "@/lib/client";
import { imageUploadLimitError } from "@/lib/upload-limits";
import { useBrand } from "../brand-context";
import { Chip } from "../_ui";

// §2.2 — bounded intermediate state; mirror the workspace page's POLL_CAP.
const POLL_CAP_MS = 6 * 60 * 1000;
const POLL_INTERVAL_MS = 2500;

const BRAND_KIT_IMPORT_SLOTS: {
  key: string;
  type: string;
  title: string;
  desc: string;
  accept: string;
  limit: string;
}[] = [
  {
    key: "logo",
    type: "logo",
    title: "logo",
    desc: "上传主标、反白标、图形标等，确认后成为 logo 使用规范。",
    accept: "image/*",
    limit: "建议最多 10 个",
  },
  {
    key: "font",
    type: "font",
    title: "字体",
    desc: "上传字体说明截图或字体规范页，AI 提取字体使用边界。",
    accept: "image/*",
    limit: "建议最多 50 个",
  },
  {
    key: "color",
    type: "color",
    title: "颜色",
    desc: "上传色卡、色值页或视觉样张，AI 提炼主辅色与禁用色。",
    accept: "image/*",
    limit: "建议最多 50 个",
  },
  {
    key: "layout",
    type: "layout",
    title: "设计指南",
    desc: "上传版式、网格、留白和组件规范页，提取设计使用边界。",
    accept: "image/*,application/pdf",
    limit: "图片或 PDF",
  },
  {
    key: "imagery",
    type: "imagery",
    title: "图像",
    desc: "上传参考图、摄影风格或素材规范，沉淀图像风格规则。",
    accept: "image/*",
    limit: "建议最多 50 个",
  },
  {
    key: "copy",
    type: "copy",
    title: "品牌指南",
    desc: "上传语气、文案、禁用表达等页面，形成品牌表达规范。",
    accept: "image/*,application/pdf",
    limit: "图片 8MB / PDF 不限",
  },
];

/**
 * P03 · 品牌套件 — 把品牌规则沉淀为 AI 可调用的结构化知识。真实数据：
 * GET/POST/PATCH /api/workspaces/[wsId]/rules。已确认(CONFIRMED)的规则会在
 * 工作台出图时被 worker 加载用于受控生成。
 *
 * D4–D10 · 品牌套件 6 个维度从「通用规则卡」恢复为 RICH 结构化卡：
 * logo→do/don't，字体→字族预览，颜色→真实色块，设计指南/图像→结构化要点，
 * 品牌指南→禁用词。
 * 所有字段访问都对 value 缺字段降级（fall back 到 summary），绝不崩。
 */
const TYPE_META: Record<
  string,
  { label: string; short: string; icon: string }
> = {
  logo: { label: "logo", short: "logo", icon: "◐" },
  font: { label: "字体", short: "字体", icon: "Aa" },
  color: { label: "颜色", short: "颜色", icon: "◉" },
  layout: { label: "设计指南", short: "设计指南", icon: "▤" },
  imagery: { label: "图像", short: "图像", icon: "▦" },
  copy: { label: "品牌指南", short: "品牌指南", icon: "❝" },
  graphic: { label: "设计元素", short: "设计", icon: "✦" },
};
/** 卡片分组顺序（让品牌套件 6 个维度固定展示而非平铺列表）。 */
const CATEGORY_ORDER: string[] = [
  "logo",
  "font",
  "color",
  "layout",
  "imagery",
  "copy",
];
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
      if (typeof v === "string" && isHex(v))
        eat(v, roleMap[k.toLowerCase()] ?? k);
    }
  }
  return out;
}

function colorRestrictions(value: Val): string[] {
  const colorSystem = value.colorSystem;
  if (!colorSystem || typeof colorSystem !== "object") return [];
  return asArr((colorSystem as Val).restrictions)
    .map((item) => asStr(item))
    .filter((item): item is string => !!item);
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
      if (name)
        out.push({ name, ...(asStr(o.role) ? { role: asStr(o.role)! } : {}) });
    }
  });
  return out;
}
/** 把 serif/sans 这类抽象族名映射到可预览的 CSS font-family。 */
function previewFamily(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("serif") && !n.includes("sans"))
    return "Georgia, 'Noto Serif SC', serif";
  if (n === "sans" || n.includes("sans")) return "Inter, system-ui, sans-serif";
  if (n.includes("mono")) return "ui-monospace, monospace";
  return `'${name}', Inter, system-ui, sans-serif`;
}

function extractTone(value: Val): { tone: string | null; banned: string[] } {
  const tone =
    asStr(value.tone) ?? asStr(value.voice) ?? asStr(value.style) ?? null;
  const banned = [
    ...asArr(value.forbidden),
    ...asArr(value.banned),
    ...asArr(value["禁用词"]),
    ...asArr(value.bannedWords),
  ]
    .map((item) => asStr(item))
    .filter((item): item is string => !!item);
  return { tone, banned };
}

function extractLogo(value: Val): {
  dos: string[];
  donts: string[];
  minSize: string | null;
  safeSpace: string | null;
} {
  const list = (keys: string[]) =>
    keys
      .flatMap((key) => asArr(value[key]))
      .map((item) => asStr(item))
      .filter((item): item is string => !!item);
  return {
    dos: list(["dos", "do", "allowed"]),
    donts: list(["donts", "dont", "forbidden", "prohibited"]),
    minSize: asStr(value.minSize) ?? asStr(value.minWidth),
    safeSpace: asStr(value.safeSpace) ?? asStr(value.clearSpace),
  };
}

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
  const output: { label: string; text: string }[] = [];
  for (const [key, raw] of Object.entries(value)) {
    if (key === "colorSystem") continue;
    const label = KEY_LABELS[key] ?? key;
    if (typeof raw === "string" && raw.trim()) {
      output.push({ label, text: raw.trim() });
    } else if (typeof raw === "number" || typeof raw === "boolean") {
      output.push({ label, text: String(raw) });
    } else if (Array.isArray(raw)) {
      const items = raw
        .map((item) => asStr(item))
        .filter((item): item is string => !!item);
      if (items.length) output.push({ label, text: items.join("、") });
    }
  }
  return output;
}

// ── presentational bits ──────────────────────────────────────────────────────

function StrengthBadge({ strength }: { strength: string }) {
  const m = STRENGTH_META[strength] ?? STRENGTH_META.WEAK!;
  return (
    <span
      className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${m.cls}`}
    >
      {m.label}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === "CONFIRMED") {
    return (
      <span className="rounded-full bg-success/10 px-2.5 py-0.5 text-[11px] font-medium text-success">
        已启用
      </span>
    );
  }
  if (status === "REJECTED") {
    return (
      <span className="rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
        已禁用
      </span>
    );
  }
  return (
    <span className="rounded-full bg-warning/10 px-2.5 py-0.5 text-[11px] font-medium text-warning">
      草稿
    </span>
  );
}

function EvidenceChip({ note }: { note?: string }) {
  return (
    <span
      title={note}
      className="max-w-[220px] truncate rounded-full border border-border bg-muted px-3 py-1 text-xs text-muted-foreground"
    >
      {note ?? "📄 文件"}
    </span>
  );
}

function EvidenceItem({ wsId, ev }: { wsId: string; ev: Evidence }) {
  const [failed, setFailed] = useState(false);
  // note-only evidence (no assetId) → text chip.
  if (!ev.assetId) return ev.note ? <EvidenceChip note={ev.note} /> : null;
  const rawUrl = assetThumbUrl(wsId, ev.assetId, ev.thumbnailUrl ?? "");
  // assetId may point at a NON-image asset (e.g. a parse-manual VI_DOC/PDF whose
  // id is stamped onto evidence) → the <img> 404s/decodes-empty; fall back to a
  // file/note chip instead of a broken thumbnail.
  if (failed)
    return (
      <a href={rawUrl} target="_blank" rel="noreferrer">
        <EvidenceChip note={ev.note ? `📄 ${ev.note}` : "📄 文件"} />
      </a>
    );
  return (
    <a href={rawUrl} target="_blank" rel="noreferrer">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={rawUrl}
        alt={ev.note ?? "依据"}
        title={ev.note ?? "点击预览"}
        onError={() => setFailed(true)}
        className="h-12 w-12 rounded-xl border border-border object-cover transition-transform hover:scale-105"
      />
    </a>
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
  // K4 — evidence may be note-only (no assetId) from VLM recognition; PDF-manual
  // evidence carries a non-image assetId. EvidenceItem handles both.
  const shown = evidence.filter((ev) => ev?.assetId || ev?.note).slice(0, 4);
  if (!shown.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      {shown.map((ev, i) => (
        <EvidenceItem
          key={`${ev.assetId ?? "note"}-${i}`}
          wsId={wsId}
          ev={ev}
        />
      ))}
    </div>
  );
}

function RulePreviewImage({
  wsId,
  ev,
  compact = false,
}: {
  wsId: string;
  ev: Evidence;
  compact?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  if (!ev.assetId || failed) return null;
  const rawUrl = assetThumbUrl(wsId, ev.assetId, ev.thumbnailUrl ?? "");
  return (
    <a
      href={rawUrl}
      target="_blank"
      rel="noreferrer"
      className={`group flex overflow-hidden rounded-[18px] bg-muted/50 ${
        compact ? "h-16 w-20" : "aspect-square w-full"
      }`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={rawUrl}
        alt={ev.note ?? "品牌资产"}
        title={ev.note ?? "点击预览"}
        onError={() => setFailed(true)}
        className="h-full w-full object-contain p-3 transition-transform group-hover:scale-[1.03]"
      />
    </a>
  );
}

function BrandAssetPlaceholder({
  type,
  label,
}: {
  type: string;
  label: string;
}) {
  return (
    <div className="flex aspect-square w-full flex-col items-center justify-center rounded-[18px] border border-dashed border-border bg-muted/35 text-center">
      <span className="text-2xl text-muted-foreground">
        {type === "font" ? "Aa" : type === "color" ? "◉" : "+"}
      </span>
      <span className="mt-2 px-3 text-[11px] text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

function RuleVisualPreview({ rule, wsId }: { rule: BrandRule; wsId: string }) {
  const value = (rule.value ?? {}) as Val;
  const evidence = (rule.evidence ?? []).filter((ev) => ev?.assetId);

  if (rule.type === "color") {
    const swatches = extractSwatches(value);
    if (!swatches.length) return null;
    return (
      <div className="grid grid-cols-3 gap-2">
        {swatches.slice(0, 3).map((sw, i) => (
          <div key={`${sw.hex}-${i}`} className="min-w-0">
            <div
              className="aspect-square rounded-[18px] border border-border"
              style={{ background: sw.hex }}
            />
            <div className="mt-1 truncate font-mono text-[10px] uppercase text-muted-foreground">
              {sw.role ?? sw.hex}
            </div>
          </div>
        ))}
        <button
          type="button"
          className="flex aspect-square items-center justify-center rounded-[18px] border border-dashed border-border text-xl text-muted-foreground"
          aria-label="增加颜色"
        >
          +
        </button>
      </div>
    );
  }

  if (rule.type === "font") {
    const imgs = evidence.slice(0, 2);
    const fonts = extractFonts(value);
    return (
      <div className="grid grid-cols-3 gap-2">
        {imgs.map((ev, i) => (
          <div key={`${ev.assetId}-${i}`} className="min-w-0">
            <RulePreviewImage wsId={wsId} ev={ev} />
            <div className="mt-1 truncate text-[10px] text-muted-foreground">
              {ev.note ?? "字体参考"}
            </div>
          </div>
        ))}
        {!imgs.length && fonts.length
          ? fonts.slice(0, 2).map((font, i) => (
              <div key={`${font.name}-${i}`} className="min-w-0">
                <div className="flex aspect-square flex-col justify-center rounded-[18px] bg-muted/45 px-3">
                  <span
                    className="text-3xl leading-none text-foreground"
                    style={{ fontFamily: previewFamily(font.name) }}
                  >
                    Ag
                  </span>
                  <span className="mt-2 line-clamp-2 text-[10px] text-muted-foreground">
                    {font.name}
                  </span>
                </div>
                <div className="mt-1 truncate text-[10px] text-muted-foreground">
                  {font.role ?? "字体"}
                </div>
              </div>
            ))
          : null}
        <BrandAssetPlaceholder type="font" label="增加字体" />
      </div>
    );
  }

  if (rule.type === "logo" || rule.type === "imagery") {
    const imgs = evidence.slice(0, 2);
    return (
      <div className="grid grid-cols-3 gap-2">
        {imgs.map((ev, i) => (
          <div key={`${ev.assetId}-${i}`} className="min-w-0">
            <RulePreviewImage wsId={wsId} ev={ev} />
            <div className="mt-1 truncate text-[10px] text-muted-foreground">
              {ev.note ?? (rule.type === "logo" ? "Logo" : "图像")}
            </div>
          </div>
        ))}
        {imgs.length === 0 ? (
          <BrandAssetPlaceholder
            type={rule.type}
            label={rule.type === "logo" ? "等待 logo 图片" : "等待图像"}
          />
        ) : null}
        <BrandAssetPlaceholder
          type={rule.type}
          label={rule.type === "logo" ? "增加 Logo" : "增加图像"}
        />
      </div>
    );
  }

  const first = evidence[0];
  if (!first) return null;
  return (
    <div className="flex gap-2">
      {evidence.slice(0, 3).map((ev, i) => (
        <RulePreviewImage
          key={`${ev.assetId}-${i}`}
          wsId={wsId}
          ev={ev}
          compact
        />
      ))}
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
    <p className="text-xs leading-relaxed text-muted-foreground">
      {rule.summary}
    </p>
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
                <span className="text-[10px] text-muted-foreground">
                  {sw.role}
                </span>
              ) : null}
            </div>
          ))}
        </div>
        {restrictions.length ? (
          <ul className="mt-0.5 flex flex-col gap-1">
            {restrictions.map((r, i) => (
              <li
                key={i}
                className="flex gap-1.5 text-[11px] text-muted-foreground"
              >
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
              <span
                key={i}
                className="flex gap-1.5 text-[11px] text-foreground/80"
              >
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
              <span
                key={i}
                className="flex gap-1.5 text-[11px] text-foreground/80"
              >
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
                <span className="text-[10px] text-muted-foreground">
                  {f.role}
                </span>
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
            <SubHeading>语气</SubHeading>
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
  onEdit,
  onToggle,
  onDelete,
  onPreview,
  busy,
}: {
  rule: BrandRule;
  wsId: string;
  onEdit: (rule: BrandRule) => void;
  onToggle: (rule: BrandRule) => void;
  onDelete: (rule: BrandRule) => void;
  onPreview: (input: { src: string; alt: string }) => void;
  busy: boolean;
}) {
  const value = (rule.value ?? {}) as Val;
  const evidence = (rule.evidence ?? []).find((item) => item.assetId);
  const previewUrl = evidence?.assetId
    ? assetThumbUrl(wsId, evidence.assetId, evidence.thumbnailUrl ?? "")
    : null;
  const swatch = rule.type === "color" ? extractSwatches(value)[0] : null;
  const font = rule.type === "font" ? extractFonts(value)[0] : null;
  return (
    <div className="group relative w-[148px] shrink-0">
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          if (previewUrl) {
            onPreview({ src: previewUrl, alt: evidence?.note ?? rule.summary });
          } else {
            onEdit(rule);
          }
        }}
        className="flex aspect-[4/3] w-full cursor-pointer items-center justify-center overflow-hidden rounded-xl border border-border bg-muted/45 transition-colors duration-200 hover:border-primary/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60"
      >
        {previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={previewUrl}
            alt={evidence?.note ?? rule.summary}
            className="h-full w-full object-contain p-3"
          />
        ) : swatch ? (
          <span
            className="h-full w-full"
            style={{ backgroundColor: swatch.hex }}
          />
        ) : font ? (
          <span
            className="text-4xl text-foreground"
            style={{ fontFamily: previewFamily(font.name) }}
          >
            Ag
          </span>
        ) : (
          <span className="flex flex-col items-center gap-2 px-4 text-center text-muted-foreground">
            <ImportSlotIcon type={rule.type} />
            <span className="line-clamp-2 text-[10px] leading-relaxed">
              {rule.summary}
            </span>
          </span>
        )}
      </button>
      <div className="mt-1.5 flex min-w-0 items-center gap-1.5">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            rule.status === "CONFIRMED" ? "bg-success" : "bg-muted-foreground"
          }`}
          title={rule.status === "CONFIRMED" ? "已启用" : "未启用"}
        />
        <span className="truncate text-[10px] text-muted-foreground">
          {evidence?.note ?? rule.summary}
        </span>
      </div>
      <details className="absolute right-1 top-1 z-20">
        <summary className="flex h-8 w-8 cursor-pointer list-none items-center justify-center rounded-lg bg-background/85 text-muted-foreground opacity-0 shadow-sm backdrop-blur transition-opacity hover:text-foreground focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 group-hover:opacity-100">
          <MoreHorizontal className="h-4 w-4" />
          <span className="sr-only">规则操作</span>
        </summary>
        <div className="absolute right-0 top-9 w-28 overflow-hidden rounded-xl border border-border bg-card py-1 text-xs shadow-[0_14px_36px_rgba(30,30,60,0.18)]">
          <button
            type="button"
            disabled={busy}
            onClick={() => onEdit(rule)}
            className="h-9 w-full cursor-pointer px-3 text-left transition-colors hover:bg-muted disabled:opacity-60"
          >
            编辑
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onToggle(rule)}
            className="h-9 w-full cursor-pointer px-3 text-left transition-colors hover:bg-muted disabled:opacity-60"
          >
            {rule.status === "CONFIRMED" ? "禁用" : "启用"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onDelete(rule)}
            className="h-9 w-full cursor-pointer px-3 text-left text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-60"
          >
            删除
          </button>
        </div>
      </details>
    </div>
  );
}

// ── AI recognize / parse-manual flow ─────────────────────────────────────────

type StartResponse = { jobId?: string; taskId: string; status: string };

/** Local dismissable modal shell (mirrors the campaigns ModalShell idiom). */
function ModalShell({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-[28px] border border-border bg-card shadow-[0_24px_70px_rgba(124,92,255,0.18)]"
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
          <div>
            <h3 className="text-lg font-semibold">{title}</h3>
            {subtitle ? (
              <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
            ) : null}
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function RuleEditorDialog({
  rule,
  saving,
  onClose,
  onSave,
}: {
  rule: BrandRule;
  saving: boolean;
  onClose: () => void;
  onSave: (input: {
    summary: string;
    strength: BrandRule["strength"];
    value: Record<string, unknown>;
  }) => void;
}) {
  const [summary, setSummary] = useState(rule.summary);
  const [strength, setStrength] = useState<BrandRule["strength"]>(
    rule.strength,
  );
  const [valueText, setValueText] = useState(() =>
    JSON.stringify(rule.value ?? {}, null, 2),
  );
  const [error, setError] = useState<string | null>(null);

  function save() {
    let value: unknown;
    try {
      value = JSON.parse(valueText);
    } catch {
      setError("补充信息需要是有效的 JSON 对象。");
      return;
    }
    if (!value || Array.isArray(value) || typeof value !== "object") {
      setError("补充信息需要是 JSON 对象。");
      return;
    }
    if (!summary.trim()) {
      setError("规则说明不能为空。");
      return;
    }
    onSave({
      summary: summary.trim(),
      strength,
      value: value as Record<string, unknown>,
    });
  }

  return (
    <ModalShell
      title={`编辑${TYPE_META[rule.type]?.label ?? "品牌规则"}`}
      subtitle="修改后保存即可更新该品牌套件；禁用的内容也可以先编辑，再重新启用。"
      onClose={onClose}
    >
      <div className="flex flex-col gap-4 overflow-y-auto px-6 py-5">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium">规则说明</span>
          <textarea
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            rows={4}
            className="resize-y rounded-lg border border-border bg-background p-3 text-sm outline-none focus:border-primary/40"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium">约束强度</span>
          <select
            value={strength}
            onChange={(event) =>
              setStrength(event.target.value as BrandRule["strength"])
            }
            className="h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary/40"
          >
            <option value="WEAK">弱约束</option>
            <option value="STRONG">强约束</option>
            <option value="FORBIDDEN">禁用约束</option>
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium">补充结构化信息</span>
          <textarea
            value={valueText}
            onChange={(event) => setValueText(event.target.value)}
            rows={8}
            spellCheck={false}
            className="resize-y rounded-lg border border-border bg-background p-3 font-mono text-xs outline-none focus:border-primary/40"
          />
        </label>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}

/** Progress strip for a running AI task (PENDING/RUNNING + bounded timeout). */
function TaskProgress({
  status,
  progress,
  timedOut,
  error,
  isManual,
}: {
  status: string | null;
  progress: number;
  timedOut: boolean;
  error?: string | null;
  isManual: boolean;
}) {
  let label = "处理中…";
  if (timedOut) label = "处理超时";
  else if (status === "FAILED") label = "处理失败";
  else if (status === "PENDING") label = "文件已上传，等待开始解析…";
  else if (status === "RUNNING" && isManual && progress < 50)
    label = "正在逐页读取文字、版式和图片…";
  else if (status === "RUNNING" && isManual && progress < 72)
    label = "正在提取 Logo、色卡、字体和视觉素材…";
  else if (status === "RUNNING" && isManual)
    label = "正在整理六类品牌套件草稿…";
  else if (status === "RUNNING") label = "AI 正在分析素材…";
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-primary/15 bg-accent-soft/40 px-4 py-3">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-primary">{label}</span>
        <span className="text-muted-foreground">{Math.round(progress)}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-gradient-to-r from-primary to-accent transition-all"
          style={{ width: `${Math.max(4, Math.min(100, progress))}%` }}
        />
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function BrandKitImportPanel({
  disabled,
  onSelectType,
  onManualFile,
}: {
  disabled: boolean;
  onSelectType: (type: string) => void;
  onManualFile: (file: File) => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);

  function pick(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    onManualFile(file);
  }

  return (
    <section className="mx-auto flex w-full max-w-[560px] flex-col items-center text-left">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          开始使用你的品牌套件
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          添加 logo、字体、颜色等内容，让后续创作始终保持一致。
        </p>
      </div>
      <div className="mt-7 w-full">
        <div className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3">
          {BRAND_KIT_IMPORT_SLOTS.map((slot) => {
            return (
              <button
                key={slot.key}
                type="button"
                disabled={disabled}
                onClick={() => onSelectType(slot.type)}
                className="group cursor-pointer text-left focus-visible:outline-none disabled:opacity-60"
              >
                <span className="flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-xl border border-border bg-muted/55 text-muted-foreground transition-colors duration-200 group-hover:border-primary/35 group-hover:bg-accent-soft group-hover:text-primary group-focus-visible:ring-2 group-focus-visible:ring-primary/40">
                  <ImportSlotIcon type={slot.type} />
                </span>
                <span className="mt-1.5 block text-xs font-medium text-foreground">
                  {slot.title}
                </span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            if (!disabled) fileRef.current?.click();
          }}
          onDragEnter={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            pick(event.dataTransfer.files);
          }}
          className={`mt-6 flex min-h-[94px] w-full cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed px-5 py-4 text-center transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 ${
            dragging
              ? "border-primary bg-accent-soft"
              : "border-border bg-muted/25 hover:border-primary/45 hover:bg-accent-soft/35"
          } disabled:opacity-60`}
        >
          <Upload className="h-4 w-4 text-muted-foreground" />
          <span className="mt-2 text-xs font-medium">
            上传完整品牌手册，自动填充全部内容
          </span>
          <span className="mt-1 text-[10px] text-muted-foreground">
            PDF · 上传后自动解析文字、页面和图片
          </span>
        </button>
        <div className="mt-4 flex items-center gap-3 text-[10px] text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          或
          <span className="h-px flex-1 bg-border" />
        </div>
        <p className="mt-3 text-center text-[11px] text-muted-foreground">
          还没有品牌素材？也可以从上方任一分类开始创建。
        </p>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="application/pdf"
        className="hidden"
        onChange={(event) => {
          pick(event.currentTarget.files);
          event.currentTarget.value = "";
        }}
      />
    </section>
  );
}

function ImportSlotIcon({ type }: { type: string }) {
  if (type === "font") return <TypeIcon className="h-11 w-11" />;
  if (type === "color") return <Palette className="h-11 w-11" />;
  if (type === "layout") return <MessageCircle className="h-11 w-11" />;
  if (type === "imagery") return <ImageIcon className="h-11 w-11" />;
  if (type === "copy") return <BookOpenText className="h-11 w-11" />;
  return (
    <span className="flex h-14 w-14 items-center justify-center rounded-full border-2 border-current">
      <span className="text-base font-semibold">Lo</span>
    </span>
  );
}

function CompactManualImport({
  disabled,
  onFile,
}: {
  disabled: boolean;
  onFile: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <div className="w-full rounded-xl bg-muted/45 px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground">
            <FileText className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-xs font-medium">
              一次上传，构建完整品牌套件
            </p>
            <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
              上传品牌 PDF，自动提取 Logo、颜色、字体等信息
            </p>
          </div>
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          className="flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-xs font-medium transition-colors hover:border-primary/35 hover:bg-accent-soft disabled:opacity-60"
        >
          <Upload className="h-3.5 w-3.5" />
          从文件中提取
        </button>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        className="hidden"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) onFile(file);
          event.currentTarget.value = "";
        }}
      />
    </div>
  );
}

function SlotUploadDialog({
  slot,
  disabled,
  onClose,
  onFile,
}: {
  slot: (typeof BRAND_KIT_IMPORT_SLOTS)[number];
  disabled: boolean;
  onClose: () => void;
  onFile: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <ModalShell
      title={`添加你的品牌 ${slot.title}`}
      subtitle={slot.desc}
      onClose={onClose}
    >
      <div className="px-6 py-5">
        <button
          type="button"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          className="flex aspect-[4/3] w-36 cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/35 text-muted-foreground transition-colors hover:border-primary/45 hover:bg-accent-soft hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60"
        >
          <Plus className="h-5 w-5" />
          <span className="mt-2 text-[10px]">添加文件</span>
        </button>
        <p className="mt-4 text-[11px] text-muted-foreground">{slot.limit}</p>
        <input
          ref={inputRef}
          type="file"
          accept={slot.accept}
          className="hidden"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (file) onFile(file);
            event.currentTarget.value = "";
          }}
        />
      </div>
      <div className="flex justify-end border-t border-border px-6 py-4">
        <Button variant="outline" onClick={onClose} disabled={disabled}>
          取消
        </Button>
      </div>
    </ModalShell>
  );
}

/**
 * D13/D14 · AI 识别 modal — multi-select (recognize, images) or single-select
 * (parse-manual, VI_DOC). Server-authoritative: POST → 202 {taskId} → poll
 * GET /tasks/[taskId] every 2.5s, bounded to 6 min, invalidate rules on success.
 */
function RecognizeModal({
  wsId,
  mode,
  onClose,
  onDone,
}: {
  wsId: string;
  mode: "recognize" | "parse-manual";
  onClose: () => void;
  onDone: () => void;
}) {
  const multi = mode === "recognize";
  const [selected, setSelected] = useState<string[]>([]);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const startedAt = useRef(0);

  const { data: assets = [], isLoading } = useQuery({
    queryKey: ["brandai-assets", wsId, mode],
    queryFn: () =>
      apiFetch<Asset[]>(
        // parse-manual only accepts VI_DOC assets; recognize takes images.
        multi
          ? `/api/workspaces/${wsId}/assets`
          : `/api/workspaces/${wsId}/assets?category=VI_DOC&libraryKind=ALL`,
      ),
  });
  const pickable = multi
    ? assets.filter((a) => a.mimeType.startsWith("image/"))
    : assets;

  const start = useMutation({
    mutationFn: () => {
      startedAt.current = Date.now();
      setTimedOut(false);
      return apiFetch<StartResponse>(
        multi
          ? `/api/workspaces/${wsId}/rules/recognize`
          : `/api/workspaces/${wsId}/rules/parse-manual`,
        {
          method: "POST",
          body: JSON.stringify(
            multi ? { assetIds: selected } : { assetId: selected[0] },
          ),
        },
      );
    },
    onSuccess: (res) => setTaskId(res.taskId),
  });

  const { data: task } = useQuery<TaskState>({
    queryKey: ["brandai-task", wsId, taskId],
    queryFn: () =>
      apiFetch<TaskState>(`/api/workspaces/${wsId}/tasks/${taskId}`),
    enabled: !!taskId,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      if (s === "SUCCEEDED" || s === "FAILED") return false;
      if (Date.now() - startedAt.current > POLL_CAP_MS) return false;
      return POLL_INTERVAL_MS;
    },
  });

  // bounded-state guard — flip to timed-out so the spinner can't run forever.
  useEffect(() => {
    if (!taskId) return;
    const t = setInterval(() => {
      if (Date.now() - startedAt.current > POLL_CAP_MS) setTimedOut(true);
    }, 3000);
    return () => clearInterval(t);
  }, [taskId]);

  const status = task?.status ?? (taskId ? "PENDING" : null);
  const running =
    !!taskId && status !== "SUCCEEDED" && status !== "FAILED" && !timedOut;

  // Fire onDone exactly ONCE per successful task. The parent passes a fresh
  // inline callback each render, so depending on `onDone` identity would
  // re-invalidate (→ refetch → re-render → loop) while the success modal stays
  // open. Keep the latest callback in a ref and guard by the task id.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const firedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (status === "SUCCEEDED" && taskId && firedForRef.current !== taskId) {
      firedForRef.current = taskId;
      onDoneRef.current();
    }
  }, [status, taskId]);

  function toggle(id: string) {
    if (running) return;
    setSelected((prev) =>
      multi
        ? prev.includes(id)
          ? prev.filter((x) => x !== id)
          : [...prev, id]
        : [id],
    );
  }

  function reset() {
    setTaskId(null);
    setTimedOut(false);
    start.reset();
  }

  const failed = status === "FAILED" || timedOut;

  return (
    <ModalShell
      title={multi ? "从素材识别品牌规则" : "解析 VI 手册 / PDF"}
      subtitle={
        multi
          ? "选择品牌素材图，AI 将提取 logo、字体、颜色等规则草稿。"
          : "选择一份 VI 手册（PDF），AI 将解析为结构化规则草稿。"
      }
      onClose={onClose}
    >
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {status === "SUCCEEDED" ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-success/10 text-2xl text-success">
              ✓
            </span>
            <p className="text-sm font-medium">
              识别完成，新增 {task?.refCount ?? 0} 条规则草稿
            </p>
            <p className="text-xs text-muted-foreground">
              请在下方知识库中查看并「确认采用」。
            </p>
          </div>
        ) : taskId ? (
          <div className="flex flex-col gap-4">
            <TaskProgress
              status={status}
              progress={task?.progress ?? 0}
              timedOut={timedOut}
              isManual={mode === "parse-manual"}
              error={
                failed
                  ? timedOut
                    ? "处理超时，可能仍在后台运行，请稍后刷新页面或重试。"
                    : (task?.error ?? "AI 处理失败，请重试。")
                  : null
              }
            />
            {failed ? (
              <Button variant="outline" onClick={reset} className="self-start">
                重试
              </Button>
            ) : null}
          </div>
        ) : isLoading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            加载素材…
          </p>
        ) : pickable.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {multi
              ? "素材库还没有可识别的图片。先去素材库上传品牌素材。"
              : "素材库还没有 VI 手册（PDF）。先去素材库上传 VI 文档。"}
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
            {pickable.map((a) => {
              const on = selected.includes(a.id);
              const isImg = a.mimeType.startsWith("image/");
              // P1.3 — assets the workspace marked unavailable / deprecated can't
              // feed recognition (the recognize route filters them server-side),
              // so gray them out + disable selection here too.
              const usable =
                a.availableForGeneration !== false && !a.deprecatedAt;
              return (
                <button
                  key={a.id}
                  type="button"
                  aria-pressed={on}
                  disabled={!usable}
                  title={usable ? undefined : "该素材已停用，不能用于识别"}
                  onClick={() => usable && toggle(a.id)}
                  className={`group relative flex aspect-square flex-col items-center justify-center gap-1 overflow-hidden rounded-2xl border text-center transition-colors ${
                    !usable
                      ? "cursor-not-allowed border-border bg-muted/40 opacity-40 grayscale"
                      : on
                        ? "border-primary bg-accent-soft ring-2 ring-primary"
                        : "border-border bg-muted/40 hover:border-primary/40"
                  }`}
                >
                  {isImg ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={assetThumbUrl(wsId, a.id, a.url)}
                      alt={a.fileName}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <>
                      <span className="text-2xl text-primary">▦</span>
                      <span className="line-clamp-2 px-2 text-[10px] text-muted-foreground">
                        {a.fileName}
                      </span>
                    </>
                  )}
                  {on ? (
                    <span className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[11px] text-primary-foreground">
                      ✓
                    </span>
                  ) : null}
                  {!usable ? (
                    <span className="absolute left-1.5 top-1.5 rounded-full bg-foreground/70 px-1.5 py-0.5 text-[9px] font-medium text-background">
                      已停用
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {status !== "SUCCEEDED" && !taskId ? (
        <div className="flex items-center justify-between gap-3 border-t border-border px-6 py-4">
          <span className="text-xs text-muted-foreground">
            已选 {selected.length} 项
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button
              disabled={selected.length === 0 || start.isPending}
              onClick={() => start.mutate()}
            >
              {start.isPending ? "提交中…" : multi ? "开始识别" : "开始解析"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
          <Button variant="outline" onClick={onClose}>
            {status === "SUCCEEDED"
              ? "完成"
              : running
                ? "后台运行并关闭"
                : "关闭"}
          </Button>
        </div>
      )}
      {start.isError ? (
        <p className="px-6 pb-4 text-xs text-destructive">
          {(start.error as Error).message}
        </p>
      ) : null}
    </ModalShell>
  );
}

/**
 * D1 · AI 共创输入区 —— 真 AI 解析。统一 AI 输入框（AIInput, 32px 圆角）承载两条
 * 真实路径：
 *   1) 文本 + 类型 → POST /rules（一条结构化规则草稿，非 AI 的人工录入，诚实标注）。
 *   2) 附件（图片 / PDF）→ 直传 POST /assets/upload → 图片走识别、PDF 走手册解析，
 *      都异步产出可编辑的 DRAFT 规则预览（202+poll，§2）。
 * 语音入口（Web Speech API）把口述转写进文本框，喂给路径 1。
 */
function AICoCreate({
  wsId,
  suggestedType,
  hasContent,
  onSuggestionHandled,
}: {
  wsId: string;
  suggestedType?: string | null;
  hasContent: boolean;
  onSuggestionHandled?: () => void;
}) {
  const qc = useQueryClient();
  const [type, setType] = useState("copy");
  const [uploadType, setUploadType] = useState<string | null>(null);
  // parse-manual async task (from an attached PDF)
  const [taskId, setTaskId] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const [attachErr, setAttachErr] = useState<string | null>(null);
  const [lastUpload, setLastUpload] = useState<{
    name: string;
    isPdf: boolean;
  } | null>(null);
  const startedAt = useRef(0);

  useEffect(() => {
    if (suggestedType && TYPE_META[suggestedType]) {
      setType(suggestedType);
      setUploadType(suggestedType);
      onSuggestionHandled?.();
    }
  }, [onSuggestionHandled, suggestedType]);

  // One knowledge input accepts a written rule, an image, or a PDF. The asset
  // stays in this workspace, then AI turns it into draft rule previews.
  const analyzeAttachment = useMutation({
    mutationFn: async (file: File) => {
      setAttachErr(null);
      setTimedOut(false);
      const isPdf =
        file.type === "application/pdf" ||
        file.name.toLowerCase().endsWith(".pdf");
      setLastUpload({ name: file.name, isPdf });
      const imageErr = imageUploadLimitError(file);
      if (imageErr) throw new Error(imageErr);
      const imageCategory: Record<string, AssetCategory> = {
        logo: "LOGO",
        color: "OTHER",
        font: "OTHER",
        layout: "KV",
        imagery: "KV",
        graphic: "PRODUCT",
        copy: "OTHER",
      };
      const fd = new FormData();
      fd.append("file", file);
      fd.append(
        "category",
        isPdf ? "VI_DOC" : (imageCategory[type] ?? "OTHER"),
      );
      fd.append("libraryKind", "BRAND_KIT");
      const upRes = await fetch(`/api/workspaces/${wsId}/assets/upload`, {
        method: "POST",
        body: fd,
      });
      if (!upRes.ok) {
        const b = (await upRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? "上传失败");
      }
      const asset = (await upRes.json()) as Asset;
      startedAt.current = Date.now();
      return apiFetch<StartResponse>(
        isPdf
          ? `/api/workspaces/${wsId}/rules/parse-manual`
          : `/api/workspaces/${wsId}/rules/recognize`,
        {
          method: "POST",
          body: JSON.stringify(
            isPdf ? { assetId: asset.id } : { assetIds: [asset.id] },
          ),
        },
      );
    },
    onSuccess: (res) => setTaskId(res.taskId),
    onError: (e) => setAttachErr(e instanceof Error ? e.message : "解析失败"),
  });

  const { data: task } = useQuery<TaskState>({
    queryKey: ["brandai-task", wsId, taskId],
    queryFn: () =>
      apiFetch<TaskState>(`/api/workspaces/${wsId}/tasks/${taskId}`),
    enabled: !!taskId,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      if (s === "SUCCEEDED" || s === "FAILED") return false;
      if (Date.now() - startedAt.current > POLL_CAP_MS) return false;
      return POLL_INTERVAL_MS;
    },
  });

  useEffect(() => {
    if (!taskId) return;
    const t = setInterval(() => {
      if (Date.now() - startedAt.current > POLL_CAP_MS) setTimedOut(true);
    }, 3000);
    return () => clearInterval(t);
  }, [taskId]);

  useEffect(() => {
    setTaskId(null);
    setTimedOut(false);
    setAttachErr(null);
    setLastUpload(null);
    setUploadType(null);
  }, [wsId]);

  const status = task?.status ?? (taskId ? "PENDING" : null);
  const running =
    !!taskId && status !== "SUCCEEDED" && status !== "FAILED" && !timedOut;

  // refresh rules once when a parse task succeeds.
  const firedFor = useRef<string | null>(null);
  useEffect(() => {
    if (status === "SUCCEEDED" && taskId && firedFor.current !== taskId) {
      firedFor.current = taskId;
      qc.invalidateQueries({ queryKey: ["brandai-rules", wsId] });
    }
  }, [status, taskId, qc, wsId]);

  const parsing = analyzeAttachment.isPending || running;
  const activeSlot = BRAND_KIT_IMPORT_SLOTS.find(
    (slot) => slot.type === uploadType,
  );

  return (
    <>
      {hasContent ? (
        <CompactManualImport
          disabled={parsing}
          onFile={(file) => {
            setType("layout");
            analyzeAttachment.mutate(file);
          }}
        />
      ) : (
        <BrandKitImportPanel
          disabled={parsing}
          onSelectType={(nextType) => {
            setType(nextType);
            setUploadType(nextType);
          }}
          onManualFile={(file) => {
            setType("layout");
            analyzeAttachment.mutate(file);
          }}
        />
      )}

      {activeSlot ? (
        <SlotUploadDialog
          slot={activeSlot}
          disabled={parsing}
          onClose={() => setUploadType(null)}
          onFile={(file) => {
            analyzeAttachment.mutate(file);
            setUploadType(null);
          }}
        />
      ) : null}

      {/* Unified image/PDF analysis progress, §2.3 observable. */}
      {taskId || analyzeAttachment.isPending ? (
        <div className="mx-auto mt-3 max-w-2xl">
          {status === "SUCCEEDED" ? (
            <div
              className={`rounded-2xl border px-4 py-3 text-left text-sm ${
                (task?.refCount ?? 0) > 0
                  ? "border-success/20 bg-success/5 text-success"
                  : "border-border bg-muted/40 text-muted-foreground"
              }`}
            >
              {(task?.refCount ?? 0) > 0
                ? `“${lastUpload?.name ?? "上传内容"}”已解析完成，生成 ${task?.refCount ?? 0} 条规则草稿。请在下方逐项核对并启用，启用后将自动约束当前品牌下的项目生成。`
                : `“${lastUpload?.name ?? "上传内容"}”已解析完成，但没有识别到可用的品牌规则。请检查 PDF 是否清晰、是否包含品牌规范页后重试。`}
            </div>
          ) : (
            <TaskProgress
              status={analyzeAttachment.isPending ? "PENDING" : status}
              progress={task?.progress ?? (analyzeAttachment.isPending ? 5 : 0)}
              timedOut={timedOut}
              isManual={lastUpload?.isPdf ?? false}
              error={
                timedOut
                  ? "解析超时，可能仍在后台运行，请稍后刷新页面。"
                  : status === "FAILED"
                    ? (task?.error ?? "AI 解析失败，请重试。")
                    : null
              }
            />
          )}
        </div>
      ) : null}

      {attachErr ? (
        <p className="mt-2 text-sm text-destructive">{attachErr}</p>
      ) : null}
    </>
  );
}

function BrandKitLightbox({
  preview,
  onClose,
}: {
  preview: { src: string; alt: string } | null;
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState(100);

  useEffect(() => {
    if (!preview) return;
    setZoom(100);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "+" || event.key === "=") {
        setZoom((current) => Math.min(200, current + 25));
      }
      if (event.key === "-") {
        setZoom((current) => Math.max(50, current - 25));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [preview, onClose]);

  if (!preview) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`预览${preview.alt}`}
      onClick={onClose}
      className="fixed inset-0 z-[70] flex items-center justify-center overflow-auto bg-foreground/85 p-8 backdrop-blur-sm"
    >
      <button
        type="button"
        aria-label="关闭预览"
        onClick={onClose}
        className="fixed right-5 top-5 flex h-11 w-11 cursor-pointer items-center justify-center rounded-full bg-background/10 text-background transition-colors hover:bg-background/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-background/70"
      >
        <X className="h-5 w-5" />
      </button>
      <div className="flex min-h-full min-w-full items-center justify-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={preview.src}
          alt={preview.alt}
          style={{ transform: `scale(${zoom / 100})` }}
          onClick={(event) => event.stopPropagation()}
          className="max-h-[72vh] max-w-[78vw] rounded-sm bg-card object-contain shadow-2xl transition-transform duration-200"
        />
      </div>
      <div
        className="fixed bottom-5 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-foreground/90 p-1.5 text-background shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          aria-label="缩小"
          onClick={() => setZoom((current) => Math.max(50, current - 25))}
          className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full hover:bg-background/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-background/70"
        >
          <Minus className="h-4 w-4" />
        </button>
        <span className="w-12 text-center text-[11px]">{zoom}%</span>
        <button
          type="button"
          aria-label="放大"
          onClick={() => setZoom((current) => Math.min(200, current + 25))}
          className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full hover:bg-background/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-background/70"
        >
          <ZoomIn className="h-4 w-4" />
        </button>
        <span className="mx-1 h-5 w-px bg-background/20" />
        <a
          href={preview.src}
          download
          aria-label="下载图片"
          className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full hover:bg-background/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-background/70"
        >
          <Download className="h-4 w-4" />
        </a>
      </div>
    </div>
  );
}

export default function BrandKnowledgePage() {
  const { wsId, brandName, brands, updateBrand } = useBrand();
  const qc = useQueryClient();
  const [suggestedType, setSuggestedType] = useState<string | null>(null);
  const [editingRule, setEditingRule] = useState<BrandRule | null>(null);
  const [preview, setPreview] = useState<{ src: string; alt: string } | null>(
    null,
  );

  const { data: rules = [], isLoading } = useQuery({
    queryKey: ["brandai-rules", wsId],
    queryFn: () => apiFetch<BrandRule[]>(`/api/workspaces/${wsId}/rules`),
  });

  const updateRule = useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: Record<string, unknown>;
    }) =>
      apiFetch<BrandRule>(`/api/workspaces/${wsId}/rules/${id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["brandai-rules", wsId] });
      qc.invalidateQueries({ queryKey: ["brandai-knowledge-overview"] });
    },
  });
  const deleteRule = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ ok: true }>(`/api/workspaces/${wsId}/rules/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["brandai-rules", wsId] });
      qc.invalidateQueries({ queryKey: ["brandai-knowledge-overview"] });
    },
  });

  useEffect(() => {
    setEditingRule(null);
    setSuggestedType(null);
    setPreview(null);
  }, [wsId]);

  const confirmedCount = rules.filter((r) => r.status === "CONFIRMED").length;
  const activeBrand = brands.find((brand) => brand.id === wsId);
  const kitEnabled = !activeBrand?.tags?.includes("__kb_disabled");

  // group rules by the six rigid dimensions so every brand kit always shows the same
  // skeleton, even before a dimension has any rules.
  const grouped = ["layout", "copy", "logo", "color", "font", "imagery"].map(
    (cat) => ({
      cat,
      meta: TYPE_META[cat]!,
      items: rules.filter((r) => r.type === cat),
    }),
  );
  // any rule whose type isn't in CATEGORY_ORDER (defensive)
  const others = rules.filter((r) => !CATEGORY_ORDER.includes(r.type));

  const busy = updateRule.isPending || deleteRule.isPending;
  const toggleRule = (rule: BrandRule) =>
    updateRule.mutate({
      id: rule.id,
      patch: {
        status: rule.status === "CONFIRMED" ? "REJECTED" : "CONFIRMED",
      },
    });
  const removeRule = (rule: BrandRule) => {
    if (window.confirm(`删除「${rule.summary}」？此操作不可恢复。`)) {
      deleteRule.mutate(rule.id);
    }
  };

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        加载品牌套件…
      </div>
    );
  }

  if (rules.length === 0) {
    return (
      <div className="flex min-h-screen items-center justify-center px-8 py-12">
        <AICoCreate wsId={wsId} hasContent={false} />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[820px] px-8 pb-20 pt-9">
      <header className="relative flex min-h-11 items-center justify-center">
        <div className="text-center">
          <h1 className="text-xl font-semibold tracking-tight">{brandName}</h1>
          <p className="mt-1 text-[10px] text-muted-foreground">
            已收录 {rules.length} 项内容 · {confirmedCount} 项已启用
          </p>
        </div>
        <label className="absolute right-0 flex cursor-pointer items-center gap-2 text-[11px] text-muted-foreground">
          应用到新项目
          <span className="relative inline-flex">
            <input
              type="checkbox"
              checked={kitEnabled}
              onChange={(event) =>
                void updateBrand(wsId, { disabled: !event.target.checked })
              }
              className="peer sr-only"
            />
            <span className="h-5 w-9 rounded-full bg-muted-foreground/35 transition-colors peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-primary/40 peer-focus-visible:ring-offset-2" />
            <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-card shadow-sm transition-transform peer-checked:translate-x-4" />
          </span>
        </label>
      </header>

      <div id="knowledge-source" className="mt-5">
        <AICoCreate
          wsId={wsId}
          suggestedType={suggestedType}
          hasContent
          onSuggestionHandled={() => setSuggestedType(null)}
        />
      </div>

      {editingRule ? (
        <RuleEditorDialog
          rule={editingRule}
          saving={updateRule.isPending}
          onClose={() => setEditingRule(null)}
          onSave={(patch) =>
            updateRule.mutate(
              { id: editingRule.id, patch },
              { onSuccess: () => setEditingRule(null) },
            )
          }
        />
      ) : null}

      <div className="mt-9 flex flex-col gap-8">
        {grouped.map((group) => {
          const guidance = group.cat === "layout" || group.cat === "copy";
          return (
            <section key={group.cat}>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-xs font-medium">{group.meta.label}</h2>
                <span className="text-[10px] text-muted-foreground">
                  {group.items.length} 项
                </span>
              </div>
              {guidance ? (
                <div className="rounded-xl bg-muted/45 p-4">
                  {group.items.length ? (
                    <div className="max-h-36 space-y-3 overflow-y-auto pr-2">
                      {group.items.map((rule) => (
                        <button
                          key={rule.id}
                          type="button"
                          onClick={() => setEditingRule(rule)}
                          className="block w-full cursor-pointer text-left text-xs leading-relaxed text-foreground/80 transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                        >
                          {rule.summary}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      暂无{group.meta.label}
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={() => setSuggestedType(group.cat)}
                    className="mt-3 flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-dashed border-border px-3 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    添加{group.meta.label}
                  </button>
                </div>
              ) : (
                <div className="flex flex-wrap gap-3">
                  {group.items.map((rule) => (
                    <RuleCard
                      key={rule.id}
                      rule={rule}
                      wsId={wsId}
                      busy={busy}
                      onEdit={setEditingRule}
                      onToggle={toggleRule}
                      onDelete={removeRule}
                      onPreview={setPreview}
                    />
                  ))}
                  <button
                    type="button"
                    aria-label={`添加${group.meta.label}`}
                    onClick={() => setSuggestedType(group.cat)}
                    className="flex aspect-[4/3] w-[148px] cursor-pointer items-center justify-center rounded-xl border border-dashed border-border text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent-soft hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  >
                    <Plus className="h-5 w-5" />
                  </button>
                </div>
              )}
            </section>
          );
        })}

        {others.length ? (
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xs font-medium">其他</h2>
              <span className="text-[10px] text-muted-foreground">
                {others.length} 项
              </span>
            </div>
            <div className="flex flex-wrap gap-3">
              {others.map((rule) => (
                <RuleCard
                  key={rule.id}
                  rule={rule}
                  wsId={wsId}
                  busy={busy}
                  onEdit={setEditingRule}
                  onToggle={toggleRule}
                  onDelete={removeRule}
                  onPreview={setPreview}
                />
              ))}
            </div>
          </section>
        ) : null}
      </div>

      <div className="mt-12 flex justify-center">
        <Link
          href="/campaigns"
          className="flex h-11 items-center justify-center rounded-xl bg-foreground px-5 text-xs font-medium text-background transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2"
        >
          使用此套件创建项目
        </Link>
      </div>

      <BrandKitLightbox preview={preview} onClose={() => setPreview(null)} />
    </div>
  );
}
