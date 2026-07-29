"use client";

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  AssetInvocationMode,
  ExactAssetTransform,
} from "@brandai/contracts";

export type WorkspaceResourceUsage = {
  id: string;
  fileName?: string;
  thumbUrl?: string;
  libraryKind: "MATERIAL" | "TEMPLATE";
  mode: AssetInvocationMode;
  exactTransform: ExactAssetTransform;
};

const MODE_META: Record<
  AssetInvocationMode,
  { label: string; short: string; hint: string }
> = {
  EXACT: {
    label: "锁定使用",
    short: "锁定",
    hint: "主体身份不变；允许旋转、缩放、裁切和局部显示。",
  },
  ADAPTIVE: {
    label: "智能融合",
    short: "融合",
    hint: "真实交给模型融合；外观和细节可能发生变化。",
  },
  REFERENCE: {
    label: "仅参考",
    short: "参考",
    hint: "只影响风格、配色和构图，不保证主体出现。",
  },
};

export function ResourceUsagePanel({
  open,
  resources,
  frame,
  onOpenChange,
  onAddMaterial,
  onAddReference,
  onModeChange,
  onTransformChange,
  onRemove,
}: {
  open: boolean;
  resources: WorkspaceResourceUsage[];
  frame: { width: number; height: number; label: string };
  onOpenChange: (open: boolean) => void;
  onAddMaterial: () => void;
  onAddReference: () => void;
  onModeChange: (assetId: string, mode: AssetInvocationMode) => void;
  onTransformChange: (assetId: string, transform: ExactAssetTransform) => void;
  onRemove: (assetId: string, libraryKind: "MATERIAL" | "TEMPLATE") => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = resources.find((resource) => resource.id === editingId);
  const exactCount = resources.filter(
    (resource) => resource.mode === "EXACT",
  ).length;
  const modelCount = resources.length - exactCount;

  return (
    <>
      <div
        className="absolute left-4 top-4 z-30"
        data-testid="resource-usage-panel"
        onPointerDown={(event) => event.stopPropagation()}
      >
        {open ? (
          <section className="flex max-h-[calc(100vh-9rem)] w-[320px] flex-col overflow-hidden rounded-3xl border border-border bg-card/95 shadow-[0_16px_50px_rgba(30,30,60,0.14)] backdrop-blur">
            <header className="border-b border-border p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold">本次创作资源</h2>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    锁定 {exactCount} · 模型输入 {modelCount}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onOpenChange(false)}
                  aria-label="收起创作资源"
                  className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"
                >
                  −
                </button>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={onAddMaterial}
                  className="rounded-full bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground"
                >
                  添加素材
                </button>
                <button
                  type="button"
                  onClick={onAddReference}
                  className="rounded-full border border-border px-3 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted"
                >
                  添加参考图
                </button>
              </div>
            </header>
            <div className="flex-1 space-y-3 overflow-y-auto p-3">
              {resources.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border p-5 text-center">
                  <p className="text-xs font-medium">尚未添加创作资源</p>
                  <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                    素材默认锁定使用；参考图默认只参考，也可以切换为智能融合。
                  </p>
                </div>
              ) : (
                resources.map((resource) => {
                  const meta = MODE_META[resource.mode];
                  return (
                    <article
                      key={resource.id}
                      className="rounded-2xl border border-border bg-background p-2.5"
                    >
                      <div className="flex items-center gap-2">
                        <div className="h-11 w-11 shrink-0 overflow-hidden rounded-xl border border-border bg-muted">
                          {resource.thumbUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={resource.thumbUrl}
                              alt={resource.fileName ?? "资源"}
                              className="h-full w-full object-cover"
                            />
                          ) : null}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-semibold">
                            {resource.fileName ?? "未命名资源"}
                          </div>
                          <div className="mt-0.5 text-[10px] text-muted-foreground">
                            {resource.libraryKind === "MATERIAL"
                              ? "素材库"
                              : "参考图库"}{" "}
                            · {meta.short}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            onRemove(resource.id, resource.libraryKind)
                          }
                          aria-label="移除资源"
                          className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-destructive"
                        >
                          ×
                        </button>
                      </div>
                      <div className="mt-2 grid grid-cols-3 gap-1">
                        {(["EXACT", "ADAPTIVE", "REFERENCE"] as const).map(
                          (mode) => (
                            <button
                              key={mode}
                              type="button"
                              title={MODE_META[mode].hint}
                              onClick={() => onModeChange(resource.id, mode)}
                              className={[
                                "rounded-lg border px-1 py-1.5 text-[10px] font-semibold transition-colors",
                                resource.mode === mode
                                  ? "border-primary bg-accent-soft text-primary"
                                  : "border-border text-muted-foreground hover:border-primary/30",
                              ].join(" ")}
                            >
                              {MODE_META[mode].short}
                            </button>
                          ),
                        )}
                      </div>
                      <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
                        {meta.hint}
                      </p>
                      {resource.mode === "EXACT" ? (
                        <button
                          type="button"
                          onClick={() => setEditingId(resource.id)}
                          className="mt-2 w-full rounded-full border border-primary/25 px-3 py-1.5 text-[11px] font-semibold text-primary hover:bg-accent-soft"
                        >
                          调整位置、旋转与局部
                        </button>
                      ) : null}
                    </article>
                  );
                })
              )}
            </div>
            <footer className="border-t border-border px-4 py-3 text-[10px] leading-4 text-muted-foreground">
              锁定素材不会发送给模型；融合与参考会作为真实图片输入。
            </footer>
          </section>
        ) : null}
      </div>
      {editing ? (
        <ExactAssetEditor
          resource={editing}
          frame={frame}
          onCancel={() => setEditingId(null)}
          onSave={(transform) => {
            onTransformChange(editing.id, transform);
            setEditingId(null);
          }}
        />
      ) : null}
    </>
  );
}

function ExactAssetEditor({
  resource,
  frame,
  onCancel,
  onSave,
}: {
  resource: WorkspaceResourceUsage;
  frame: { width: number; height: number; label: string };
  onCancel: () => void;
  onSave: (transform: ExactAssetTransform) => void;
}) {
  const [draft, setDraft] = useState(resource.exactTransform);
  const previewRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => setDraft(resource.exactTransform), [resource]);

  function setNumber(
    key: "xRatio" | "yRatio" | "widthRatio" | "rotationDeg" | "zIndex",
    value: number,
  ) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function onPreviewPointer(event: ReactPointerEvent<HTMLDivElement>) {
    const preview = previewRef.current;
    if (!preview) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = preview.getBoundingClientRect();
    setDraft((current) => ({
      ...current,
      xRatio: Math.max(
        -0.5,
        Math.min(1.5, (event.clientX - rect.left) / rect.width),
      ),
      yRatio: Math.max(
        -0.5,
        Math.min(1.5, (event.clientY - rect.top) / rect.height),
      ),
    }));
  }

  const previewAspect = frame.width / frame.height;
  const previewStyle = {
    // Keep the preview inside its grid track. A vw-based width can be wider
    // than the left column after reserving the 330px controls panel, which
    // makes CSS Grid expand the first track and clip the controls on zoomed or
    // narrower viewports.
    width:
      previewAspect >= 1
        ? "min(680px, 100%)"
        : `min(${Math.max(240, Math.round(620 * previewAspect))}px, 100%)`,
    aspectRatio: `${frame.width}/${frame.height}`,
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/35 p-4 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="grid max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-6xl grid-cols-1 overflow-y-auto rounded-3xl border border-border bg-card shadow-[0_24px_70px_rgba(30,30,60,0.2)] md:grid-cols-[minmax(0,1fr)_minmax(280px,330px)] md:overflow-hidden"
        onClick={(event) => event.stopPropagation()}
      >
        <main className="flex min-h-[360px] min-w-0 flex-col items-center justify-center overflow-hidden bg-muted/35 p-4 md:min-h-[min(560px,calc(100vh-2rem))] md:p-6">
          <div className="mb-3 flex w-full max-w-3xl items-center justify-between text-xs">
            <span className="font-semibold">输出画框 · {frame.label}</span>
            <span className="text-muted-foreground">
              {frame.width}×{frame.height}
            </span>
          </div>
          <div
            ref={previewRef}
            onPointerDown={onPreviewPointer}
            onPointerMove={(event) => {
              if (event.buttons === 1) onPreviewPointer(event);
            }}
            className="relative overflow-hidden border border-border bg-card shadow-inner"
            style={previewStyle}
          >
            {resource.thumbUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={resource.thumbUrl}
                alt={resource.fileName ?? "锁定素材"}
                draggable={false}
                className="pointer-events-none absolute h-auto select-none"
                style={{
                  left: `${draft.xRatio * 100}%`,
                  top: `${draft.yRatio * 100}%`,
                  width: `${draft.widthRatio * 100}%`,
                  transform: `translate(-50%, -50%) rotate(${draft.rotationDeg}deg) scaleX(${draft.flipX ? -1 : 1})`,
                  clipPath: `inset(${draft.crop.top * 100}% ${draft.crop.right * 100}% ${draft.crop.bottom * 100}% ${draft.crop.left * 100}%)`,
                }}
              />
            ) : null}
            <span
              className="pointer-events-none absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-card bg-primary shadow"
              style={{
                left: `${draft.xRatio * 100}%`,
                top: `${draft.yRatio * 100}%`,
              }}
            />
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            在画框中拖动素材中心；画框外的部分会被确定性裁掉。
          </p>
        </main>
        <aside className="min-w-0 border-t border-border p-5 md:overflow-y-auto md:border-l md:border-t-0">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold">锁定素材布局</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                主体身份和可见内容不由 AI 重绘。
              </p>
            </div>
            <button
              type="button"
              onClick={onCancel}
              className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"
            >
              ×
            </button>
          </div>
          <div className="mt-5 space-y-4">
            <RangeControl
              label="水平位置"
              min={-0.5}
              max={1.5}
              step={0.01}
              value={draft.xRatio}
              valueLabel={`${Math.round(draft.xRatio * 100)}%`}
              onChange={(value) => setNumber("xRatio", value)}
            />
            <RangeControl
              label="垂直位置"
              min={-0.5}
              max={1.5}
              step={0.01}
              value={draft.yRatio}
              valueLabel={`${Math.round(draft.yRatio * 100)}%`}
              onChange={(value) => setNumber("yRatio", value)}
            />
            <RangeControl
              label="显示宽度"
              min={0.05}
              max={1.5}
              step={0.01}
              value={draft.widthRatio}
              valueLabel={`${Math.round(draft.widthRatio * 100)}%`}
              onChange={(value) => setNumber("widthRatio", value)}
            />
            <RangeControl
              label="旋转"
              min={-180}
              max={180}
              step={1}
              value={draft.rotationDeg}
              valueLabel={`${Math.round(draft.rotationDeg)}°`}
              onChange={(value) => setNumber("rotationDeg", value)}
            />
            <div>
              <div className="mb-2 text-xs font-semibold">局部显示</div>
              <div className="grid grid-cols-2 gap-2">
                {(["left", "right", "top", "bottom"] as const).map((side) => (
                  <label
                    key={side}
                    className="rounded-xl border border-border bg-background px-3 py-2 text-[10px] text-muted-foreground"
                  >
                    {side === "left"
                      ? "裁左"
                      : side === "right"
                        ? "裁右"
                        : side === "top"
                          ? "裁上"
                          : "裁下"}
                    <input
                      type="number"
                      min={0}
                      max={0.9}
                      step={0.01}
                      value={draft.crop[side]}
                      onChange={(event) => {
                        const requested = Math.max(
                          0,
                          Math.min(0.9, Number(event.target.value)),
                        );
                        setDraft((current) => {
                          const opposite =
                            side === "left"
                              ? "right"
                              : side === "right"
                                ? "left"
                                : side === "top"
                                  ? "bottom"
                                  : "top";
                          return {
                            ...current,
                            crop: {
                              ...current.crop,
                              [side]: Math.min(
                                requested,
                                0.97 - current.crop[opposite],
                              ),
                            },
                          };
                        });
                      }}
                      className="mt-1 h-7 w-full bg-transparent text-xs font-semibold text-foreground outline-none"
                    />
                  </label>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    flipX: !current.flipX,
                  }))
                }
                className={[
                  "rounded-xl border px-3 py-2 text-xs font-semibold",
                  draft.flipX
                    ? "border-primary bg-accent-soft text-primary"
                    : "border-border text-muted-foreground",
                ].join(" ")}
              >
                水平镜像
              </button>
              <label className="rounded-xl border border-border px-3 py-2 text-xs text-muted-foreground">
                图层
                <input
                  type="number"
                  min={-100}
                  max={100}
                  value={draft.zIndex}
                  onChange={(event) =>
                    setNumber("zIndex", Number(event.target.value))
                  }
                  className="ml-2 w-12 bg-transparent font-semibold text-foreground outline-none"
                />
              </label>
            </div>
          </div>
          <div className="mt-6 flex gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="h-10 flex-1 rounded-full border border-border text-sm text-muted-foreground hover:bg-muted"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => onSave(draft)}
              className="h-10 flex-1 rounded-full bg-primary text-sm font-semibold text-primary-foreground"
            >
              保存布局
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}

function RangeControl({
  label,
  value,
  valueLabel,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  valueLabel: string;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <span className="flex items-center justify-between text-xs font-semibold">
        {label}
        <span className="font-normal text-muted-foreground">{valueLabel}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="mt-2 w-full accent-primary"
      />
    </label>
  );
}
