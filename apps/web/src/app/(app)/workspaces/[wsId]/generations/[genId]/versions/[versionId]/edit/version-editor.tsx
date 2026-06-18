"use client";

import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { EditOp, GenerationVersion } from "@brandai/contracts";
import {
  Button,
  Badge,
  Input,
  Textarea,
  Label,
  Spinner,
  Panel,
  SectionHeading,
  FieldLabel,
} from "@brandai/ui";
import { apiFetch } from "@/lib/client";
import { ComplianceReportView } from "@/components/compliance-report";

interface JobState {
  jobId: string;
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";
  progress: number;
  failedReason?: string;
}

interface Lineage {
  generationId: string;
  rootId: string | null;
  versions: GenerationVersion[];
}

/** Op metadata: label + which payload fields the panel collects. */
const OPS: {
  value: EditOp;
  label: string;
  hint: string;
  fields: ("prompt" | "color" | "element" | "region" | "size")[];
}[] = [
  {
    value: "REPLACE_BACKGROUND",
    label: "换背景",
    hint: "用提示词描述新的背景场景",
    fields: ["prompt"],
  },
  {
    value: "MOVE_PRODUCT",
    label: "调产品位置",
    hint: "描述产品应移动到的位置/构图",
    fields: ["prompt"],
  },
  {
    value: "EDIT_TEXT",
    label: "改文字",
    hint: "描述要替换/修改的文案内容",
    fields: ["prompt"],
  },
  {
    value: "RECOLOR",
    label: "调色",
    hint: "目标主色或调色指令",
    fields: ["color", "prompt"],
  },
  {
    value: "ADD_ELEMENT",
    label: "增元素",
    hint: "描述要新增的元素",
    fields: ["element", "prompt"],
  },
  {
    value: "REMOVE_ELEMENT",
    label: "删元素",
    hint: "描述要移除的元素",
    fields: ["element"],
  },
  {
    value: "OUTPAINT",
    label: "扩图",
    hint: "向外扩展画面，可描述补全内容",
    fields: ["prompt"],
  },
  {
    value: "INPAINT",
    label: "局部重绘",
    hint: "在图上框选要重绘的矩形区域，并描述内容",
    fields: ["region", "prompt"],
  },
  {
    value: "RESIZE",
    label: "多尺寸适配",
    hint: "选择目标渠道尺寸，导出一份内容的多尺寸版本",
    fields: ["size"],
  },
];

/**
 * Group the 9 EditOps by intent so the operation list reads as a structured
 * palette rather than a flat menu — mirrors the spec §6.4 grouping
 * (visual / textual / dimensional).
 */
const OP_GROUPS: { group: string; ops: EditOp[] }[] = [
  {
    group: "视觉调整 · VISUAL",
    ops: [
      "REPLACE_BACKGROUND",
      "MOVE_PRODUCT",
      "RECOLOR",
      "ADD_ELEMENT",
      "REMOVE_ELEMENT",
      "INPAINT",
      "OUTPAINT",
    ],
  },
  { group: "文案 · TEXT", ops: ["EDIT_TEXT"] },
  { group: "尺寸 · SIZE", ops: ["RESIZE"] },
];

/** Channel size presets for the RESIZE op. */
const SIZE_PRESETS: {
  group: string;
  items: { label: string; width: number; height: number }[];
}[] = [
  {
    group: "电商",
    items: [
      { label: "主图 1:1", width: 1200, height: 1200 },
      { label: "详情 3:4", width: 1200, height: 1600 },
    ],
  },
  {
    group: "社媒",
    items: [
      { label: "朋友圈 1:1", width: 1080, height: 1080 },
      { label: "竖版故事 9:16", width: 1080, height: 1920 },
      { label: "横版 16:9", width: 1920, height: 1080 },
    ],
  },
  {
    group: "活动 KV",
    items: [
      { label: "Banner 横幅", width: 1920, height: 640 },
      { label: "海报 2:3", width: 1200, height: 1800 },
    ],
  },
];

/** Normalized rectangular region [x, y, w, h] in 0..1 image space. */
interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function VersionEditor({
  wsId,
  genId,
  sourceVersion,
  initialLineage,
}: {
  wsId: string;
  genId: string;
  sourceVersion: GenerationVersion;
  initialLineage: Lineage;
}) {
  const [op, setOp] = useState<EditOp>("REPLACE_BACKGROUND");
  const [prompt, setPrompt] = useState("");
  const [color, setColor] = useState("");
  const [element, setElement] = useState("");
  const [region, setRegion] = useState<Region | null>(null);
  const [sizeIdx, setSizeIdx] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);

  const opMeta = useMemo(
    () => OPS.find((o) => o.value === op)!,
    [op],
  );

  // Poll the edit job + refreshed lineage until it terminates.
  const { data: poll } = useQuery({
    queryKey: ["version-edit", wsId, genId, sourceVersion.id, jobId],
    enabled: !!jobId,
    refetchInterval: (q) => {
      const s = q.state.data?.job?.status;
      if (s === "SUCCEEDED" || s === "FAILED") return false;
      return 1500;
    },
    queryFn: () =>
      apiFetch<{ lineage: Lineage; job?: JobState }>(
        `/api/workspaces/${wsId}/generations/${genId}/versions/${sourceVersion.id}/edit${
          jobId ? `?jobId=${jobId}` : ""
        }`,
      ),
  });

  const lineage = poll?.lineage ?? initialLineage;
  const job = poll?.job ?? null;
  const running =
    !!jobId && job?.status !== "SUCCEEDED" && job?.status !== "FAILED";

  // Newest child created since this editor opened (highest index, not the
  // source). Shown as the edit result.
  const newest = useMemo(() => {
    const childIds = new Set(
      initialLineage.versions.map((v) => v.id),
    );
    const fresh = lineage.versions.filter((v) => !childIds.has(v.id));
    return fresh.sort((a, b) => b.index - a.index)[0] ?? null;
  }, [lineage, initialLineage]);

  function buildPayload(): Record<string, unknown> {
    const p: Record<string, unknown> = {};
    if (opMeta.fields.includes("prompt") && prompt.trim()) {
      p.prompt = prompt.trim();
    }
    if (opMeta.fields.includes("color") && color.trim()) {
      p.color = color.trim();
    }
    if (opMeta.fields.includes("element") && element.trim()) {
      p.element = element.trim();
    }
    if (opMeta.fields.includes("region") && region) {
      // Normalized [x, y, w, h] in 0..1 image space.
      p.mask = [region.x, region.y, region.w, region.h];
    }
    if (opMeta.fields.includes("size") && sizeIdx) {
      const parts = sizeIdx.split(":");
      const gi = Number(parts[0]);
      const ii = Number(parts[1]);
      const group = SIZE_PRESETS[gi];
      const preset = group?.items[ii];
      if (group && preset) {
        p.width = preset.width;
        p.height = preset.height;
        p.channel = group.group;
        p.preset = preset.label;
      }
    }
    return p;
  }

  const canSubmit = useMemo(() => {
    if (running) return false;
    if (op === "INPAINT" && !region) return false;
    if (op === "RESIZE" && !sizeIdx) return false;
    if (
      opMeta.fields.includes("prompt") &&
      !opMeta.fields.includes("region") &&
      !opMeta.fields.includes("color") &&
      !opMeta.fields.includes("element") &&
      !prompt.trim()
    ) {
      return false;
    }
    return true;
  }, [op, region, sizeIdx, prompt, opMeta, running]);

  const submit = useMutation({
    mutationFn: () =>
      apiFetch<{ jobId: string; lineage: Lineage }>(
        `/api/workspaces/${wsId}/generations/${genId}/versions/${sourceVersion.id}/edit`,
        {
          method: "POST",
          body: JSON.stringify({ op, payload: buildPayload() }),
        },
      ),
    onSuccess: (r) => setJobId(r.jobId),
  });

  function resetForm() {
    setJobId(null);
    setPrompt("");
    setColor("");
    setElement("");
    setRegion(null);
    setSizeIdx(null);
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_24rem]">
      {/* Canvas / preview */}
      <div className="flex flex-col gap-6">
        <Panel className="flex flex-col gap-4 p-6 md:p-7">
          <SectionHeading
            eyebrow="SOURCE · 源图"
            title="源图预览"
            action={
              <Badge tone="neutral">
                版本 {sourceVersion.index + 1} · {sourceVersion.width}×
                {sourceVersion.height}
              </Badge>
            }
          />
          <RegionCanvas
            imageUrl={sourceVersion.imageUrl}
            selectable={op === "INPAINT"}
            region={region}
            onRegion={setRegion}
          />
          {op === "INPAINT" ? (
            <p className="text-xs text-muted-foreground">
              在图上拖拽框选要局部重绘的矩形区域。
              {region
                ? `已选区域：x ${pct(region.x)} · y ${pct(
                    region.y,
                  )} · w ${pct(region.w)} · h ${pct(region.h)}`
                : " 尚未框选。"}
            </p>
          ) : null}
        </Panel>

        {(running || newest || submit.isError) && (
          <Panel className="flex flex-col gap-4 p-6 md:p-7">
            <SectionHeading eyebrow="RESULT · 新版本" title="编辑结果" />
            {running ? (
              <div className="rounded-2xl border border-foreground/10 bg-muted px-5 py-4 text-sm text-muted-foreground">
                编辑中… {job?.status ?? "PENDING"} ·{" "}
                {job?.progress ?? 0}%
              </div>
            ) : null}
            {job?.status === "FAILED" ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-destructive/30 bg-destructive/10 px-5 py-4 text-sm text-destructive">
                <span>编辑失败：{job?.failedReason ?? "未知错误"}</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canSubmit || submit.isPending}
                  onClick={() => {
                    setJobId(null);
                    submit.mutate();
                  }}
                >
                  重试
                </Button>
              </div>
            ) : null}
            {submit.isError ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-destructive/30 bg-destructive/10 px-5 py-4 text-sm text-destructive">
                <span>{(submit.error as Error).message}</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canSubmit || submit.isPending}
                  onClick={() => submit.mutate()}
                >
                  重试
                </Button>
              </div>
            ) : null}
            {newest ? (
              <div className="flex flex-col gap-3 overflow-hidden rounded-2xl border border-accent ring-2 ring-accent">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={newest.imageUrl}
                  alt={`新版本 ${newest.index + 1}`}
                  className="w-full bg-muted object-contain"
                />
                <div className="flex flex-wrap items-center justify-between gap-2 p-3">
                  <span className="text-sm text-muted-foreground">
                    新版本 {newest.index + 1} · {newest.width}×
                    {newest.height}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    派生自版本 {sourceVersion.index + 1}
                  </span>
                </div>
              </div>
            ) : null}
            {newest ? (
              <Button size="sm" variant="ghost" onClick={resetForm}>
                继续编辑
              </Button>
            ) : null}
          </Panel>
        )}
      </div>

      {/* Operation panel */}
      <div className="flex flex-col gap-6">
        <Panel className="flex flex-col gap-5 p-6 md:p-7">
          <SectionHeading eyebrow="EDIT · 编辑操作" title="选择操作" />
          {OP_GROUPS.map((g) => (
            <div key={g.group} className="flex flex-col gap-2">
              <FieldLabel>{g.group}</FieldLabel>
              <div className="flex flex-col gap-2">
                {OPS.filter((o) => g.ops.includes(o.value)).map((o) => {
                  const on = op === o.value;
                  return (
                    <button
                      key={o.value}
                      type="button"
                      disabled={running}
                      onClick={() => {
                        setOp(o.value);
                        setRegion(null);
                        setSizeIdx(null);
                      }}
                      className={`flex items-center justify-between gap-3 rounded-2xl border px-4 py-3 text-left transition disabled:opacity-50 ${
                        on
                          ? "border-accent bg-accent/10 ring-1 ring-accent"
                          : "border-foreground/10 bg-card hover:border-accent"
                      }`}
                    >
                      <span className="font-serif text-base">{o.label}</span>
                      <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                        {o.value}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          <p className="text-sm text-muted-foreground">{opMeta.hint}</p>

          {opMeta.fields.includes("color") ? (
            <div className="flex flex-col gap-2">
              <Label>目标主色</Label>
              <Input
                value={color}
                placeholder="例如：#1F6F54 或 品牌主绿"
                onChange={(e) => setColor(e.target.value)}
              />
            </div>
          ) : null}

          {opMeta.fields.includes("element") ? (
            <div className="flex flex-col gap-2">
              <Label>
                {op === "REMOVE_ELEMENT" ? "要移除的元素" : "要新增的元素"}
              </Label>
              <Input
                value={element}
                placeholder={
                  op === "REMOVE_ELEMENT"
                    ? "例如：背景中的水印"
                    : "例如：右下角的促销标签"
                }
                onChange={(e) => setElement(e.target.value)}
              />
            </div>
          ) : null}

          {opMeta.fields.includes("size") ? (
            <div className="flex flex-col gap-3">
              <Label>渠道尺寸</Label>
              {SIZE_PRESETS.map((g, gi) => (
                <div key={g.group} className="flex flex-col gap-1.5">
                  <FieldLabel>{g.group}</FieldLabel>
                  <div className="flex flex-wrap gap-1.5">
                    {g.items.map((it, ii) => {
                      const key = `${gi}:${ii}`;
                      const on = sizeIdx === key;
                      return (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setSizeIdx(key)}
                          className={`rounded-full border px-3 py-1.5 font-mono text-[11px] uppercase tracking-wide transition ${
                            on
                              ? "border-accent bg-accent/10 text-foreground ring-1 ring-accent"
                              : "border-foreground/15 bg-muted text-muted-foreground hover:border-accent"
                          }`}
                        >
                          {it.label} · {it.width}×{it.height}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {opMeta.fields.includes("prompt") ? (
            <div className="flex flex-col gap-2">
              <Label>
                {op === "RECOLOR" || op === "ADD_ELEMENT"
                  ? "补充描述（可选）"
                  : "编辑提示词"}
              </Label>
              <Textarea
                value={prompt}
                placeholder={
                  op === "REPLACE_BACKGROUND"
                    ? "例如：极简米色影棚背景，柔和侧光"
                    : op === "INPAINT"
                      ? "例如：把框选区域替换为一束新鲜柠檬"
                      : "描述本次编辑的目标"
                }
                onChange={(e) => setPrompt(e.target.value)}
              />
            </div>
          ) : null}

          <Button
            disabled={!canSubmit || submit.isPending}
            onClick={() => submit.mutate()}
          >
            {submit.isPending || running ? <Spinner /> : null}
            生成新版本
          </Button>
          <p className="text-xs text-muted-foreground">
            每次编辑生成一个新的 GenerationVersion（parentVersionId
            指向当前版本），原图保留可回溯。
          </p>
        </Panel>

        {/* Version lineage */}
        <Panel className="flex flex-col gap-4 p-6 md:p-7">
          <SectionHeading eyebrow="LINEAGE · 版本链路" title="版本链路" />
          <ol className="flex flex-col gap-2.5">
            {lineage.versions.map((v) => {
              const isSource = v.id === sourceVersion.id;
              const isRoot = v.id === lineage.rootId;
              const isNew = newest?.id === v.id;
              return (
                <li
                  key={v.id}
                  className={`flex items-center gap-3 rounded-2xl border p-3 ${
                    isNew
                      ? "border-accent ring-1 ring-accent"
                      : isSource
                        ? "border-accent"
                        : "border-foreground/10"
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={v.imageUrl}
                    alt={`版本 ${v.index + 1}`}
                    className="h-14 w-14 shrink-0 rounded-xl bg-muted object-cover"
                  />
                  <div className="flex flex-col gap-0.5 text-xs">
                    <span className="font-mono uppercase tracking-wide text-foreground">
                      版本 {v.index + 1}
                      {isRoot ? " · 原图" : ""}
                      {isSource ? " · 当前源" : ""}
                      {isNew ? " · 本次新版本" : ""}
                    </span>
                    <span className="font-mono text-muted-foreground">
                      {v.width}×{v.height}
                      {v.parentVersionId
                        ? ` · 派生自 ${shortId(v.parentVersionId)}`
                        : ""}
                    </span>
                    {editLabel(v) ? (
                      <span className="text-muted-foreground">
                        操作：{editLabel(v)}
                      </span>
                    ) : null}
                  </div>
                  {v.isFinal ? (
                    <Badge tone="pass">最终版</Badge>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </Panel>

        {/* M5 · 生成后合规复检 */}
        <RecheckPanel
          wsId={wsId}
          genId={genId}
          version={newest ?? sourceVersion}
        />
      </div>
    </div>
  );
}

/**
 * M5 · 生成后复检 — re-run text + visual compliance on a finalized
 * GenerationVersion and persist the report into
 * `GenerationVersion.complianceReport`. Renders the stored report (if any)
 * and the freshly-rechecked one through the shared report view.
 */
function RecheckPanel({
  wsId,
  genId,
  version,
}: {
  wsId: string;
  genId: string;
  version: GenerationVersion;
}) {
  const recheck = useMutation({
    mutationFn: () =>
      apiFetch<GenerationVersion>(
        `/api/workspaces/${wsId}/generations/${genId}/versions/${version.id}/recheck`,
        { method: "POST" },
      ),
  });

  const report = recheck.data?.complianceReport ?? version.complianceReport;

  return (
    <Panel className="flex flex-col gap-4 p-6 md:p-7">
      <SectionHeading
        eyebrow="RECHECK · 合规复检"
        title="生成后合规复检"
        action={
          <Button
            size="sm"
            disabled={recheck.isPending}
            onClick={() => recheck.mutate()}
          >
            {recheck.isPending ? <Spinner /> : null}
            复检版本 {version.index + 1}
          </Button>
        }
      />
      <p className="text-xs text-muted-foreground">
        对该版本图文重新执行文案 + 图片层校验（Logo / 主色 / 禁用元素 /
        产品变形），结果写入版本的 complianceReport。
      </p>
      {recheck.error ? (
        <p className="text-sm text-destructive">
          {recheck.error instanceof Error
            ? recheck.error.message
            : "复检失败"}
        </p>
      ) : null}
      {report ? (
        <ComplianceReportView report={report} />
      ) : (
        <p className="text-sm text-muted-foreground">
          该版本尚无合规报告，点击「复检」生成。
        </p>
      )}
    </Panel>
  );
}

function pct(n: number) {
  return `${Math.round(n * 100)}%`;
}

function shortId(id: string) {
  return id.slice(0, 6);
}

/** Pull the recorded edit op label from a version's params, if any. */
function editLabel(v: GenerationVersion): string | null {
  const edit = (v.params as Record<string, unknown>)?.edit as
    | { op?: string }
    | undefined;
  if (!edit?.op) return null;
  return OPS.find((o) => o.value === edit.op)?.label ?? edit.op;
}

/**
 * Image with an optional drag-to-select rectangular overlay. Stores the
 * region normalized to 0..1 of the displayed image so it maps cleanly to
 * the backend `payload.mask` regardless of render size.
 */
function RegionCanvas({
  imageUrl,
  selectable,
  region,
  onRegion,
}: {
  imageUrl: string;
  selectable: boolean;
  region: Region | null;
  onRegion: (r: Region | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(
    null,
  );

  function rel(e: React.PointerEvent) {
    const box = ref.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)),
      y: Math.min(1, Math.max(0, (e.clientY - box.top) / box.height)),
    };
  }

  return (
    <div
      ref={ref}
      onPointerDown={(e) => {
        if (!selectable) return;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        const p = rel(e);
        setDrag(p);
        onRegion({ x: p.x, y: p.y, w: 0, h: 0 });
      }}
      onPointerMove={(e) => {
        if (!selectable || !drag) return;
        const p = rel(e);
        onRegion({
          x: Math.min(drag.x, p.x),
          y: Math.min(drag.y, p.y),
          w: Math.abs(p.x - drag.x),
          h: Math.abs(p.y - drag.y),
        });
      }}
      onPointerUp={() => setDrag(null)}
      className={`relative overflow-hidden rounded-2xl border border-foreground/10 bg-muted ${
        selectable ? "cursor-crosshair touch-none" : ""
      }`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={imageUrl}
        alt="源图"
        draggable={false}
        className="w-full select-none object-contain"
      />
      {selectable && region && region.w > 0 && region.h > 0 ? (
        <div
          className="pointer-events-none absolute border-2 border-accent bg-accent/20"
          style={{
            left: `${region.x * 100}%`,
            top: `${region.y * 100}%`,
            width: `${region.w * 100}%`,
            height: `${region.h * 100}%`,
          }}
        />
      ) : null}
    </div>
  );
}
