"use client";

import { useMemo, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  BrandRule,
  Generation,
  GenerationVersion,
} from "@brandai/contracts";
import {
  Button,
  Badge,
  Spinner,
  Panel,
  FieldLabel,
  Eyebrow,
  ReferenceSourceList,
  type ReferenceSource,
} from "@brandai/ui";
import { apiFetch } from "@/lib/client";
import { ComplianceReportView } from "@/components/compliance-report";
import { Lightbox } from "@/components/lightbox";
import { VersionCompare } from "./version-compare";

/**
 * M6 · 生成记录列表与详情 + 版本管理. Reads project generations through
 * the additive `listProjectGenerations` helper (refreshed via the M3
 * `GET /generations/[genId]` route). Per generation it shows scene /
 * selling point / status / applied rules / the stored complianceReport
 * (rendered with the shared `ComplianceReportView`) and every version
 * incl. M4 edit children. Mark-final reuses the M3 single-final PATCH.
 * Selecting versions across the project enables the streamed 交付包 export.
 */

const SCENE_LABEL: Record<string, string> = {
  ECOM_MAIN: "电商主图",
  SCENE: "场景图",
  SOCIAL_POSTER: "社媒海报",
  CAMPAIGN_KV: "活动 KV",
  SELLING_POINT: "卖点图",
};

const STATUS_TONE: Record<
  string,
  "neutral" | "pass" | "risk" | "danger"
> = {
  PENDING: "neutral",
  RUNNING: "risk",
  SUCCEEDED: "pass",
  FAILED: "danger",
};

function appliedRuleIds(v: GenerationVersion): string[] {
  const params = (v.params ?? {}) as Record<string, unknown>;
  // P3.3 — accept both `appliedRuleIds` (legacy) and `appliedRules` (newer
  // shape used by seeds + some workers). Whichever side has rules wins.
  const raw1 = params.appliedRuleIds;
  if (Array.isArray(raw1)) return raw1 as string[];
  const raw2 = params.appliedRules;
  if (Array.isArray(raw2)) return raw2 as string[];
  return [];
}

function VersionCard({
  wsId,
  version,
  selected,
  onToggleSelect,
  onMarkFinal,
  marking,
  confirmedRules,
  onZoom,
}: {
  wsId: string;
  version: GenerationVersion;
  selected: boolean;
  onToggleSelect: () => void;
  onMarkFinal: () => void;
  marking: boolean;
  confirmedRules: BrandRule[];
  onZoom: () => void;
}) {
  const rules = appliedRuleIds(version);
  // P3.3 — resolve appliedRule IDs to readable summaries via the seeded /
  // server-loaded BrandRule[]. Empty `confirmedRules` is fine; we just fall
  // back to the raw IDs as labels (ReferenceSourceList still renders).
  const referenceItems: ReferenceSource[] = useMemo(() => {
    if (rules.length === 0) return [];
    const byId = new Map(confirmedRules.map((r) => [r.id, r]));
    return rules.map((id) => ({
      id,
      kind: "rule" as const,
      label: byId.get(id)?.summary ?? id,
    }));
  }, [rules, confirmedRules]);
  // Per-image brand-consistency score (0–100) stored in complianceReport.
  const score = version.complianceReport?.score;
  const scoreTone =
    score == null
      ? "neutral"
      : score >= 80
        ? "pass"
        : score >= 60
          ? "risk"
          : "danger";
  return (
    <div className="flex flex-col gap-3">
      <div
        className={`group relative aspect-square overflow-hidden rounded-2xl border bg-muted shadow-sm transition-shadow ${
          version.isFinal
            ? "border-accent ring-2 ring-accent"
            : "border-foreground/10 hover:shadow-md"
        }`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={version.imageUrl}
          alt={`版本 v${version.index}`}
          className="h-full w-full cursor-zoom-in object-cover"
          onClick={onZoom}
        />
        <div className="pointer-events-none absolute left-3 top-3 flex flex-wrap gap-2">
          {version.isFinal ? (
            <span className="rounded-full bg-accent px-3 py-1 font-mono text-[10px] uppercase tracking-wide text-ink shadow-sm">
              最终版
            </span>
          ) : null}
          {version.parentVersionId ? (
            <span className="rounded-full bg-background/80 px-3 py-1 font-mono text-[10px] uppercase tracking-wide text-foreground/70 backdrop-blur-sm">
              编辑衍生
            </span>
          ) : null}
        </div>
        {score != null ? (
          <div className="absolute right-3 top-3">
            <Badge tone={scoreTone} className="font-mono text-[10px]">
              品牌契合 {score}
            </Badge>
          </div>
        ) : null}
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-sm uppercase tracking-[0.15em] text-foreground">
          v{version.index}
        </span>
        <span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
          {version.width}×{version.height} · 规则 {rules.length}
        </span>
      </div>
      <label className="flex items-center gap-2 font-mono text-xs uppercase tracking-wide text-muted-foreground">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          className="accent-primary"
        />
        选入交付包
      </label>
      <div className="mt-auto flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={version.isFinal ? "ghost" : "primary"}
          disabled={version.isFinal || marking}
          onClick={onMarkFinal}
        >
          {marking ? <Spinner /> : null}
          {version.isFinal ? "已是最终版" : "标记最终版"}
        </Button>
        <a
          href={`/api/workspaces/${wsId}/generations/${version.generationId}/versions/${version.id}/download`}
          download
        >
          <Button size="sm" variant="outline">
            下载单图
          </Button>
        </a>
      </div>

      {/* P3.3 — surfaces which CONFIRMED rules fed into this version's prompt
          (params.appliedRuleIds / appliedRules). Uses the ReferenceSourceList
          business component — previously orphaned. */}
      {referenceItems.length > 0 ? (
        <ReferenceSourceList
          title="引用来源 · 规则"
          items={referenceItems}
          className="!gap-2 !p-3 text-xs"
        />
      ) : null}
    </div>
  );
}

function GenerationBlock({
  wsId,
  generation,
  selected,
  onToggle,
  onCompare,
  confirmedRules,
}: {
  wsId: string;
  generation: Generation;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onCompare: (a: GenerationVersion, b: GenerationVersion) => void;
  confirmedRules: BrandRule[];
}) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const finalReport = useMemo(() => {
    const fin = generation.versions.find((v) => v.isFinal);
    return (
      fin?.complianceReport ??
      generation.versions.find((v) => v.complianceReport)
        ?.complianceReport
    );
  }, [generation]);

  const markFinal = useMutation({
    mutationFn: (versionId: string) =>
      apiFetch<Generation>(
        `/api/workspaces/${wsId}/generations/${generation.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ versionId }),
        },
      ),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({
        queryKey: ["project-generations", wsId],
      });
    },
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : "标记失败"),
  });

  // §UX — one-click regenerate for a FAILED / non-compliant generation. Hits
  // the same re-enqueue endpoint the wizard uses (POST .../generations/[id]),
  // which resets status→PENDING and re-runs the whole generation.
  const regenerate = useMutation({
    mutationFn: () =>
      apiFetch<{ generation: Generation; jobId: string }>(
        `/api/workspaces/${wsId}/generations/${generation.id}`,
        { method: "POST" },
      ),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ["project-generations", wsId] });
    },
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : "重新生成失败"),
  });

  const [cmpA, setCmpA] = useState("");
  const [cmpB, setCmpB] = useState("");
  // Click-to-enlarge target for this generation's version cards.
  const [zoom, setZoom] = useState<GenerationVersion | null>(null);

  return (
    <Panel className="flex flex-col gap-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Eyebrow tone="accent">
            {SCENE_LABEL[generation.sceneType] ?? generation.sceneType}
          </Eyebrow>
          <h3 className="font-serif text-2xl leading-tight">
            {generation.sellingPoint}
          </h3>
          <p className="max-w-xl text-sm text-muted-foreground">
            场景 · {generation.scene}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <Badge tone={STATUS_TONE[generation.status] ?? "neutral"}>
            {generation.status}
          </Badge>
          <span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
            {new Date(generation.createdAt).toLocaleString("zh-CN")}
          </span>
        </div>
      </div>

      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : null}

      {/* §UX — readable failure + one-click regenerate. Previously a FAILED
          generation showed only a red status pill; the worker's reason lived
          in generation.error but was never surfaced here. */}
      {generation.status === "FAILED" ? (
        <div className="flex flex-col gap-3 rounded-2xl border border-destructive/30 bg-destructive/10 px-5 py-4">
          <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.2em] text-destructive">
            <span aria-hidden>⚠</span>
            <span>生成失败 · FAILED</span>
          </div>
          <p className="text-sm leading-relaxed text-destructive/90">
            {generation.error ?? "未知错误"}
          </p>
          <div>
            <Button
              size="sm"
              onClick={() => regenerate.mutate()}
              disabled={regenerate.isPending}
            >
              {regenerate.isPending ? <Spinner /> : null}
              重新生成
            </Button>
          </div>
        </div>
      ) : null}

      {generation.versions.length > 0 ? (
        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {generation.versions.map((v) => (
            <VersionCard
              key={v.id}
              wsId={wsId}
              version={v}
              selected={selected.has(v.id)}
              onToggleSelect={() => onToggle(v.id)}
              onMarkFinal={() => markFinal.mutate(v.id)}
              marking={
                markFinal.isPending && markFinal.variables === v.id
              }
              confirmedRules={confirmedRules}
              onZoom={() => setZoom(v)}
            />
          ))}
        </div>
      ) : null}

      <Lightbox
        src={zoom?.imageUrl ?? null}
        alt={zoom ? `版本 v${zoom.index}` : undefined}
        caption={
          zoom
            ? `v${zoom.index} · ${zoom.width}×${zoom.height}`
            : undefined
        }
        onClose={() => setZoom(null)}
      />

      {generation.versions.length >= 2 ? (
        <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-foreground/10 bg-muted px-5 py-4">
          <FieldLabel className="self-center">版本对比 · COMPARE</FieldLabel>
          <select
            className="h-9 rounded-full border border-foreground/15 bg-card px-4 font-mono text-xs uppercase tracking-wide"
            value={cmpA}
            onChange={(e) => setCmpA(e.target.value)}
          >
            <option value="">选择版本 A</option>
            {generation.versions.map((v) => (
              <option key={v.id} value={v.id}>
                v{v.index}
              </option>
            ))}
          </select>
          <select
            className="h-9 rounded-full border border-foreground/15 bg-card px-4 font-mono text-xs uppercase tracking-wide"
            value={cmpB}
            onChange={(e) => setCmpB(e.target.value)}
          >
            <option value="">选择版本 B</option>
            {generation.versions.map((v) => (
              <option key={v.id} value={v.id}>
                v{v.index}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            disabled={!cmpA || !cmpB || cmpA === cmpB}
            onClick={() => {
              const a = generation.versions.find((v) => v.id === cmpA);
              const b = generation.versions.find((v) => v.id === cmpB);
              if (a && b) onCompare(a, b);
            }}
          >
            并排对比
          </Button>
        </div>
      ) : null}

      {finalReport ? (
        <div className="flex flex-col gap-3">
          <FieldLabel>合规报告 · 最终版 / 已复检版本</FieldLabel>
          <ComplianceReportView report={finalReport} />
          {finalReport.overall === "FORBIDDEN" ? (
            <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-destructive/30 bg-destructive/10 px-5 py-3 text-sm text-destructive">
              <span className="flex-1">
                后置合规判为「违禁」。可在生成向导调整卖点 / 场景文案后重做,或直接重新生成换一张。
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => regenerate.mutate()}
                disabled={regenerate.isPending}
              >
                {regenerate.isPending ? <Spinner /> : null}
                重新生成
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="rounded-2xl border border-dashed border-foreground/15 bg-muted/40 px-5 py-4 text-sm text-muted-foreground">
          暂无合规报告（生成后复检会写入 GenerationVersion.complianceReport）。
        </p>
      )}
    </Panel>
  );
}

export function ProjectDetail({
  wsId,
  projectId,
  initialGenerations,
  confirmedRules = [],
}: {
  wsId: string;
  projectId: string;
  initialGenerations: Generation[];
  /** P3.3 — used by VersionCard to resolve appliedRule IDs to summaries. */
  confirmedRules?: BrandRule[];
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [compare, setCompare] = useState<
    [GenerationVersion, GenerationVersion] | null
  >(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const { data: generations = initialGenerations } = useQuery({
    queryKey: ["project-generations", wsId, projectId],
    queryFn: async () => {
      const fresh = await Promise.all(
        initialGenerations.map((g) =>
          apiFetch<{ generation: Generation }>(
            `/api/workspaces/${wsId}/generations/${g.id}`,
          ).then((r) => r.generation),
        ),
      );
      return fresh;
    },
    initialData: initialGenerations,
  });

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function runExport() {
    setExporting(true);
    setExportError(null);
    try {
      const res = await fetch(
        `/api/workspaces/${wsId}/projects/${projectId}/export`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ versionIds: [...selected] }),
        },
      );
      if (!res.ok) {
        let msg = `导出失败 (${res.status})`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body?.error) msg = body.error;
        } catch {
          /* ignore */
        }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "delivery.zip";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : "导出失败");
    } finally {
      setExporting(false);
    }
  }

  if (generations.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-3xl border border-dashed border-foreground/15 bg-card/50 px-6 py-16 text-center">
        <p className="font-serif text-xl text-foreground/80">还没有生成记录</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          前往「图片生成」（M3）并选择此项目后生成，记录会归集到这里。
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-foreground/10 bg-card/40 px-6 py-5">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-2xl text-foreground">
            {selected.size}
          </span>
          <span className="text-sm text-muted-foreground">
            个版本进入交付包（图片 + rules.json/md + compliance.json +
            manifest.json）。
          </span>
        </div>
        <div className="flex items-center gap-3">
          {exportError ? (
            <span className="text-sm text-destructive">
              {exportError}
            </span>
          ) : null}
          <Button
            size="sm"
            disabled={selected.size === 0 || exporting}
            onClick={runExport}
          >
            {exporting ? <Spinner /> : null}
            导出交付包 ZIP
          </Button>
        </div>
      </div>

      {generations.map((g) => (
        <GenerationBlock
          key={g.id}
          wsId={wsId}
          generation={g}
          selected={selected}
          onToggle={toggle}
          onCompare={(a, b) => setCompare([a, b])}
          confirmedRules={confirmedRules}
        />
      ))}

      {compare ? (
        <VersionCompare
          a={compare[0]}
          b={compare[1]}
          onClose={() => setCompare(null)}
        />
      ) : null}
    </div>
  );
}
