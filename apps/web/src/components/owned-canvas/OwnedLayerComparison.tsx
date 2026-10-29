"use client";

import { useEffect, useRef, useState } from "react";
import type { DecompositionTask } from "./owned-editor-api";
import { LAYER_COMPARISON_TIMEOUT_MS, loadOwnedLayerComparison, type LayerComparisonImages } from "./owned-layer-comparison";
import { ownedLayerQualityLabel } from "./owned-layer-options";

const control = "rounded-full border border-border bg-card px-3 py-2 text-xs text-foreground disabled:opacity-40";
const checkerboard = { backgroundColor: "rgb(var(--background))", backgroundImage: "conic-gradient(rgb(var(--muted)) 25%, transparent 0 50%, rgb(var(--muted)) 0 75%, transparent 0)", backgroundSize: "16px 16px" };
const warningLabels: Record<string, string> = { COMPOSITE_DIFFERENCE: "重合成与原图存在明显差异", LOCAL_DIFFERENCE: "部分区域有明显变化", WEAK_LAYER: "有图层内容很淡，请检查是否有用", NEAR_DUPLICATE_LAYERS: "有图层内容相近，请检查是否重复", QUALITY_CHECK_UNAVAILABLE: "这次未能完成像素检查" };

export function OwnedLayerQualitySummary({ task }: { task: DecompositionTask }) {
  const quality = task.quality;
  return <div className="space-y-1 rounded-xl bg-accent-soft p-3 text-xs leading-5" data-testid="owned-layer-quality" data-quality={quality?.status ?? "UNCHECKED"}>
    <p className="font-medium">{ownedLayerQualityLabel(task)}</p>
    <p>初检仅比较重合成像素，不判断文字是否正确、主体是否完整或分组是否合理，仍需人工对照。</p>
    {quality?.warnings.length ? <ul className="list-inside list-disc">{quality.warnings.map(warning => <li key={warning}>{warningLabels[warning] ?? "请查看原图与图层对照"}</li>)}</ul> : null}
    {quality?.metrics && <details><summary className="cursor-pointer text-muted-foreground">查看初检详情</summary><p className="mt-1 text-muted-foreground">按 {quality.sampleWidth} × {quality.sampleHeight} 像素预览检查；变化像素约 {(quality.metrics.changedPixelRatio * 100).toFixed(1)}%。{quality.regions.length > 0 && `有 ${quality.regions.length} 处区域需要留意，可在对照中标出。`}</p></details>}
  </div>;
}

/** Mounted only for the one explicitly opened task. All controls are local
 * inspection; they never mutate the canvas, task or provider request. */
export function OwnedLayerComparison({ task, workspaceId, projectId, userId }: {
  task: DecompositionTask; workspaceId: string; projectId: string; userId: string;
}) {
  const [attempt, setAttempt] = useState(0), [images, setImages] = useState<LayerComparisonImages | null>(null);
  const [error, setError] = useState(""), [hidden, setHidden] = useState<string[]>([]), [single, setSingle] = useState("");
  const [showRegions, setShowRegions] = useState(false);
  const sourceCanvas = useRef<HTMLCanvasElement>(null), compositeCanvas = useRef<HTMLCanvasElement>(null);
  // Polling may replace the task object; only immutable image identity reloads it.
  const identity = JSON.stringify([workspaceId, projectId, userId, task.requestId, task.assetId, task.assetSha256,
    task.sourceWidth, task.sourceHeight, task.layers.map(layer => [layer.assetId, layer.assetSha256, layer.order, layer.width, layer.height, layer.url])]);
  useEffect(() => {
    const controller = new AbortController(); let active = true, loaded: LayerComparisonImages | null = null;
    setImages(null); setError(""); setHidden([]); setSingle(""); setShowRegions(false);
    const timer = setTimeout(() => {
      if (!active) return;
      controller.abort(); setError("对照加载超时，可重试或下载 PSD 查看。原图和已保存图层不受影响。");
    }, LAYER_COMPARISON_TIMEOUT_MS);
    void loadOwnedLayerComparison(task, workspaceId, projectId, userId, controller.signal).then(value => {
      if (!active || controller.signal.aborted) { value.dispose(); return; }
      loaded = value; setImages(value);
    }).catch(reason => { if (active && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : "对照加载失败，请重试。"); })
      .finally(() => clearTimeout(timer));
    return () => { active = false; controller.abort(); clearTimeout(timer); loaded?.dispose(); };
    // Identity fully specifies the immutable task images and authenticated scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, attempt]);
  useEffect(() => {
    const source = sourceCanvas.current, composite = compositeCanvas.current;
    if (!images || !source || !composite) return;
    source.width = composite.width = images.width; source.height = composite.height = images.height;
    const sourceContext = source.getContext("2d"), context = composite.getContext("2d");
    if (!sourceContext || !context) { setError("浏览器暂时无法绘制对照，可下载 PSD 查看。"); return; }
    sourceContext.clearRect(0, 0, images.width, images.height); sourceContext.drawImage(images.source, 0, 0);
    // An empty canvas is intentional. The original never becomes a bottom layer.
    context.clearRect(0, 0, images.width, images.height);
    for (const layer of images.layers) if (single ? layer.assetId === single : !hidden.includes(layer.assetId)) context.drawImage(layer.bitmap, 0, 0);
    return () => { source.width = source.height = composite.width = composite.height = 0; };
  }, [images, hidden, single]);
  const layers = [...task.layers].sort((a, b) => a.order - b.order);
  return <div className="space-y-3" data-testid="owned-layer-comparison" data-request-id={task.requestId} data-state={error ? "error" : images ? "ready" : "loading"}>
    {!images && !error && <p role="status" className="text-xs text-muted-foreground">正在读取原图和已保存图层…</p>}
    {error && <div role="alert" className="space-y-2 rounded-xl bg-muted p-3 text-xs leading-5"><p>{error}</p><button type="button" className={control} onClick={() => setAttempt(value => value + 1)}>重新加载对照</button></div>}
    {images && !error && <>
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        <figure className="min-w-0"><figcaption className="mb-2 text-xs font-medium">原图</figcaption><canvas ref={sourceCanvas} role="img" aria-label="保留的原图" className="block h-auto w-full rounded-lg border border-border" style={checkerboard} /></figure>
        <figure className="min-w-0"><figcaption className="mb-2 text-xs font-medium">{single ? "单层查看" : hidden.length ? "已选图层合成" : "全部图层重合成"}</figcaption><div className="relative"><canvas ref={compositeCanvas} role="img" aria-label="图片图层对照" className="block h-auto w-full rounded-lg border border-border" style={checkerboard} />{showRegions && <svg aria-label="初检差异区域" className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${task.sourceWidth} ${task.sourceHeight}`}>{task.quality?.regions.map((region, index) => <rect key={index} x={region.left} y={region.top} width={region.width} height={region.height} fill="none" stroke="rgb(var(--primary))" strokeWidth="2" vectorEffect="non-scaling-stroke" />)}</svg>}</div></figure>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">仅用已保存图层重合成，棋盘格表示透明区域。预览最长边 1024 像素，请重点核对文字、主体和边缘。</p>
      {!!task.quality?.regions.length && <label className="flex items-center gap-2 text-xs"><input type="checkbox" className="accent-primary" checked={showRegions} onChange={event => setShowRegions(event.target.checked)} />标出初检差异区域（全图层结果）</label>}
      <label className="flex flex-wrap items-center gap-2 text-xs">查看范围<select aria-label="对照查看范围" className={control + " min-w-0 max-w-full"} value={single} onChange={event => setSingle(event.target.value)}><option value="">重合成</option>{layers.map(layer => <option key={layer.assetId} value={layer.assetId}>{layer.name || `图层 ${layer.order + 1}`}</option>)}</select></label>
      {!single && <fieldset className="flex flex-wrap gap-x-4 gap-y-2"><legend className="mb-2 text-xs text-muted-foreground">开关图层，检查是否混层或缺失</legend>{layers.map(layer => <label key={layer.assetId} className="flex min-w-0 items-center gap-2 text-xs"><input type="checkbox" className="accent-primary" checked={!hidden.includes(layer.assetId)} onChange={event => setHidden(values => event.target.checked ? values.filter(id => id !== layer.assetId) : [...values, layer.assetId])} /><span className="break-all">{layer.name || `图层 ${layer.order + 1}`}</span></label>)}</fieldset>}
      {(single || hidden.length > 0) && <button type="button" className={control} onClick={() => { setHidden([]); setSingle(""); }}>恢复全部图层</button>}
    </>}
  </div>;
}
