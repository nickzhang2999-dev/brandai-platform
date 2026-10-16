"use client";
import { useEffect, useRef, useState } from "react";
import { exportOwnedSvg } from "../../lib/owned-canvas-export";
import { ownedImageName, type OwnedCanvasDocument, type OwnedCanvasItem } from "../../lib/owned-canvas-model";

const MAX_PIXELS = 16_777_216;
export async function resizeOwnedImage(document: OwnedCanvasDocument, itemId: string, width: number, height: number, fit: "contain" | "cover"): Promise<File> {
  if (!Number.isInteger(width) || !Number.isInteger(height) || Math.min(width, height) < 32 || Math.max(width, height) > 8192 || width * height > MAX_PIXELS) throw new Error("请选择 32–8192 像素且总量不超过 1677 万像素的尺寸。");
  const item = document.items.find(value => value.id === itemId); if (!item || item.kind !== "image") throw new Error("原图片已变化，请重新选择。");
  // Rasterize exactly the current selection first, including crop/flip/rotation.
  const original = await exportOwnedSvg(document, { itemIds: [itemId], expandGroups: false });
  const svgUrl = URL.createObjectURL(new Blob([original], { type: "image/svg+xml" })), bitmap = new Image();
  try { await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => { bitmap.src = ""; reject(new Error("原图绘制超时。")); }, 15_000); bitmap.onload = () => { clearTimeout(timer); resolve(); }; bitmap.onerror = () => { clearTimeout(timer); reject(new Error("原图暂不可读。")); }; bitmap.src = svgUrl; }); }
  catch (error) { URL.revokeObjectURL(svgUrl); throw error; }
  const canvas = window.document.createElement("canvas"); canvas.width = width; canvas.height = height;
  try {
    const context = canvas.getContext("2d"); if (!context) throw new Error("图片处理暂不可用，请重新打开。");
    context.imageSmoothingEnabled = true; context.imageSmoothingQuality = "high";
    const scale = fit === "contain" ? Math.min(width / bitmap.naturalWidth, height / bitmap.naturalHeight) : Math.max(width / bitmap.naturalWidth, height / bitmap.naturalHeight);
    context.drawImage(bitmap, (width - bitmap.naturalWidth * scale) / 2, (height - bitmap.naturalHeight * scale) / 2, bitmap.naturalWidth * scale, bitmap.naturalHeight * scale);
    const png = await new Promise<Blob>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("图片编码超时，原图仍保留。")), 20_000); canvas.toBlob(value => { clearTimeout(timer); value ? resolve(value) : reject(new Error("图片编码未完成。")); }, "image/png"); });
    return new File([png], `${ownedImageName(item)}-${width}x${height}.png`, { type: "image/png" });
  } finally { bitmap.src = ""; URL.revokeObjectURL(svgUrl); canvas.width = 0; canvas.height = 0; }
}
type Props = { document: OwnedCanvasDocument; item: OwnedCanvasItem; readOnly: boolean; onStore(file: File, sourceId: string): Promise<void>; onClose(): void };
export function OwnedImageResize({ document, item, readOnly, onStore, onClose }: Props) {
  const [width, setWidth] = useState(Math.round(item.w)), [height, setHeight] = useState(Math.round(item.h)), [fit, setFit] = useState<"contain" | "cover">("contain");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), root = useRef<HTMLDivElement>(null), lock = useRef(false);
  useEffect(() => { const before = window.document.activeElement as HTMLElement | null; root.current?.querySelector<HTMLInputElement>("input")?.focus(); return () => before?.focus(); }, []);
  async function run(store: boolean) {
    if (lock.current || readOnly) return; lock.current = true; setBusy(true); setError("");
    try {
      const file = await resizeOwnedImage(document, item.id, width, height, fit);
      if (store) { await onStore(file, item.id); onClose(); }
      else { const url = URL.createObjectURL(file), link = window.document.createElement("a"); link.href = url; link.download = file.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10_000); }
    } catch (failure) { setError(failure instanceof Error ? failure.message : "尺寸调整未完成，原图保留。"); }
    finally { lock.current = false; setBusy(false); }
  }
  return <div className="absolute inset-0 z-40 grid place-items-center bg-foreground/15 p-4" onPointerDown={event => event.stopPropagation()}>
    <div ref={root} role="dialog" aria-modal="true" aria-label="图片像素尺寸" className="w-full max-w-sm space-y-4 rounded-3xl border border-border bg-card p-6 shadow-lg" onKeyDown={event => { event.stopPropagation(); if (event.key === "Escape" && !busy) onClose(); }}>
      <div className="flex items-center gap-2"><h2 className="mr-auto font-semibold">{ownedImageName(item)} · 调整尺寸</h2><button aria-label="关闭尺寸工具" disabled={busy} onClick={onClose}>×</button></div>
      <p className="text-xs leading-6 text-muted-foreground">按当前裁切、翻转和旋转生成一份新图片，原图保留。尺寸调整使用像素缩放。</p>
      <div className="flex gap-3">{([['width', '宽度', width, setWidth], ['height', '高度', height, setHeight]] as const).map(([key, label, value, change]) => <label key={key} className="min-w-0 flex-1 space-y-2 text-xs">{label}<input aria-label={`图片像素${label}`} type="number" className="w-full rounded-xl border border-border bg-background p-3" min={32} max={8192} step={1} value={value} disabled={busy || readOnly} onChange={event => change(Number(event.target.value))} /></label>)}</div>
      <label className="block space-y-2 text-xs">画面适配<select aria-label="图片尺寸适配" className="w-full rounded-xl border border-border bg-background p-3" value={fit} disabled={busy} onChange={event => setFit(event.target.value as typeof fit)}><option value="contain">保留完整画面，空余处透明</option><option value="cover">填满画面，裁去超出部分</option></select></label>
      {error && <p role="alert" className="text-xs leading-6">{error}</p>}
      <div className="flex gap-2"><button className="rounded-full border border-border px-4 py-2 text-sm disabled:opacity-40" disabled={busy || readOnly} onClick={() => void run(false)}>下载 PNG</button><button className="ml-auto rounded-full bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-40" disabled={busy || readOnly} onClick={() => void run(true)}>{busy ? "正在处理…" : "保存并加入画布"}</button></div>
    </div>
  </div>;
}
