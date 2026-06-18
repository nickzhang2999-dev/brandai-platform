"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, FieldLabel, Input, Spinner } from "@brandai/ui";

/**
 * M3 · 图文分层 text-layer editor.
 *
 * Interactive overlay editor for ONE generated version image. AI models render
 * text (especially Chinese) unreliably, so the "layered" flow asks the model
 * for a clean text-free background and the user composes crisp, correct text
 * here as an editable layer — then exports the composited PNG.
 *
 * How it composites:
 *  - The source image is loaded via the SAME-ORIGIN version `download` proxy
 *    (`crossOrigin="anonymous"`) so drawing it to <canvas> does NOT taint the
 *    canvas and `toBlob` export works. If the image still can't be drawn
 *    (CORS/load failure), save+download are disabled and a hint is shown.
 *  - Headline (serif display, brand --primary color) + selling point (smaller)
 *    are drawn onto the canvas at a chosen vertical anchor (top/center/bottom).
 *
 * How it saves:
 *  - Exports the canvas to a PNG blob and POSTs multipart to the existing
 *    upload route `POST /api/workspaces/[wsId]/assets/upload`
 *    (fields: `file`, `category=SOCIAL`). Also offers a plain PNG download.
 *  - On success, `onSaved()` lets the parent refresh.
 */

type Anchor = "top" | "center" | "bottom";

const SERIF_STACK = '"Noto Serif SC", Georgia, serif';

/** Read the brand primary (burgundy) token at runtime into a canvas-usable
 *  color. The token holds space-separated RGB channels (e.g. "110 31 43"). */
function resolveBrandPrimary(): string {
  if (typeof window === "undefined") return "#6E1F2B";
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--primary")
    .trim();
  const parts = raw.split(/\s+/).map((n) => Number(n));
  if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
    return `rgb(${parts[0]}, ${parts[1]}, ${parts[2]})`;
  }
  return "#6E1F2B";
}

export function TextLayerEditor({
  wsId,
  genId,
  versionId,
  width,
  height,
  onSaved,
}: {
  wsId: string;
  genId: string;
  versionId: string;
  width: number;
  height: number;
  /** Called after a successful asset save so the parent can refresh. */
  onSaved?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const [headline, setHeadline] = useState("");
  const [sellingPoint, setSellingPoint] = useState("");
  const [anchor, setAnchor] = useState<Anchor>("bottom");
  const [scale, setScale] = useState(1); // headline size multiplier
  const [imageReady, setImageReady] = useState(false);
  const [tainted, setTainted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const brandColor = useRef(resolveBrandPrimary());

  // Same-origin proxy → safe to draw onto the canvas without tainting it.
  const src = `/api/workspaces/${wsId}/generations/${genId}/versions/${versionId}/download`;

  // (Re)draw the background + text whenever the inputs change.
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img || !imageReady) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const cx = canvas.width / 2;
    // Headline + selling point sizes scale off the canvas height so they look
    // consistent across the various channel aspect ratios.
    const headSize = Math.round(canvas.height * 0.075 * scale);
    const subSize = Math.round(headSize * 0.5);
    const pad = Math.round(canvas.height * 0.06);
    const gap = Math.round(headSize * 0.5);

    // Vertical anchor → baseline for the headline block.
    let headBaseline: number;
    if (anchor === "top") headBaseline = pad + headSize;
    else if (anchor === "center")
      headBaseline = canvas.height / 2 - gap / 2;
    else headBaseline = canvas.height - pad - (sellingPoint ? subSize + gap : 0);

    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";

    if (headline) {
      ctx.font = `700 ${headSize}px ${SERIF_STACK}`;
      // Soft shadow for legibility over busy backgrounds.
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.35)";
      ctx.shadowBlur = Math.round(headSize * 0.12);
      ctx.shadowOffsetY = Math.round(headSize * 0.04);
      ctx.fillStyle = brandColor.current;
      ctx.fillText(headline, cx, headBaseline);
      ctx.restore();
    }

    if (sellingPoint) {
      ctx.font = `400 ${subSize}px ${SERIF_STACK}`;
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.30)";
      ctx.shadowBlur = Math.round(subSize * 0.12);
      ctx.fillStyle = "#FFFFFF";
      ctx.fillText(sellingPoint, cx, headBaseline + subSize + gap);
      ctx.restore();
    }
  }, [headline, sellingPoint, anchor, scale, imageReady]);

  // Load the image once (same-origin proxy, crossOrigin set so export is clean).
  useEffect(() => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      imgRef.current = img;
      setImageReady(true);
    };
    img.onerror = () => {
      setImageReady(false);
      setTainted(true);
      setError("无法加载该图片用于编辑（可能跨域受限）。");
    };
    img.src = src;
    return () => {
      img.onload = null;
      img.onerror = null;
    };
  }, [src]);

  useEffect(() => {
    draw();
  }, [draw]);

  async function exportBlob(): Promise<Blob | null> {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    return new Promise<Blob | null>((resolve) => {
      try {
        canvas.toBlob((b) => resolve(b), "image/png");
      } catch {
        // SecurityError → canvas tainted. Fall back gracefully.
        setTainted(true);
        resolve(null);
      }
    });
  }

  async function handleDownload() {
    setError(null);
    const blob = await exportBlob();
    if (!blob) {
      setTainted(true);
      setError("导出失败：画布受跨域限制。");
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `composited-${versionId}.png`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleSave() {
    setError(null);
    setSavedOk(false);
    const blob = await exportBlob();
    if (!blob) {
      setTainted(true);
      setError("保存失败：画布受跨域限制，无法导出。可改用「下载」。");
      return;
    }
    setSaving(true);
    try {
      const form = new FormData();
      form.append(
        "file",
        new File([blob], `composited-${versionId}.png`, {
          type: "image/png",
        }),
      );
      // SOCIAL is an appropriate AssetCategory for a finished social-ready image.
      form.append("category", "SOCIAL");
      // Raw fetch (NOT apiFetch) so the browser sets the multipart boundary.
      const res = await fetch(`/api/workspaces/${wsId}/assets/upload`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        let detail = res.statusText;
        try {
          const body = (await res.json()) as { error?: string };
          if (body?.error) detail = body.error;
        } catch {
          /* ignore */
        }
        throw new Error(detail || `保存失败 (${res.status})`);
      }
      setSavedOk(true);
      onSaved?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const canExport = imageReady && !tainted;

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-foreground/10 bg-card p-5">
      <FieldLabel>加文字 · TEXT LAYER</FieldLabel>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
        {/* Preview canvas */}
        <div className="overflow-hidden rounded-2xl border border-foreground/10 bg-muted">
          <canvas
            ref={canvasRef}
            width={width || 1024}
            height={height || 1024}
            className="block h-auto w-full"
          />
          {!imageReady && !tainted ? (
            <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
              <Spinner /> 正在加载图片…
            </div>
          ) : null}
        </div>

        {/* Controls */}
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <FieldLabel>标题 · HEADLINE</FieldLabel>
            <Input
              value={headline}
              placeholder="主标题文案"
              onChange={(e) => setHeadline(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <FieldLabel>卖点 · SELLING POINT</FieldLabel>
            <Input
              value={sellingPoint}
              placeholder="副文案 / 卖点"
              onChange={(e) => setSellingPoint(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-2">
            <FieldLabel>位置 · POSITION</FieldLabel>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  { value: "top" as const, label: "顶部" },
                  { value: "center" as const, label: "居中" },
                  { value: "bottom" as const, label: "底部" },
                ]
              ).map((o) => {
                const on = anchor === o.value;
                return (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => setAnchor(o.value)}
                    className={`rounded-full border px-3 py-1.5 text-xs transition ${
                      on
                        ? "border-accent bg-accent text-ink"
                        : "border-foreground/15 text-muted-foreground hover:border-accent"
                    }`}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <FieldLabel>字号 · SIZE</FieldLabel>
            <input
              type="range"
              min={0.6}
              max={1.8}
              step={0.1}
              value={scale}
              onChange={(e) => setScale(Number(e.target.value))}
              className="w-full accent-[rgb(110_31_43)]"
            />
            <span className="font-mono text-[11px] text-muted-foreground">
              {Math.round(scale * 100)}%
            </span>
          </div>

          <div className="flex flex-col gap-2">
            <Button
              size="sm"
              disabled={!canExport || saving}
              onClick={handleSave}
            >
              {saving ? <Spinner /> : null}
              {savedOk ? "已保存为素材" : "保存为素材"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!canExport}
              onClick={handleDownload}
            >
              下载 PNG
            </Button>
          </div>

          {tainted ? (
            <p className="text-xs text-destructive">
              该图片受跨域限制，无法导出合成结果。
            </p>
          ) : null}
          {error ? (
            <p className="text-xs text-destructive">{error}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
