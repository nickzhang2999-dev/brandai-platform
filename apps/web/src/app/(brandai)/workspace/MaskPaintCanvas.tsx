"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 局部重画 · 蒙版绘制覆盖层 —— 迁移自 prd_agent 视觉创作的 MaskPaintCanvas，
 * 重做成 BrandAI 紫色设计语言（语义 token only）。在选中图片上涂抹要重绘的区域，
 * 填一句指令后「运行局部重画」：导出黑白蒙版 data-URI（白=重绘、黑=保留），
 * 交给工作台走真实 server-authoritative 改图链路（op=INPAINT，payload.mask）。
 *
 * 注意：导出只读取「蒙版画布」自身像素，从不读取底图像素，所以即便底图是跨域
 * S3 URL 也不会污染 canvas、不影响 toDataURL（CORS-safe）。
 */
export interface MaskPaintCanvasProps {
  /** 底图 src（仅作显示底图，导出时不读取其像素） */
  imageSrc: string;
  /** 底图自然宽（像素），蒙版按此尺寸导出 */
  imageWidth: number;
  /** 底图自然高（像素） */
  imageHeight: number;
  /** 提交中（禁用按钮、显示「提交中…」） */
  submitting?: boolean;
  /** 确认回调：蒙版 data-URI（白=重绘、黑=保留）+ 指令文本 */
  onConfirm: (maskDataUri: string, instruction: string) => void;
  /** 取消回调 */
  onCancel: () => void;
}

type Tool = "brush" | "eraser";

const BRUSH_SIZES = [10, 20, 40, 60, 80];
const DEFAULT_BRUSH_IDX = 2; // 40px
// 涂抹预览色 = destructive 红（功能性绘制色，canvas 2d 需具体 rgba，不走 CSS var）。
const PAINT_RGBA = "rgba(239,68,68,0.45)";

export function MaskPaintCanvas({
  imageSrc,
  imageWidth,
  imageHeight,
  submitting = false,
  onConfirm,
  onCancel,
}: MaskPaintCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [tool, setTool] = useState<Tool>("brush");
  const [brushIdx, setBrushIdx] = useState(DEFAULT_BRUSH_IDX);
  const [isDrawing, setIsDrawing] = useState(false);
  const [displaySize, setDisplaySize] = useState({ w: 0, h: 0 });
  const [hasPaint, setHasPaint] = useState(false);
  const [instruction, setInstruction] = useState("");
  const lastPosRef = useRef<{ x: number; y: number } | null>(null);

  const brushSize = BRUSH_SIZES[brushIdx]!;

  // ESC 取消（与工作台其它弹窗一致的可关闭性）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // 计算显示尺寸（适配容器，保持宽高比，最大不放大）。
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !imageWidth || !imageHeight) return;
    const observe = () => {
      const maxW = container.clientWidth - 48;
      const maxH = container.clientHeight - 220; // 留出工具栏 + 指令条
      if (maxW <= 0 || maxH <= 0) return;
      const scale = Math.min(maxW / imageWidth, maxH / imageHeight, 1);
      setDisplaySize({
        w: Math.round(imageWidth * scale),
        h: Math.round(imageHeight * scale),
      });
    };
    observe();
    const ro = new ResizeObserver(observe);
    ro.observe(container);
    return () => ro.disconnect();
  }, [imageWidth, imageHeight]);

  // 初始化画布（全透明 = 无蒙版）。
  useEffect(() => {
    const cvs = canvasRef.current;
    if (!cvs || !displaySize.w || !displaySize.h) return;
    cvs.width = displaySize.w;
    cvs.height = displaySize.h;
    const ctx = cvs.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, cvs.width, cvs.height);
  }, [displaySize.w, displaySize.h]);

  const getPos = useCallback((e: React.PointerEvent) => {
    const cvs = canvasRef.current;
    if (!cvs) return null;
    const rect = cvs.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, []);

  const drawAt = useCallback(
    (x: number, y: number) => {
      const cvs = canvasRef.current;
      const ctx = cvs?.getContext("2d");
      if (!ctx) return;
      ctx.beginPath();
      ctx.arc(x, y, brushSize / 2, 0, Math.PI * 2);
      if (tool === "brush") {
        ctx.fillStyle = PAINT_RGBA;
        ctx.globalCompositeOperation = "source-over";
      } else {
        ctx.globalCompositeOperation = "destination-out";
        ctx.fillStyle = "rgba(0,0,0,1)";
      }
      ctx.fill();
      ctx.globalCompositeOperation = "source-over";
    },
    [tool, brushSize],
  );

  const drawLine = useCallback(
    (from: { x: number; y: number }, to: { x: number; y: number }) => {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const steps = Math.max(1, Math.ceil(dist / (brushSize / 4)));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        drawAt(from.x + dx * t, from.y + dy * t);
      }
    },
    [drawAt, brushSize],
  );

  const handleDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      const pos = getPos(e);
      if (!pos) return;
      setIsDrawing(true);
      if (tool === "brush") setHasPaint(true);
      lastPosRef.current = pos;
      drawAt(pos.x, pos.y);
    },
    [getPos, drawAt, tool],
  );

  const handleMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isDrawing) return;
      e.preventDefault();
      const pos = getPos(e);
      if (!pos) return;
      if (lastPosRef.current) drawLine(lastPosRef.current, pos);
      lastPosRef.current = pos;
    },
    [isDrawing, getPos, drawLine],
  );

  // 一笔结束后按「真实像素」重算 hasPaint —— 橡皮擦把可见笔迹全擦掉时必须回落到
  // false,否则确认按钮仍可点、会提交一张全黑蒙版触发「无重绘区」的空 INPAINT。
  const recomputeHasPaint = useCallback(() => {
    const cvs = canvasRef.current;
    const ctx = cvs?.getContext("2d");
    if (!ctx || !cvs) return;
    const d = ctx.getImageData(0, 0, cvs.width, cvs.height).data;
    let painted = false;
    for (let i = 3; i < d.length; i += 4) {
      if (d[i]! > 10) {
        painted = true;
        break;
      }
    }
    setHasPaint(painted);
  }, []);

  const handleUp = useCallback(() => {
    setIsDrawing(false);
    lastPosRef.current = null;
    recomputeHasPaint();
  }, [recomputeHasPaint]);

  const handleClear = useCallback(() => {
    const cvs = canvasRef.current;
    const ctx = cvs?.getContext("2d");
    if (ctx && cvs) ctx.clearRect(0, 0, cvs.width, cvs.height);
    setHasPaint(false);
  }, []);

  // 导出黑白蒙版（原图尺寸，白=重绘、黑=保留）。OpenAI /images/edits 侧的「涂抹区
  // 透明」归一在 AI 服务用 Pillow 完成（也负责把蒙版缩放到真实图片像素）。
  const handleConfirm = useCallback(() => {
    if (!hasPaint || !instruction.trim() || submitting) return;
    const cvs = canvasRef.current;
    const ctx = cvs?.getContext("2d");
    if (!ctx || !cvs) return;

    const out = document.createElement("canvas");
    out.width = imageWidth;
    out.height = imageHeight;
    const outCtx = out.getContext("2d");
    if (!outCtx) return;
    outCtx.fillStyle = "#000000";
    outCtx.fillRect(0, 0, imageWidth, imageHeight);

    const srcData = ctx.getImageData(0, 0, cvs.width, cvs.height);
    const scaleX = imageWidth / cvs.width;
    const scaleY = imageHeight / cvs.height;
    const outData = outCtx.getImageData(0, 0, imageWidth, imageHeight);
    for (let y = 0; y < imageHeight; y++) {
      for (let x = 0; x < imageWidth; x++) {
        const sx = Math.min(Math.floor(x / scaleX), cvs.width - 1);
        const sy = Math.min(Math.floor(y / scaleY), cvs.height - 1);
        const srcIdx = (sy * cvs.width + sx) * 4;
        if (srcData.data[srcIdx + 3]! > 10) {
          const dstIdx = (y * imageWidth + x) * 4;
          outData.data[dstIdx] = 255;
          outData.data[dstIdx + 1] = 255;
          outData.data[dstIdx + 2] = 255;
          outData.data[dstIdx + 3] = 255;
        }
      }
    }
    outCtx.putImageData(outData, 0, 0);
    onConfirm(out.toDataURL("image/png"), instruction.trim());
  }, [hasPaint, instruction, submitting, imageWidth, imageHeight, onConfirm]);

  const canRun = hasPaint && !!instruction.trim() && !submitting;

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-foreground/45 p-6 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="flex w-full max-w-[min(92vw,1100px)] flex-col items-center"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 工具栏 */}
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-card px-3 py-2 shadow-[0_14px_40px_rgba(30,30,60,0.14)]">
          <button
            type="button"
            onClick={() => setTool("brush")}
            className={[
              "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
              tool === "brush"
                ? "bg-destructive/15 text-destructive"
                : "text-muted-foreground hover:bg-muted",
            ].join(" ")}
          >
            <BrushIcon /> 画笔
          </button>
          <button
            type="button"
            onClick={() => setTool("eraser")}
            className={[
              "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
              tool === "eraser"
                ? "bg-accent-soft text-primary"
                : "text-muted-foreground hover:bg-muted",
            ].join(" ")}
          >
            <EraserIcon /> 橡皮
          </button>

          <span className="mx-1 h-5 w-px bg-border" />

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setBrushIdx((i) => Math.max(0, i - 1))}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted"
              aria-label="缩小笔刷"
            >
              −
            </button>
            <span
              className="rounded-full border border-border"
              style={{
                width: Math.max(14, brushSize * 0.45),
                height: Math.max(14, brushSize * 0.45),
                background:
                  tool === "brush" ? PAINT_RGBA : "rgba(124,92,255,0.18)",
              }}
            />
            <button
              type="button"
              onClick={() =>
                setBrushIdx((i) => Math.min(BRUSH_SIZES.length - 1, i + 1))
              }
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted"
              aria-label="放大笔刷"
            >
              +
            </button>
            <span className="text-[10px] tabular-nums text-muted-foreground">
              {brushSize}px
            </span>
          </div>

          <span className="mx-1 h-5 w-px bg-border" />

          <button
            type="button"
            onClick={handleClear}
            className="rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted"
          >
            清空
          </button>
        </div>

        <p className="mb-2 text-xs text-muted-foreground">
          在图上涂抹需要重绘的区域（红色），填一句指令后点「运行局部重画」。
        </p>

        {/* 画布区 */}
        {displaySize.w > 0 && displaySize.h > 0 ? (
          <div
            className="relative overflow-hidden rounded-2xl border border-border shadow-[0_24px_70px_rgba(30,30,60,0.22)]"
            style={{ width: displaySize.w, height: displaySize.h }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageSrc}
              alt="底图"
              draggable={false}
              className="pointer-events-none absolute inset-0 h-full w-full select-none object-contain"
            />
            <canvas
              ref={canvasRef}
              className="absolute inset-0 h-full w-full"
              style={{ cursor: "crosshair", touchAction: "none" }}
              onPointerDown={handleDown}
              onPointerMove={handleMove}
              onPointerUp={handleUp}
              onPointerCancel={handleUp}
              onPointerLeave={handleUp}
            />
          </div>
        ) : (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            正在准备画布…
          </div>
        )}

        {/* 指令 + 操作 */}
        <div className="mt-3 flex w-full max-w-[640px] items-center gap-2">
          <input
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleConfirm();
            }}
            placeholder="这块区域改成…（如：换成纯色米白背景）"
            className="h-11 flex-1 rounded-xl border border-border bg-card px-3 text-sm text-foreground outline-none focus:border-primary/40 focus:shadow-[0_0_0_4px_rgba(124,92,255,0.08)]"
          />
          <button
            type="button"
            onClick={onCancel}
            className="h-11 shrink-0 rounded-xl border border-border bg-card px-4 text-sm text-muted-foreground transition-colors hover:bg-muted"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!canRun}
            className="h-11 shrink-0 rounded-xl bg-gradient-to-br from-primary to-accent px-5 text-sm font-medium text-primary-foreground shadow-[0_8px_20px_rgba(124,92,255,0.24)] disabled:opacity-60"
          >
            {submitting ? "提交中…" : "运行局部重画"}
          </button>
        </div>
      </div>
    </div>
  );
}

function BrushIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M9.5 14.5 3 21M14 4l6 6-7.5 7.5a3 3 0 0 1-4.24 0l-1.76-1.76a3 3 0 0 1 0-4.24L14 4Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function EraserIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="m4 16 6 6h8M4 16 14 6l6 6-8 8M4 16l4 4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
