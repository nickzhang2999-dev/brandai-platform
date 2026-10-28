"use client";

import React, { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Asset, BrandRule, Evidence, TaskState } from "@brandai/contracts";
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
import { apiFetch, ApiFetchError, assetThumbUrl } from "../../lib/client";
import { useBoundedTaskQuery, TASK_POLL_PAUSED_MESSAGE } from "../../lib/use-bounded-task-poll";
import { imageUploadLimitError } from "../../lib/upload-limits";
import type { BrandWorkspace, WorkspaceRole } from "@brandai/contracts";
import { KnowledgeManagementPanels, ManualRuleForm } from "./KnowledgeManagementPanels";
import { DraftImportPanel } from "./DraftImportPanel";
import { canEditKnowledge, ruleReplacementMessage } from "./knowledge-state";
import { groupBrandKitRules, uniqueBrandKitFiles, BRAND_KIT_BATCH_LIMIT, type BrandKitUploadEntry } from "./brand-kit-state";
function Chip({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full border border-border bg-muted px-2.5 py-1 text-[11px] text-muted-foreground">{children}</span>;
}

export interface BrandKnowledgeEditorProps {
  wsId: string;
  brandName: string;
  userId: string;
  role: WorkspaceRole;
  embedded?: boolean;
  onBrandChanged?: () => Promise<void>;
}

/** Shared by the legacy shell and the URL-pinned Studio entry; no active-brand cookie reads here. */
export function BrandKnowledgeEditor({ wsId, brandName: initialName, userId, role, embedded = false, onBrandChanged }: BrandKnowledgeEditorProps) {
  const qc = useQueryClient();
  const canEdit = canEditKnowledge(role);
  const [tab, setTab] = useState<"rules" | "restrictions" | "versions">("rules");
  const [editingRule, setEditingRule] = useState<BrandRule | null>(null);
  const [preview, setPreview] = useState<{ src: string; alt: string } | null>(null);
  const [suggestedType, setSuggestedType] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [openRuleMenu, setOpenRuleMenu] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState(initialName);
  const workspace = useQuery({ queryKey: ["knowledge-workspace", wsId, userId],
    queryFn: () => apiFetch<{ workspace: BrandWorkspace }>(`/api/workspaces/${encodeURIComponent(wsId)}`) });
  const brandName = workspace.data?.workspace.name ?? initialName;
  const kitEnabled = !workspace.data?.workspace.tags?.includes("__kb_disabled");
  const rulesQuery = useQuery({ queryKey: ["brandai-rules", wsId],
    queryFn: () => apiFetch<BrandRule[]>(`/api/workspaces/${encodeURIComponent(wsId)}/rules`) });
  const rules = rulesQuery.data ?? [];
  const refreshRules = () => {
    void qc.invalidateQueries({ queryKey: ["brandai-rules", wsId] });
    void qc.invalidateQueries({ queryKey: ["brandai-knowledge-overview"] });
    void onBrandChanged?.();
  };
  const updateBrand = useMutation({
    mutationFn: (patch: { name?: string; disabled?: boolean }) => {
      if (!canEdit) throw new Error("当前权限只能查看品牌知识。");
      return apiFetch<BrandWorkspace>(`/api/workspaces/${encodeURIComponent(wsId)}`, { method: "PATCH", body: JSON.stringify(patch) });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["knowledge-workspace", wsId, userId] }); void onBrandChanged?.(); },
  });
  const updateRule = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) => {
      if (!canEdit) throw new Error("当前权限只能查看品牌知识。");
      return apiFetch<BrandRule>(`/api/workspaces/${encodeURIComponent(wsId)}/rules/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
    }, onSuccess: refreshRules,
  });
  const deleteRule = useMutation({
    mutationFn: (id: string) => {
      if (!canEdit) throw new Error("当前权限只能查看品牌知识。");
      return apiFetch(`/api/workspaces/${encodeURIComponent(wsId)}/rules/${encodeURIComponent(id)}`, { method: "DELETE" });
    }, onSuccess: refreshRules,
  });
  useEffect(() => { setTitleDraft(brandName); }, [brandName, wsId]);
  useEffect(() => { setEditingRule(null); setPreview(null); setSuggestedType(null); setManualOpen(false); }, [wsId]);
  const busy = updateRule.isPending || deleteRule.isPending;
  const toggleRule = (rule: BrandRule) => {
    if (!canEdit) return;
    const warning = ruleReplacementMessage(rule, rules);
    if (warning && !window.confirm(warning)) return;
    updateRule.mutate({ id: rule.id, patch: { status: rule.status === "CONFIRMED" ? "REJECTED" : "CONFIRMED" } });
  };
  const removeRule = (rule: BrandRule) => {
    if (canEdit && window.confirm(`删除「${rule.summary}」？此操作不可恢复。`)) deleteRule.mutate(rule.id);
  };
  const commitTitle = () => {
    const name = titleDraft.trim();
    if (!canEdit || !name) { setTitleDraft(brandName); return; }
    if (name !== brandName) updateBrand.mutate({ name });
  };
  const error = rulesQuery.error ?? workspace.error ?? updateRule.error ?? deleteRule.error ?? updateBrand.error;
  const groups = ["layout", "logo", "color", "font", "imagery", "copy", "graphic"];
  return <div className={`mx-auto w-full max-w-[880px] ${embedded ? "px-5 py-5" : "px-8 pb-20 pt-6"}`} data-testid="brand-knowledge-editor" data-workspace-id={wsId}>
    <header className="flex flex-wrap items-center justify-between gap-4">
      <div className="min-w-0 flex-1">
        <input aria-label="品牌套件名称" maxLength={80} readOnly={!canEdit} value={titleDraft} onChange={event => setTitleDraft(event.target.value)} onBlur={commitTitle}
          onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { setTitleDraft(brandName); event.currentTarget.blur(); } }}
          className="w-full border-0 bg-transparent p-0 text-xl font-semibold outline-none focus:text-primary" />
        <p className="mt-1 text-xs text-muted-foreground">品牌知识 · {canEdit ? "可编辑" : "只读"} · {rules.filter(rule => rule.status === "CONFIRMED").length} 条已启用</p>
      </div>
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" aria-label="应用品牌知识到项目" checked={kitEnabled} disabled={!canEdit || !workspace.data || updateBrand.isPending}
        onChange={event => updateBrand.mutate({ disabled: !event.target.checked })} />应用到项目</label>
    </header>
    <p className="mt-4 rounded-2xl bg-accent-soft px-4 py-3 text-xs leading-relaxed text-muted-foreground">新规则先保存为草稿，核对后启用。每个类别仅保留一条已启用规则；启用另一条时会明确提示替换，旧规则保留为已停用。关闭“应用到项目”不会删除知识。</p>
    <nav className="my-5 flex gap-2" aria-label="品牌知识分类">
      {([["rules", "知识规则"], ["restrictions", "禁用项与词库"], ["versions", "版本快照"]] as const).map(([id, label]) => <button type="button" key={id} aria-pressed={tab === id} onClick={() => setTab(id)}
        className={`rounded-full px-4 py-2 text-sm ${tab === id ? "bg-accent-soft text-primary" : "bg-muted text-muted-foreground"}`}>{label}</button>)}
    </nav>
    {error && <p role="alert" className="mb-4 rounded-xl bg-destructive/10 p-3 text-sm text-destructive">{error instanceof Error ? error.message : "读取失败，请重试。"} <button type="button" className="underline" onClick={() => { void rulesQuery.refetch(); void workspace.refetch(); }}>重新读取</button></p>}
    {tab === "rules" ? <>
      <DraftImportPanel wsId={wsId} userId={userId} canEdit={canEdit} onImported={refreshRules} />
      {canEdit && <div className="my-5 space-y-4"><AICoCreate key={wsId} wsId={wsId} userId={userId} suggestedType={suggestedType} hasContent={rules.length > 0} onSuggestionHandled={() => setSuggestedType(null)} />
        <Button variant="outline" onClick={() => setManualOpen(value => !value)}>{manualOpen ? "收起手动添加" : "手动添加规则"}</Button>
        {manualOpen && <ManualRuleForm wsId={wsId} canEdit={canEdit} onSaved={() => { refreshRules(); setManualOpen(false); }} />}
      </div>}
      {rulesQuery.isLoading ? <p role="status">正在读取品牌规则…</p> : <div className="mt-7 space-y-8">
        {groups.map(type => <section key={type} aria-label={TYPE_META[type]?.label}>
          <div className="mb-3 flex items-center gap-3"><h2 className="text-sm font-medium">{TYPE_META[type]?.label}</h2>
            {canEdit && BRAND_KIT_IMPORT_SLOTS.some(slot => slot.type === type) && <button type="button" className="text-xs text-primary hover:underline" onClick={() => setSuggestedType(type)}>上传{TYPE_META[type]?.label}素材</button>}
          </div>
          <div className="flex flex-wrap gap-3">{groupBrandKitRules(rules.filter(rule => rule.type === type)).map(group => <RuleGroup key={group.key} rules={group.rules}
            wsId={wsId} canEdit={canEdit} busy={busy} onEdit={setEditingRule} onToggle={toggleRule} onDelete={removeRule} onPreview={setPreview}
            openRuleMenu={openRuleMenu} setOpenRuleMenu={setOpenRuleMenu} />)}{!rules.some(rule => rule.type === type) && <p className="text-xs text-muted-foreground">暂无{TYPE_META[type]?.label}规则</p>}</div>
        </section>)}
      </div>}
    </> : <KnowledgeManagementPanels key={`${wsId}:${tab}`} wsId={wsId} canEdit={canEdit} panel={tab} onRulesChanged={refreshRules} />}
    {editingRule && <RuleEditorDialog key={editingRule.id} rule={editingRule} readOnly={!canEdit} saving={updateRule.isPending} onClose={() => setEditingRule(null)}
      onSave={patch => { if (canEdit) updateRule.mutate({ id: editingRule.id, patch }, { onSuccess: () => setEditingRule(null) }); }} />}
    <BrandKitLightbox preview={preview} onClose={() => setPreview(null)} />
  </div>;
}

// §2.2 — bounded intermediate state; mirror the workspace page's POLL_CAP.
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
    title: "Logo",
    desc: "上传主标、反白标、图形标等，确认后成为 logo 使用规范。",
    accept: "image/*",
    limit: "图片每个不超过 8 MiB",
  },
  {
    key: "font",
    type: "font",
    title: "字体",
    desc: "上传字体说明截图或字体规范页，AI 提取字体使用边界。",
    accept: "image/*",
    limit: "图片每个不超过 8 MiB",
  },
  {
    key: "color",
    type: "color",
    title: "颜色",
    desc: "上传色卡、色值页或视觉样张，AI 提炼主辅色与禁用色。",
    accept: "image/*",
    limit: "图片每个不超过 8 MiB",
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
    limit: "图片每个不超过 8 MiB",
  },
];

/**
 * P03 · 品牌套件 — 把品牌规则沉淀为 AI 可调用的结构化知识。真实数据：
 * GET/POST/PATCH /api/workspaces/[wsId]/rules。已确认(CONFIRMED)的规则会在
 * 工作台出图时被 worker 加载用于受控生成。
 *
 * D4–D10 · 品牌套件内容从「通用规则卡」恢复为 RICH 结构化卡：
 * logo→do/don't，字体→字族预览，颜色→真实色块，设计指南/图像→结构化要点，
 * copy 和 graphic 同样展示并可管理，继续通过现有规则接口参与生成约束。
 * 所有字段访问都对 value 缺字段降级（fall back 到 summary），绝不崩。
 */
const TYPE_META: Record<
  string,
  { label: string; short: string; icon: string }
> = {
  logo: { label: "Logo", short: "Logo", icon: "◐" },
  font: { label: "字体", short: "字体", icon: "Aa" },
  color: { label: "颜色", short: "颜色", icon: "◉" },
  layout: { label: "设计指南", short: "设计指南", icon: "▤" },
  imagery: { label: "图像", short: "图像", icon: "▦" },
  copy: { label: "文案语气", short: "文案", icon: "❝" },
  graphic: { label: "设计元素", short: "设计", icon: "✦" },
};
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

type RuleCardProps = { rule: BrandRule; wsId: string; onEdit: (rule: BrandRule) => void; onToggle: (rule: BrandRule) => void;
  onDelete: (rule: BrandRule) => void; onPreview: (input: { src: string; alt: string }) => void; busy: boolean; canEdit: boolean;
  openRuleMenu: string | null; setOpenRuleMenu: (id: string | null) => void };

function RuleGroup({ rules, ...props }: Omit<RuleCardProps, "rule"> & { rules: BrandRule[] }) {
  const [selectedId, setSelectedId] = useState(rules[0]?.id ?? "");
  const rule = rules.find(item => item.id === selectedId) ?? rules[0];
  if (!rule) return null;
  return <div className="w-[160px]" data-testid="brand-kit-source-card">
    <RuleCard {...props} rule={rule} />
    {rules.length > 1 && <label className="mt-2 block text-[11px] text-muted-foreground">同一素材 · {rules.length} 条分析建议
      <select aria-label="选择这份素材的分析建议" className="mt-1 w-full rounded-lg border border-border bg-background p-1.5 text-xs text-foreground"
        value={rule.id} onChange={event => { setSelectedId(event.target.value); props.setOpenRuleMenu(null); }}>
        {rules.map((item, index) => <option key={item.id} value={item.id}>{index + 1}. {item.summary}</option>)}
      </select>
    </label>}
    <div className="mt-2 flex flex-wrap gap-1"><StatusBadge status={rule.status} /><StrengthBadge strength={rule.strength} /></div>
  </div>;
}

function RuleCard({
  rule,
  wsId,
  onEdit,
  onToggle,
  onDelete,
  onPreview,
  busy,
  canEdit,
  openRuleMenu,
  setOpenRuleMenu,
}: RuleCardProps) {
  const menuRef = useRef<HTMLDivElement>(null), triggerRef = useRef<HTMLButtonElement>(null);
  const menuOpen = openRuleMenu === rule.id;
  useEffect(() => {
    if (!menuOpen) return;
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setOpenRuleMenu(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpenRuleMenu(null); triggerRef.current?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [menuOpen, setOpenRuleMenu]);
  const value = (rule.value ?? {}) as Val;
  const evidence = (rule.evidence ?? []).find((item) => item.assetId);
  const previewUrl = evidence?.assetId
    ? assetThumbUrl(wsId, evidence.assetId, evidence.thumbnailUrl ?? "")
    : null;
  const swatch = rule.type === "color" ? extractSwatches(value)[0] : null;
  const font = rule.type === "font" ? extractFonts(value)[0] : null;
  return (
    <div className="group relative w-full shrink-0">
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
        className="flex aspect-square w-full cursor-pointer items-center justify-center overflow-hidden rounded-lg border border-border bg-muted/45 transition-colors duration-200 hover:border-primary/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60"
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
      <div className="mt-1.5 min-w-0">
        <span className="block truncate text-[10px] text-muted-foreground">
          {evidence?.note ?? rule.summary}
        </span>
      </div>
      {canEdit && <div ref={menuRef} className="absolute right-1 top-1 z-20" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpenRuleMenu(null); }}>
        <button type="button" ref={triggerRef} aria-label="规则操作" aria-haspopup="menu" aria-expanded={menuOpen}
          onClick={() => setOpenRuleMenu(menuOpen ? null : rule.id)}
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg bg-background/85 text-muted-foreground shadow-sm backdrop-blur transition-opacity hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
          <MoreHorizontal className="h-4 w-4" />
          <span className="sr-only">规则操作</span>
        </button>
        {menuOpen && <div role="menu" aria-label="规则操作菜单" className="absolute right-0 top-9 w-28 overflow-hidden rounded-xl border border-border bg-card py-1 text-xs shadow-[0_14px_36px_rgba(30,30,60,0.18)]">
          <button
            type="button"
            disabled={busy}
            role="menuitem" onClick={() => { setOpenRuleMenu(null); onEdit(rule); }}
            className="h-9 w-full cursor-pointer px-3 text-left transition-colors hover:bg-muted disabled:opacity-60"
          >
            编辑
          </button>
          <button
            type="button"
            disabled={busy}
            role="menuitem" onClick={() => { setOpenRuleMenu(null); onToggle(rule); }}
            className="h-9 w-full cursor-pointer px-3 text-left transition-colors hover:bg-muted disabled:opacity-60"
          >
            {rule.status === "CONFIRMED" ? "禁用" : "启用"}
          </button>
          <button
            type="button"
            disabled={busy}
            role="menuitem" onClick={() => { setOpenRuleMenu(null); onDelete(rule); }}
            className="h-9 w-full cursor-pointer px-3 text-left text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-60"
          >
            删除
          </button>
        </div>}
      </div>}
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
  readOnly = false,
}: {
  readOnly?: boolean;
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
    if (readOnly) return;
    onSave({
      summary: summary.trim(),
      strength,
      value: value as Record<string, unknown>,
    });
  }

  return (
    <ModalShell
      title={`${readOnly ? "查看" : "编辑"}${TYPE_META[rule.type]?.label ?? "品牌规则"}`}
      subtitle={readOnly ? "当前权限可查看规则内容与来源，修改需要品牌编辑权限。" : "修改后保存即可更新该品牌套件；禁用的内容也可以先编辑，再重新启用。"}
      onClose={onClose}
    >
      <div className="flex flex-col gap-4 overflow-y-auto px-6 py-5">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium">规则说明</span>
          <textarea
            value={summary}
            readOnly={readOnly}
            onChange={(event) => setSummary(event.target.value)}
            rows={4}
            className="resize-y rounded-lg border border-border bg-background p-3 text-sm outline-none focus:border-primary/40"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium">约束强度</span>
          <select
            value={strength}
            disabled={readOnly}
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
            readOnly={readOnly}
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
          {!readOnly && <Button onClick={save} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </Button>}
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
  if (timedOut) label = "自动查询已暂停";
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
  onManualFiles,
}: {
  disabled: boolean;
  onSelectType: (type: string) => void;
  onManualFiles: (files: File[]) => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);

  function pick(files: FileList | null) {
    if (disabled || !files?.length) return;
    onManualFiles(Array.from(files));
  }

  return (
    <section className="mx-auto flex w-full max-w-[560px] flex-col items-center text-left">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          开始使用你的品牌套件
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          添加 Logo、颜色、字体等，保持品牌一致性。
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
            PNG、JPG、PDF · 上传后自动解析全部内容
          </span>
        </button>
        <div className="mt-4 flex items-center gap-3 text-[10px] text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          或
          <span className="h-px flex-1 bg-border" />
        </div>
        <p className="mt-3 text-center text-[11px] text-muted-foreground">
          还没有品牌素材？从零开始在画布上创建。
        </p>
      </div>
      <input
        ref={fileRef}
        type="file"
        multiple
        accept="image/*,application/pdf"
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
  onFiles,
}: {
  disabled: boolean;
  onFiles: (files: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <div onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (!disabled) onFiles(Array.from(event.dataTransfer.files)); }} className="w-full rounded-xl border border-border/60 bg-muted/45 px-5 py-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground">
            <FileText className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">
              一次上传，构建你的品牌套件
            </p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              上传品牌文件，自动填充 Logo、颜色、字体等信息。
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
        multiple
        accept="image/*,application/pdf"
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          if (!disabled && files.length) onFiles(files);
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
  onFiles,
}: {
  slot: (typeof BRAND_KIT_IMPORT_SLOTS)[number];
  disabled: boolean;
  onClose: () => void;
  onFiles: (files: File[]) => void;
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
          onDragOver={event => event.preventDefault()}
          onDrop={event => { event.preventDefault(); if (!disabled) onFiles(Array.from(event.dataTransfer.files)); }}
          className="flex aspect-[4/3] w-full cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/35 text-muted-foreground transition-colors hover:border-primary/45 hover:bg-accent-soft hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60"
        >
          <Plus className="h-5 w-5" />
          <span className="mt-2 text-[10px]">选择或拖入文件（可多选）</span>
        </button>
        <p className="mt-4 text-[11px] text-muted-foreground">每次最多 10 个文件；{slot.limit}</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={slot.accept}
          className="hidden"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            if (!disabled && files.length) onFiles(files);
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

  const { data: task, timedOut, setTimedOut, resume: resumePoll } = useBoundedTaskQuery<TaskState>({
    queryKey: ["brandai-task", wsId, taskId],
    queryFn: (signal) =>
      apiFetch<TaskState>(`/api/workspaces/${wsId}/tasks/${taskId}`, { signal }),
    enabled: !!taskId,
    taskKey: taskId ? JSON.stringify([wsId, taskId]) : null,
    startedAt,
    getStatus: task => task?.status,
  });

  // bounded-state guard — flip to timed-out so the spinner can't run forever.


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

  const failed = status === "FAILED";

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
            <><p hidden={!timedOut} role="status" className="text-sm text-muted-foreground">{TASK_POLL_PAUSED_MESSAGE} <button type="button" className="underline" onClick={resumePoll}>继续查询原任务</button></p><TaskProgress
              status={status}
              progress={task?.progress ?? 0}
              timedOut={timedOut}
              isManual={mode === "parse-manual"}
              error={
                failed
                  ? (task?.error ?? "AI 处理失败，请重试。")
                  : null
              }
            /></>
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
function AICoCreate({ wsId, userId, suggestedType, hasContent, onSuggestionHandled }: {
  wsId: string; userId: string; suggestedType?: string | null; hasContent: boolean; onSuggestionHandled?: () => void;
}) {
  const [uploadType, setUploadType] = useState<string | null>(null);
  const [entries, setEntries] = useState<BrandKitUploadEntry[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const entriesRef = useRef<BrandKitUploadEntry[]>([]), submittingRef = useRef(false), mounted = useRef(true);
  const controllerRef = useRef<AbortController | null>(null), scopeEpoch = useRef(0);
  const key = `novart:knowledge-batch:${userId}:${wsId}`;
  function saveEntries(next: BrandKitUploadEntry[]) {
    entriesRef.current = next;
    // Only receipts and display metadata survive reload, never file bytes.
    try { sessionStorage.setItem(key, JSON.stringify(next.map(({ file: _file, ...entry }) => entry))); } catch { /* URL retains task ids. */ }
    if (mounted.current) {
      setEntries(next);
      const ids = next.flatMap(entry => entry.taskId ? [entry.taskId] : []);
      const url = new URL(window.location.href);
      if (ids.length) url.searchParams.set("knowledgeTasks", ids.join(",")); else url.searchParams.delete("knowledgeTasks");
      url.searchParams.delete("knowledgeTask"); history.replaceState(history.state, "", url);
    }
  }
  function updateEntry(id: string, patch: Partial<BrandKitUploadEntry>) {
    if (!entriesRef.current.some(entry => entry.id === id && Object.entries(patch).some(([field, value]) => entry[field as keyof BrandKitUploadEntry] !== value))) return;
    saveEntries(entriesRef.current.map(entry => entry.id === id ? { ...entry, ...patch } : entry));
  }
  useEffect(() => {
    mounted.current = true; const epoch = ++scopeEpoch.current; submittingRef.current = false; setSubmitting(false);
    let restored: BrandKitUploadEntry[] = [];
    try {
      const parsed: unknown = JSON.parse(sessionStorage.getItem(key) ?? "[]");
      if (Array.isArray(parsed)) restored = parsed.slice(0, BRAND_KIT_BATCH_LIMIT).flatMap(entry => {
        if (!entry || typeof entry.id !== "string" || !/^[a-f0-9-]{36}$/i.test(entry.id)) return [];
        const taskId = typeof entry.taskId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(entry.taskId) ? entry.taskId : undefined;
        const assetId = typeof entry.assetId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(entry.assetId) ? entry.assetId : undefined;
        return [{ id: entry.id, name: typeof entry.name === "string" ? entry.name.slice(0, 200) : "已上传素材", isPdf: entry.isPdf === true,
          ...(typeof entry.targetType === "string" && TYPE_META[entry.targetType] ? { targetType: entry.targetType } : {}), assetId, taskId, rejected: entry.rejected === true,
          phase: taskId ? "ACCEPTED" as const : "FAILED" as const, ...(!taskId ? { error: assetId ? "文件已上传，解析回执未确认；可以安全继续原请求。" : "文件尚未完成上传，请重新选择文件。" } : {}) }];
      });
    } catch { /* Invalid local receipt is not an instruction. */ }
    if (!restored.length) {
      const url = new URL(window.location.href);
      const ids = (url.searchParams.get("knowledgeTasks") ?? url.searchParams.get("knowledgeTask") ?? "").split(",").filter(id => /^[A-Za-z0-9_-]{1,128}$/.test(id)).slice(0, BRAND_KIT_BATCH_LIMIT);
      restored = ids.map(taskId => ({ id: crypto.randomUUID(), name: "已上传素材", isPdf: false, taskId, phase: "ACCEPTED" }));
    }
    entriesRef.current = restored; setEntries(restored);
    return () => { mounted.current = false; scopeEpoch.current = epoch + 1; controllerRef.current?.abort(); };
  }, [key]);
  useEffect(() => { if (suggestedType && TYPE_META[suggestedType]) { setUploadType(suggestedType); onSuggestionHandled?.(); } }, [suggestedType, onSuggestionHandled]);

  async function processEntries(selected: BrandKitUploadEntry[]) {
    if (submittingRef.current) return;
    const epoch = scopeEpoch.current;
    const currentScope = () => mounted.current && scopeEpoch.current === epoch;
    submittingRef.current = true; setSubmitting(true);
    try {
      for (const requested of selected) {
        if (!currentScope()) break;
        const current = entriesRef.current.find(entry => entry.id === requested.id) ?? requested;
        const controller = new AbortController(); controllerRef.current = controller;
        const timeout = setTimeout(() => controller.abort(), 45_000);
        try {
          let assetId = current.assetId;
          if (!assetId) {
            if (!current.file) throw new Error("请重新选择原文件。");
            updateEntry(current.id, { phase: "UPLOADING", error: undefined });
            const imageCategory: Record<string, AssetCategory> = { logo: "LOGO", layout: "KV", imagery: "KV", graphic: "PRODUCT" };
            const form = new FormData(); form.append("file", current.file); form.append("category", current.isPdf ? "VI_DOC" : (imageCategory[current.targetType ?? ""] ?? "OTHER")); form.append("libraryKind", "BRAND_KIT");
            const response = await fetch(`/api/workspaces/${encodeURIComponent(wsId)}/assets/upload`, { method: "POST", body: form, signal: controller.signal });
            if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error ?? "上传失败，请重试原文件。"); }
            const asset = await response.json() as Asset; if (!currentScope()) break; assetId = asset.id;
            updateEntry(current.id, { assetId, phase: "SUBMITTING" });
          } else updateEntry(current.id, { phase: "SUBMITTING", error: undefined });
          const receipt = await apiFetch<StartResponse>(`/api/workspaces/${encodeURIComponent(wsId)}/rules/${current.isPdf ? "parse-manual" : "recognize"}`, {
            method: "POST", signal: controller.signal, body: JSON.stringify({ ...(current.isPdf ? { assetId } : { assetIds: [assetId] }), mutationId: current.id,
              ...(current.targetType ? { targetType: current.targetType } : {}) }) });
          if (!currentScope()) break;
          updateEntry(current.id, { taskId: receipt.taskId, phase: "ACCEPTED", error: undefined, rejected: false, removable: false });
        } catch (error) {
          if (!currentScope()) break;
          updateEntry(current.id, { phase: "FAILED", removable: false, rejected: error instanceof ApiFetchError && [400, 403, 404, 409, 413, 415, 422].includes(error.status), error: controller.signal.aborted ? "请求回执尚未确认；重试会沿用原上传和解析标识。" : error instanceof Error ? error.message : "未完成，请重试原请求。" });
        } finally { clearTimeout(timeout); if (controllerRef.current === controller) controllerRef.current = null; }
      }
    } finally { if (currentScope()) { submittingRef.current = false; setSubmitting(false); } }
  }
  async function inspectReceipt(entry: BrandKitUploadEntry) {
    if (submittingRef.current) return;
    const epoch = scopeEpoch.current, controller = new AbortController();
    const isCurrent = () => mounted.current && scopeEpoch.current === epoch;
    submittingRef.current = true; setSubmitting(true); controllerRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const receipt = await apiFetch<StartResponse>(`/api/workspaces/${encodeURIComponent(wsId)}/rules/${entry.isPdf ? "parse-manual" : "recognize"}?mutationId=${encodeURIComponent(entry.id)}`, { signal: controller.signal });
      if (isCurrent()) updateEntry(entry.id, { taskId: receipt.taskId, phase: "ACCEPTED", error: undefined, rejected: false, removable: false });
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof ApiFetchError && error.status === 404 && error.message === "没有找到这次解析任务。" && entry.rejected) {
        updateEntry(entry.id, { removable: true, error: "原请求已被拒绝，服务端未找到解析任务；可以移除这项记录后重新选择。" });
      } else updateEntry(entry.id, { removable: false, error: "原回执尚未确认；请保留本项，稍后查询或重试原请求。" });
    } finally { clearTimeout(timeout); if (controllerRef.current === controller) controllerRef.current = null;
      if (isCurrent()) { submittingRef.current = false; setSubmitting(false); } }
  }
  async function selectFiles(files: File[], targetType?: string) {
    if (submittingRef.current || !files.length) return;
    if (files.length > BRAND_KIT_BATCH_LIMIT) { setNotice("每次最多选择 10 个文件，请分批上传。"); return; }
    if (files.reduce((sum, file) => sum + file.size, 0) > 100 * 1024 * 1024) { setNotice("每批文件合计不超过 100 MiB，请分批上传。"); return; }
    for (const file of files) {
      if (file.size > 50 * 1024 * 1024 || !file.size) { setNotice("文件须大于零且不超过 50 MiB。"); return; }
      const issue = imageUploadLimitError(file); if (issue) { setNotice(issue); return; }
      const pdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
      if (!pdf && !file.type.startsWith("image/")) { setNotice("请选择图片或 PDF 文件。"); return; }
      if (targetType && targetType !== "layout" && pdf) { setNotice("该类别请上传图片；PDF 可从设计指南或完整品牌手册入口上传。"); return; }
    }
    const epoch = scopeEpoch.current;
    submittingRef.current = true; setSubmitting(true);
    try {
      const unique = await uniqueBrandKitFiles(files);
      if (!mounted.current || scopeEpoch.current !== epoch) return;
      const rows = unique.files.map(file => ({ id: crypto.randomUUID(), file, name: file.name, isPdf: file.type === "application/pdf" || /\.pdf$/i.test(file.name), targetType, phase: "WAITING" as const }));
      saveEntries(rows); setUploadType(null); setNotice(unique.duplicates ? `已跳过 ${unique.duplicates} 个内容相同的重复文件。` : null);
      submittingRef.current = false; await processEntries(rows);
    } catch { if (mounted.current && scopeEpoch.current === epoch) setNotice("文件读取失败，请重新选择。"); }
    finally { if (mounted.current && scopeEpoch.current === epoch) { submittingRef.current = false; setSubmitting(false); } }
  }
  const activeSlot = BRAND_KIT_IMPORT_SLOTS.find(slot => slot.type === uploadType);
  const busy = submitting || entries.some(entry => (entry.phase === "ACCEPTED" && !entry.terminal) || (entry.phase === "FAILED" && !!entry.assetId));
  return <>
    {hasContent ? <CompactManualImport disabled={busy} onFiles={files => { void selectFiles(files); }} />
      : <BrandKitImportPanel disabled={busy} onSelectType={setUploadType} onManualFiles={files => { void selectFiles(files); }} />}
    {activeSlot && <SlotUploadDialog slot={activeSlot} disabled={busy} onClose={() => setUploadType(null)} onFiles={files => { void selectFiles(files, activeSlot.type); }} />}
    {entries.length > 0 && <section className="mt-4 space-y-2" aria-label="品牌素材上传进度">
      <p className="text-xs text-muted-foreground">{entries.filter(entry => entry.taskId).length}/{entries.length} 份已受理。已受理的解析任务可刷新查看；尚未上传的文件请保持页面打开。</p>
      {entries.map(entry => <div key={entry.id} className="rounded-xl border border-border bg-background p-3 text-sm">
        <p className="break-all font-medium">{entry.name}{entry.targetType ? ` · ${TYPE_META[entry.targetType]?.label}` : " · 全类别识别"}</p>
        {entry.taskId ? <BrandKitTaskProgress wsId={wsId} taskId={entry.taskId} isPdf={entry.isPdf} onTerminal={() => updateEntry(entry.id, { terminal: true })} />
          : <p role="status" className="mt-1 text-xs text-muted-foreground">{entry.phase === "UPLOADING" ? "正在上传…" : entry.phase === "SUBMITTING" ? "正在受理解析…" : entry.phase === "WAITING" ? "等待上传…" : entry.error}</p>}
        {entry.phase === "FAILED" && <div className="mt-2 flex flex-wrap gap-2">
          {(entry.file || entry.assetId) && <Button variant="outline" disabled={submitting} onClick={() => { void processEntries([entry]); }}>重试原请求</Button>}
          {entry.assetId && <Button variant="outline" disabled={submitting} onClick={() => { void inspectReceipt(entry); }}>检查原回执</Button>}
          {entry.removable && <Button variant="outline" disabled={submitting} onClick={() => saveEntries(entriesRef.current.filter(item => item.id !== entry.id))}>移除此失败项</Button>}
        </div>}
      </div>)}
    </section>}
    {notice && <p role="status" className="mt-3 text-sm text-muted-foreground">{notice}</p>}
  </>;
}

function BrandKitTaskProgress({ wsId, taskId, isPdf, onTerminal }: { wsId: string; taskId: string; isPdf: boolean; onTerminal: () => void }) {
  const qc = useQueryClient(), startedAt = useRef(Date.now());
  const { data: task, error, timedOut, resume } = useBoundedTaskQuery<TaskState>({ queryKey: ["brandai-task", wsId, taskId],
    queryFn: signal => apiFetch<TaskState>(`/api/workspaces/${encodeURIComponent(wsId)}/tasks/${encodeURIComponent(taskId)}`, { signal }), enabled: true,
    taskKey: `${wsId}:${taskId}`, startedAt, getStatus: value => value?.status });
  const fired = useRef(false);
  useEffect(() => { if (!fired.current && (task?.status === "SUCCEEDED" || task?.status === "FAILED")) {
    fired.current = true; onTerminal(); void qc.invalidateQueries({ queryKey: ["brandai-rules", wsId] });
  } }, [task?.status, onTerminal, qc, wsId]);
  if (error || timedOut) return <p role="status" className="mt-1 text-xs text-muted-foreground">{error ? "暂时无法读取原任务；不会重复解析。" : TASK_POLL_PAUSED_MESSAGE} <button type="button" onClick={resume} className="text-primary underline">继续查询原任务</button></p>;
  if (task?.status === "SUCCEEDED") return <p className="mt-1 text-xs text-success">已完成：{task.refCount ?? 0} 条建议。相同素材汇总展示，核对后再分别启用。</p>;
  return <TaskProgress status={task?.status ?? "PENDING"} progress={task?.progress ?? 0} timedOut={false} isManual={isPdf} error={task?.status === "FAILED" ? task.error ?? "解析未完成；不会自动重复调用。" : null} />;
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
