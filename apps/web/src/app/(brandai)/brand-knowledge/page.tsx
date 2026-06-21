"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Asset,
  BrandRule,
  Evidence,
  Generation,
  TaskState,
} from "@brandai/contracts";
import type { AssetCategory } from "@brandai/contracts";
import { Button } from "@brandai/ui";
import { apiFetch, assetThumbUrl, CATEGORY_LABELS } from "@/lib/client";
import { useBrand } from "../brand-context";
import { Chip } from "../_ui";
import { AIInput } from "../ai-input";

// §2.2 — bounded intermediate state; mirror the workspace page's POLL_CAP.
const POLL_CAP_MS = 6 * 60 * 1000;
const POLL_INTERVAL_MS = 2500;

// D10 — generate-poll shape (mirrors the workspace page's JobState) for the
// brand-preview server-authoritative flow.
type JobState = {
  generation: Generation;
  job: {
    jobId: string;
    status: string;
    progress: number;
    failedReason?: string;
  };
};

// D2 · 快捷提示词 — pure client convenience, fills the rule textarea. text only.
const QUICK_PROMPTS: { type: string; text: string }[] = [
  { type: "color", text: "我们的主色是 #7C5CFF，辅助色是…，禁止使用其他高饱和色或描边。" },
  { type: "font", text: "标题字体用…，正文字体用…，禁止使用系统默认衬线体。" },
  { type: "copy", text: "品牌语气：专业而亲切、简洁有力；禁用词：最、第一、绝对。" },
  { type: "logo", text: "Logo 须保留四周安全间距，最小宽度 24px；禁止拉伸、改色或加阴影。" },
];

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

/**
 * D3 · 上传入口区 —— 6 类品牌资料的「真·分类上传」入口。每张卡映射到一个真实
 * AssetCategory（素材库唯一事实的分类枚举），点开 H5 上传弹窗（直传 →
 * POST /assets/upload，multipart）。色值/字体/文案这类「规范文档」没有对应的图片
 * 分类，落 VI_DOC（可被 parse-manual 真实解析）；诚实地标注每张卡上传后会发生什么。
 */
type UploadEntry = {
  key: string;
  label: string;
  icon: string;
  category: AssetCategory;
  accept: string;
  hint: string;
};
const UPLOAD_ENTRIES: UploadEntry[] = [
  { key: "logo", label: "Logo", icon: "◐", category: "LOGO", accept: "image/*,application/pdf", hint: "上传 Logo 文件，归入素材库 Logo 分类。" },
  { key: "desc", label: "品牌描述", icon: "❝", category: "VI_DOC", accept: "application/pdf", hint: "上传品牌描述 / VI 手册（PDF），可在上方用 AI 解析为规则。" },
  { key: "color", label: "色值规范", icon: "◉", category: "VI_DOC", accept: "application/pdf", hint: "上传色彩规范文档（PDF），可被 AI 解析为色彩规则。" },
  { key: "reference", label: "参考图", icon: "▦", category: "KV", accept: "image/*", hint: "上传视觉参考图，归入素材库主视觉分类，可用于「从素材识别」。" },
  { key: "material", label: "素材", icon: "✦", category: "PRODUCT", accept: "image/*", hint: "上传产品 / 通用素材图，归入素材库。" },
  { key: "copy", label: "文案规范", icon: "Aa", category: "VI_DOC", accept: "application/pdf", hint: "上传文案 / 语气规范（PDF），可被 AI 解析为语气规则。" },
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
  // assetId may point at a NON-image asset (e.g. a parse-manual VI_DOC/PDF whose
  // id is stamped onto evidence) → the <img> 404s/decodes-empty; fall back to a
  // file/note chip instead of a broken thumbnail.
  if (failed)
    return <EvidenceChip note={ev.note ? `📄 ${ev.note}` : "📄 文件"} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={assetThumbUrl(wsId, ev.assetId, ev.thumbnailUrl ?? "")}
      alt={ev.note ?? "依据"}
      title={ev.note ?? undefined}
      onError={() => setFailed(true)}
      className="h-12 w-12 rounded-xl border border-border object-cover"
    />
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
        <EvidenceItem key={`${ev.assetId ?? "note"}-${i}`} wsId={wsId} ev={ev} />
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

/**
 * H5 · 上传品牌资料弹窗 —— D3 的真上传入口。复用 ModalShell 弹窗范式，文件 +
 * 分类直传到现有 POST /api/workspaces/[wsId]/assets/upload（multipart），与素材库
 * 同一条上传管线。可预设分类（来自 D3 卡片），也允许在弹窗里改分类。
 */
function UploadDialog({
  wsId,
  entry,
  onClose,
  onUploaded,
}: {
  wsId: string;
  entry: UploadEntry;
  onClose: () => void;
  onUploaded: () => void;
}) {
  const [category, setCategory] = useState<AssetCategory>(entry.category);
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const accept = category === "VI_DOC" ? "application/pdf" : "image/*";

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("category", category);
      const res = await fetch(`/api/workspaces/${wsId}/assets/upload`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? "上传失败");
      }
      return (await res.json()) as Asset;
    },
    onSuccess: () => {
      onUploaded();
      onClose();
    },
  });

  return (
    <ModalShell
      title={`上传${entry.label}`}
      subtitle={entry.hint}
      onClose={onClose}
    >
      <div className="flex flex-col gap-4 px-6 py-5">
        <input
          ref={fileRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) {
              setFileName(f.name);
              upload.mutate(f);
            }
          }}
        />
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            分类
          </span>
          <select
            value={category}
            disabled={upload.isPending}
            onChange={(e) => setCategory(e.target.value as AssetCategory)}
            className="h-10 rounded-2xl border border-border bg-background px-3 text-sm outline-none"
          >
            {Object.entries(CATEGORY_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={upload.isPending}
          onClick={() => fileRef.current?.click()}
          className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-primary/30 bg-accent-soft/40 px-6 py-10 text-center transition-colors hover:border-primary/50 disabled:opacity-60"
        >
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-card text-2xl text-primary">
            {entry.icon}
          </span>
          <span className="text-sm font-medium">
            {upload.isPending
              ? `上传中…${fileName ? ` ${fileName}` : ""}`
              : "点击选择文件上传"}
          </span>
          <span className="text-xs text-muted-foreground">
            {category === "VI_DOC" ? "支持 PDF" : "支持图片"}
          </span>
        </button>
        {upload.isError ? (
          <p className="text-xs text-destructive">
            {(upload.error as Error).message}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <a
            href={`/assets?category=${entry.category}`}
            className="flex h-9 items-center rounded-full border border-border px-4 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
          >
            在素材库查看该分类
          </a>
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
}: {
  status: string | null;
  progress: number;
  timedOut: boolean;
  error?: string | null;
}) {
  const label =
    timedOut
      ? "处理超时"
      : status === "PENDING"
        ? "已受理，排队中…"
        : status === "RUNNING"
          ? "AI 正在分析素材…"
          : status === "FAILED"
            ? "处理失败"
            : "处理中…";
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
          : `/api/workspaces/${wsId}/assets?category=VI_DOC`,
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
    queryFn: () => apiFetch<TaskState>(`/api/workspaces/${wsId}/tasks/${taskId}`),
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
          ? "选择品牌素材图，AI 将提取色彩、Logo、字体等规则草稿。"
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
            {status === "SUCCEEDED" ? "完成" : running ? "后台运行并关闭" : "关闭"}
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
 * D10 · 生成品牌预览 — compose a brief from CONFIRMED brand knowledge and run it
 * through the EXISTING server-authoritative generate pipeline (POST
 * /brand-preview → 202 → poll GET /generations/[id]?jobId= → image surfaces).
 * Real provider → real image. Persists/shows the latest preview across refresh
 * via GET /brand-preview. §2: no synchronous AI; bounded client poll + exit.
 */
function BrandPreview({
  wsId,
  confirmedCount,
}: {
  wsId: string;
  confirmedCount: number;
}) {
  const qc = useQueryClient();
  const [genId, setGenId] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const startedAt = useRef(0);

  // Latest persisted preview (so a refresh still shows the most recent image).
  const { data: latest } = useQuery<{ generation: Generation | null }>({
    queryKey: ["brandai-brand-preview", wsId],
    queryFn: () =>
      apiFetch<{ generation: Generation | null }>(
        `/api/workspaces/${wsId}/brand-preview`,
      ),
  });

  const { data: poll } = useQuery<JobState>({
    queryKey: ["brandai-brand-preview-poll", wsId, genId, jobId],
    queryFn: () =>
      apiFetch<JobState>(
        // Only thread jobId when we actually have one — otherwise the GET route
        // gets the literal string "null" and can't match the live BullMQ job
        // (it still returns generation.status, so polling stays correct).
        `/api/workspaces/${wsId}/generations/${genId}${
          jobId ? `?jobId=${jobId}` : ""
        }`,
      ),
    enabled: !!genId,
    refetchInterval: (q) => {
      const s = q.state.data?.job?.status ?? q.state.data?.generation.status;
      if (s === "SUCCEEDED" || s === "FAILED") return false;
      if (Date.now() - startedAt.current > POLL_CAP_MS) return false;
      return POLL_INTERVAL_MS;
    },
  });

  useEffect(() => {
    if (!genId) return;
    const t = setInterval(() => {
      if (Date.now() - startedAt.current > POLL_CAP_MS) setTimedOut(true);
    }, 3000);
    return () => clearInterval(t);
  }, [genId]);

  const status = poll?.job?.status ?? poll?.generation.status ?? null;
  const running =
    !!genId && status !== "SUCCEEDED" && status !== "FAILED" && !timedOut;

  // On success, refresh the persisted-latest query so the new image sticks.
  const doneRef = useRef<string | null>(null);
  useEffect(() => {
    if (status === "SUCCEEDED" && genId && doneRef.current !== genId) {
      doneRef.current = genId;
      qc.invalidateQueries({ queryKey: ["brandai-brand-preview", wsId] });
    }
  }, [status, genId, wsId, qc]);

  const start = useMutation({
    mutationFn: () => {
      startedAt.current = Date.now();
      setTimedOut(false);
      setErr(null);
      return apiFetch<{ generation: Generation; jobId: string }>(
        `/api/workspaces/${wsId}/brand-preview`,
        { method: "POST", body: JSON.stringify({}) },
      );
    },
    onSuccess: (res) => {
      setGenId(res.generation.id);
      setJobId(res.jobId);
    },
    onError: (e) => setErr(e instanceof Error ? e.message : "生成失败"),
  });

  // The live image while polling, else the persisted latest.
  const liveImage = poll?.generation.versions?.[0]?.imageUrl;
  const latestImage = latest?.generation?.versions?.[0]?.imageUrl;
  const image = liveImage ?? latestImage ?? null;

  return (
    <section className="mt-12 rounded-3xl border border-primary/15 bg-card p-7 shadow-[0_8px_24px_rgba(30,30,60,0.06)]">
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-accent-soft text-sm text-primary">
              ✸
            </span>
            <h2 className="text-base font-semibold">品牌预览</h2>
          </div>
          <p className="mt-1.5 max-w-xl text-xs leading-relaxed text-muted-foreground">
            综合已确认的色彩 / 字体 / 语气 / 视觉规则，由真实 AI provider 合成一张
            代表品牌整体调性的预览主视觉（受品牌约束）。
          </p>
        </div>
        <button
          type="button"
          onClick={() => start.mutate()}
          disabled={start.isPending || running || confirmedCount === 0}
          title={
            confirmedCount === 0 ? "请先确认至少一条品牌规则" : undefined
          }
          className="h-10 shrink-0 self-start rounded-[16px] bg-gradient-to-br from-primary to-accent px-5 text-sm font-medium text-primary-foreground shadow-[0_12px_28px_rgba(124,92,255,0.26)] disabled:opacity-60"
        >
          {running
            ? "生成中…"
            : start.isPending
              ? "提交中…"
              : image
                ? "重新生成预览"
                : "生成品牌预览"}
        </button>
      </div>

      <div className="mt-5 flex min-h-[220px] items-center justify-center overflow-hidden rounded-2xl border border-border bg-background p-4">
        {timedOut && status !== "SUCCEEDED" ? (
          <div className="text-center">
            <p className="text-sm text-warning">生成超时</p>
            <p className="mt-1 text-xs text-muted-foreground">
              可能仍在后台处理或已失败，请点「重新生成预览」重试。
            </p>
          </div>
        ) : status === "FAILED" ? (
          <div className="text-center">
            <p className="text-sm text-destructive">生成失败</p>
            <p className="mt-1 max-w-sm text-xs text-muted-foreground">
              {poll?.job?.failedReason ??
                poll?.generation.error ??
                "请检查 AI provider 配置或稍后重试。"}
            </p>
          </div>
        ) : running ? (
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="h-9 w-9 animate-spin rounded-full border-2 border-accent-soft border-t-primary" />
            <p className="text-xs text-muted-foreground">
              {status === "PENDING" ? "已受理，排队中…" : "AI 正在合成品牌预览…"}
            </p>
          </div>
        ) : image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image}
            alt="品牌预览"
            className="max-h-[420px] max-w-full rounded-xl object-contain shadow-[0_18px_50px_rgba(124,92,255,0.2)]"
          />
        ) : (
          <div className="text-center">
            <div className="text-3xl text-accent-soft">✸</div>
            <p className="mt-2 text-sm font-medium">还没有品牌预览</p>
            <p className="mt-1 max-w-sm text-xs text-muted-foreground">
              确认色彩、字体等品牌规则后，点「生成品牌预览」由 AI 合成。
            </p>
          </div>
        )}
      </div>
      {err ? <p className="mt-2 text-xs text-destructive">{err}</p> : null}
    </section>
  );
}

/**
 * D1 · AI 共创输入区 —— 真 AI 解析。统一 AI 输入框（AIInput, 32px 圆角）承载两条
 * 真实路径：
 *   1) 文本 + 类型 → POST /rules（一条结构化规则草稿，非 AI 的人工录入，诚实标注）。
 *   2) 附件（品牌资料 PDF）→ 直传 POST /assets/upload(category=VI_DOC) → 触发现有
 *      异步 POST /rules/parse-manual → 轮询 GET /tasks/[taskId]（202+poll，§2，不在
 *      handler 里 await 慢 AI）→ 真 VLM 解析出 DRAFT 规则浮现，供「确认采用」。
 * 语音入口（Web Speech API）把口述转写进文本框，喂给路径 1。
 */
function AICoCreate({ wsId }: { wsId: string }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [type, setType] = useState("copy");
  // parse-manual async task (from an attached PDF)
  const [taskId, setTaskId] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const [attachErr, setAttachErr] = useState<string | null>(null);
  const startedAt = useRef(0);

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

  // attach a brand-material PDF → upload as VI_DOC → enqueue parse-manual.
  const parseAttach = useMutation({
    mutationFn: async (file: File) => {
      setAttachErr(null);
      setTimedOut(false);
      const fd = new FormData();
      fd.append("file", file);
      fd.append("category", "VI_DOC");
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
        `/api/workspaces/${wsId}/rules/parse-manual`,
        { method: "POST", body: JSON.stringify({ assetId: asset.id }) },
      );
    },
    onSuccess: (res) => setTaskId(res.taskId),
    onError: (e) => setAttachErr(e instanceof Error ? e.message : "解析失败"),
  });

  const { data: task } = useQuery<TaskState>({
    queryKey: ["brandai-task", wsId, taskId],
    queryFn: () => apiFetch<TaskState>(`/api/workspaces/${wsId}/tasks/${taskId}`),
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

  const parsing = parseAttach.isPending || running;

  return (
    <>
      <div className="mx-auto mt-6 max-w-2xl">
        <AIInput
          value={text}
          onChange={setText}
          onSubmit={() => {
            if (text.trim() && !add.isPending) add.mutate();
          }}
          disabled={parsing}
          placeholder="说出或输入一条品牌规则（如：主色 #7C5CFF，禁止改色或描边），或用 📎 上传品牌资料 PDF 让 AI 解析…"
          onAttach={(f) => parseAttach.mutate(f)}
          attachAccept="application/pdf"
          topSlot={
            <div className="flex flex-wrap gap-1.5 px-1">
              {QUICK_PROMPTS.map((q) => (
                <button
                  key={q.text}
                  type="button"
                  onClick={() => {
                    setType(q.type);
                    setText(q.text);
                  }}
                  className="rounded-full border border-border bg-muted px-3 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent-soft hover:text-primary"
                >
                  {q.text.length > 20 ? `${q.text.slice(0, 20)}…` : q.text}
                </button>
              ))}
            </div>
          }
          leftControls={
            <select
              value={type}
              disabled={parsing}
              onChange={(e) => setType(e.target.value)}
              className="h-9 rounded-full border border-border bg-background px-3 text-xs outline-none disabled:opacity-60"
            >
              {TYPE_OPTIONS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          }
          primaryAction={
            <button
              type="button"
              disabled={!text.trim() || add.isPending || parsing}
              onClick={() => add.mutate()}
              className="h-10 shrink-0 rounded-[16px] bg-gradient-to-br from-primary to-accent px-6 text-sm font-medium text-primary-foreground shadow-[0_12px_28px_rgba(124,92,255,0.26)] disabled:opacity-60"
            >
              {add.isPending ? "添加中…" : "添加规则"}
            </button>
          }
        />
      </div>

      {/* parse-manual (附件 AI 解析) 进度 / 结果，§2.3 observable */}
      {taskId || parseAttach.isPending ? (
        <div className="mx-auto mt-3 max-w-2xl">
          {status === "SUCCEEDED" ? (
            <div className="rounded-2xl border border-success/20 bg-success/5 px-4 py-3 text-left text-sm text-success">
              AI 已从上传资料解析出 {task?.refCount ?? 0} 条规则草稿，请在下方「确认采用」。
            </div>
          ) : (
            <TaskProgress
              status={parseAttach.isPending ? "PENDING" : status}
              progress={task?.progress ?? (parseAttach.isPending ? 5 : 0)}
              timedOut={timedOut}
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

      {add.isError ? (
        <p className="mt-2 text-sm text-destructive">
          {(add.error as Error).message}
        </p>
      ) : null}
      {attachErr ? (
        <p className="mt-2 text-sm text-destructive">{attachErr}</p>
      ) : null}
    </>
  );
}

export default function BrandKnowledgePage() {
  const { wsId, brandName } = useBrand();
  const qc = useQueryClient();
  const [aiModal, setAiModal] = useState<null | "recognize" | "parse-manual">(
    null,
  );
  // D3 · 上传弹窗（H5）当前打开的入口分类。
  const [uploadEntry, setUploadEntry] = useState<UploadEntry | null>(null);

  const { data: rules = [], isLoading } = useQuery({
    queryKey: ["brandai-rules", wsId],
    queryFn: () => apiFetch<BrandRule[]>(`/api/workspaces/${wsId}/rules`),
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
        {/* D1 · AI 共创输入区 —— 统一 AI 输入框（文本/语音 + 附件 PDF 真 AI 解析）。 */}
        <AICoCreate wsId={wsId} />

        {/* D13/D14 · AI 驱动入口 — 从素材识别规则 / 解析 VI 手册（server-authoritative）。 */}
        <div className="mx-auto mt-4 flex max-w-2xl flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => setAiModal("recognize")}
            className="flex items-center gap-2 rounded-full border border-primary/30 bg-card px-4 py-2 text-sm font-medium text-primary transition-colors hover:bg-accent-soft"
          >
            <span>✦</span> 从素材识别品牌规则
          </button>
          <button
            type="button"
            onClick={() => setAiModal("parse-manual")}
            className="flex items-center gap-2 rounded-full border border-primary/30 bg-card px-4 py-2 text-sm font-medium text-primary transition-colors hover:bg-accent-soft"
          >
            <span>▦</span> 解析 VI 手册 / PDF
          </button>
        </div>
      </section>

      {aiModal ? (
        <RecognizeModal
          wsId={wsId}
          mode={aiModal}
          onClose={() => {
            // Safety net: a recognize/parse-manual job can finish just AFTER
            // the UI's bounded poll gives up (timeout). Always refresh rules on
            // close so a late-completing job's new rules still surface without a
            // manual page reload.
            qc.invalidateQueries({ queryKey: ["brandai-rules", wsId] });
            setAiModal(null);
          }}
          onDone={() =>
            qc.invalidateQueries({ queryKey: ["brandai-rules", wsId] })
          }
        />
      ) : null}

      {/* D3 · 上传入口区 —— 6 类品牌资料的真·分类上传入口（点开 H5 上传弹窗）。 */}
      <section className="mt-10 grid grid-cols-3 gap-3.5 lg:grid-cols-6">
        {UPLOAD_ENTRIES.map((e) => (
          <button
            key={e.key}
            type="button"
            title={e.hint}
            onClick={() => setUploadEntry(e)}
            className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border bg-card p-4 text-center transition-colors hover:border-primary/40 hover:bg-accent-soft/40"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-accent-soft text-lg text-primary">
              {e.icon}
            </span>
            <span className="text-xs font-medium">{e.label}</span>
            <span className="text-[10px] text-muted-foreground">
              上传 · {CATEGORY_LABELS[e.category] ?? e.category}
            </span>
          </button>
        ))}
      </section>

      {uploadEntry ? (
        <UploadDialog
          wsId={wsId}
          entry={uploadEntry}
          onClose={() => setUploadEntry(null)}
          onUploaded={() => {
            // a freshly-uploaded VI_DOC may be parsed via the AI input next;
            // refresh asset-backed queries so recognize/parse pickers see it.
            qc.invalidateQueries({ queryKey: ["brandai-assets", wsId] });
          }}
        />
      ) : null}

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

      {/* D10 · 品牌预览 — composite visual auto-generation from confirmed KB. */}
      <BrandPreview wsId={wsId} confirmedCount={confirmedCount} />
    </div>
  );
}
