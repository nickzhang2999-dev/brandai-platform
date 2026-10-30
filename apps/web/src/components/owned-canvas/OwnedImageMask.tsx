"use client";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { PersistentImage } from "./owned-editor-api";
type Point = { x: number; y: number };
type Stroke = { points: Point[]; radius: number };
type Props = { source: PersistentImage; name: string; readOnly: boolean; initialInstruction?: string; description?: string; title?: string; onSubmit(mask: string, instruction: string): Promise<void>; onClose(): void };

/** Mask pixels use source dimensions. CSS-scaled painting never becomes a
 * screen-coordinate mask, and a submitted mask is frozen with its target. */
export function OwnedImageMask({ source, name, readOnly, initialInstruction, description, title, onSubmit, onClose }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null), strokes = useRef<Stroke[]>([]), active = useRef<{ id: number; stroke: Stroke } | null>(null);
  const [brush, setBrush] = useState(28), [count, setCount] = useState(0), [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [instruction, setInstruction] = useState(initialInstruction ?? "擦除涂抹区域中的内容，并自然补全背景"), lock = useRef(false), mounted = useRef(false);
  useEffect(() => {
    mounted.current = true; const image = new Image(), timeout = setTimeout(() => { if (mounted.current) setError("原图读取超时，请重新打开，原图保留。"); }, 20_000);
    image.onload = () => { clearTimeout(timeout); if (!mounted.current) return; if (image.naturalWidth !== source.width || image.naturalHeight !== source.height || source.width * source.height > 16_777_216) setError("原图尺寸与结果不一致或超过处理预算。"); else setReady(true); };
    image.onerror = () => { clearTimeout(timeout); if (mounted.current) setError("原图暂不可读，请读取最新素材后重试。"); }; image.src = source.url;
    return () => { mounted.current = false; clearTimeout(timeout); image.src = ""; };
  }, [source.url, source.width, source.height]);
  function render() {
    const node = canvas.current, context = node?.getContext("2d"); if (!node || !context) return;
    context.clearRect(0, 0, node.width, node.height); context.strokeStyle = "rgba(124,92,255,.65)"; context.fillStyle = context.strokeStyle; context.lineCap = "round"; context.lineJoin = "round";
    for (const stroke of strokes.current) {
      context.lineWidth = stroke.radius * 2;
      if (stroke.points.length === 1) { context.beginPath(); context.arc(stroke.points[0]!.x, stroke.points[0]!.y, stroke.radius, 0, Math.PI * 2); context.fill(); }
      else { context.beginPath(); stroke.points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y)); context.stroke(); }
    }
  }
  function point(event: PointerEvent<HTMLCanvasElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect(); return { x: Math.max(0, Math.min(source.width, (event.clientX - rect.left) / rect.width * source.width)), y: Math.max(0, Math.min(source.height, (event.clientY - rect.top) / rect.height * source.height)) };
  }
  function finish(event: PointerEvent<HTMLCanvasElement>) { if (active.current?.id !== event.pointerId) return; active.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); setCount(strokes.current.length); }
  async function submit() {
    if (!ready || readOnly || lock.current || !strokes.current.length || active.current) return; lock.current = true; setBusy(true); setError("");
    const mask = window.document.createElement("canvas"); mask.width = source.width; mask.height = source.height;
    try {
      const context = mask.getContext("2d"); if (!context) throw new Error("蒙版绘制暂不可用。");
      context.fillStyle = "black"; context.fillRect(0, 0, mask.width, mask.height); context.fillStyle = "white"; context.strokeStyle = "white"; context.lineCap = "round"; context.lineJoin = "round";
      for (const stroke of strokes.current) { context.lineWidth = stroke.radius * 2; if (stroke.points.length === 1) { context.beginPath(); context.arc(stroke.points[0]!.x, stroke.points[0]!.y, stroke.radius, 0, Math.PI * 2); context.fill(); } else { context.beginPath(); stroke.points.forEach((value, index) => index ? context.lineTo(value.x, value.y) : context.moveTo(value.x, value.y)); context.stroke(); } }
      const encoded = mask.toDataURL("image/png"); if ((encoded.length - encoded.indexOf(",") - 1) * 3 / 4 > 1024 * 1024) throw new Error("蒙版超过 1 MiB，请减少涂抹复杂度后再提交。");
      await onSubmit(encoded, instruction.trim()); if (mounted.current) onClose();
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : "局部修改未完成，原图和蒙版保留。"); }
    finally { mask.width = 0; mask.height = 0; lock.current = false; if (mounted.current) setBusy(false); }
  }
  return <div className="absolute inset-0 z-40 grid place-items-center bg-foreground/15 p-3" onPointerDown={event => event.stopPropagation()}>
    <section role="dialog" aria-modal="true" aria-label="图片蒙版擦除" className="max-h-[calc(100%-24px)] w-full max-w-lg space-y-3 overflow-y-auto rounded-3xl border border-border bg-card p-5 shadow-lg" onKeyDown={event => { event.stopPropagation(); if (event.key === "Escape" && !busy) onClose(); }}>
      <div className="flex items-center gap-2"><h2 className="mr-auto font-semibold">{title ?? `${name} · 擦除并补全`}</h2><button aria-label="关闭蒙版工具" disabled={busy} onClick={onClose}>×</button></div>
      <p className="text-xs leading-6 text-muted-foreground">{description ?? "涂抹需要修改的区域，结果保存为新图片，原图保留。"}</p>
      <div className="relative overflow-hidden rounded-2xl bg-muted" style={{ aspectRatio: `${source.width}/${source.height}`, width: `min(100%, calc(45dvh * ${source.width / source.height}))`, marginInline: "auto" }}>
        <img src={source.url} alt="待擦除原图" draggable={false} className="absolute inset-0 h-full w-full object-fill" />
        <canvas ref={canvas} data-testid="owned-inpaint-mask" width={source.width} height={source.height} className="absolute inset-0 h-full w-full touch-none" onPointerDown={event => { event.preventDefault(); if (!ready || busy || readOnly || active.current) return; if (strokes.current.length >= 200) { setError("涂抹笔迹较多，请撤销或清空后继续。"); return; } const stroke: Stroke = { points: [point(event)], radius: brush / event.currentTarget.getBoundingClientRect().width * source.width / 2 }; strokes.current.push(stroke); active.current = { id: event.pointerId, stroke }; event.currentTarget.setPointerCapture(event.pointerId); render(); }} onPointerMove={event => { const current = active.current; if (!current || current.id !== event.pointerId || current.stroke.points.length >= 2000) return; const value = point(event), previous = current.stroke.points.at(-1)!; if (Math.hypot(value.x - previous.x, value.y - previous.y) > .5) { current.stroke.points.push(value); render(); } }} onPointerUp={finish} onPointerCancel={event => { if (active.current?.id === event.pointerId) { strokes.current.pop(); finish(event); render(); } }} />
      </div>
      <div className="flex flex-wrap items-center gap-2"><label className="mr-auto text-xs">画笔范围 <input aria-label="蒙版画笔范围" type="range" min={4} max={80} value={brush} disabled={busy} onChange={event => setBrush(Number(event.target.value))} /></label><button className="text-xs underline" disabled={busy || !count} onClick={() => { strokes.current.pop(); render(); setCount(strokes.current.length); }}>撤销涂抹</button><button className="text-xs underline" disabled={busy || !count} onClick={() => { strokes.current = []; render(); setCount(0); }}>清空</button></div>
      <textarea aria-label="蒙版修改说明" className="min-h-20 w-full rounded-2xl border border-border bg-background p-3 text-sm" maxLength={4000} value={instruction} disabled={busy} onChange={event => setInstruction(event.target.value)} />
      {error && <p role="alert" className="text-xs leading-6">{error}</p>}
      <button className="w-full rounded-full bg-primary py-3 text-sm text-primary-foreground disabled:opacity-40" disabled={!ready || readOnly || busy || !count || !instruction.trim()} onClick={() => void submit()}>{busy ? "正在提交…" : "擦除并补全"}</button>
    </section>
  </div>;
}
