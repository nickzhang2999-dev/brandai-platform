import type { WatermarkOverlayInput } from "@brandai/contracts";
import type sharp from "sharp";

type SharpFactory = typeof sharp;

export type ResolvedWatermarkOverlay = WatermarkOverlayInput & {
  assetUrl?: string;
  assetMimeType?: string;
};

const DATA_URL_RE = /^data:([^;,]+)(;base64)?,(.*)$/s;

function dataUrlToBuffer(input: string): { buffer: Buffer; mimeType: string } | null {
  const match = DATA_URL_RE.exec(input);
  if (!match) return null;
  const mimeType = match[1] || "image/png";
  const raw = match[3] ?? "";
  return {
    buffer: Buffer.from(raw, match[2] ? "base64" : "utf8"),
    mimeType,
  };
}

async function loadImageBytes(src: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const data = dataUrlToBuffer(src);
  if (data) return data;
  const res = await fetch(src);
  if (!res.ok) throw new Error(`failed to fetch watermark image: ${res.status}`);
  const mimeType = res.headers.get("content-type") ?? "image/png";
  return { buffer: Buffer.from(await res.arrayBuffer()), mimeType };
}

function escapeXml(raw: string): string {
  return raw
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function normalizeColor(raw: string | undefined, fallback: string): string {
  const v = (raw || "").trim();
  if (/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(v)) return v;
  return fallback;
}

function offset(value: number, mode: "pixel" | "ratio", size: number): number {
  return mode === "ratio" ? value * size : value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function topLeftFor(
  overlay: WatermarkOverlayInput,
  canvas: { width: number; height: number },
  box: { width: number; height: number },
): { left: number; top: number } {
  const offsetX = offset(overlay.offsetX, overlay.positionMode, canvas.width);
  const offsetY = offset(overlay.offsetY, overlay.positionMode, canvas.height);
  const left =
    overlay.anchor === "top-left" || overlay.anchor === "bottom-left"
      ? offsetX
      : canvas.width - box.width - offsetX;
  const top =
    overlay.anchor === "top-left" || overlay.anchor === "top-right"
      ? offsetY
      : canvas.height - box.height - offsetY;
  return {
    left: Math.round(clamp(left, 0, Math.max(0, canvas.width - box.width))),
    top: Math.round(clamp(top, 0, Math.max(0, canvas.height - box.height))),
  };
}

function svgDataUri(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function textOverlaySvg(overlay: WatermarkOverlayInput): {
  buffer: Buffer;
  width: number;
  height: number;
} | null {
  const text = (overlay.text ?? "").trim();
  if (!text) return null;

  const fontSize = Math.max(1, overlay.fontSizePx);
  const padding = overlay.backgroundEnabled || overlay.borderEnabled ? Math.round(fontSize * 0.35) : 0;
  const width = Math.ceil(Math.max(fontSize * 2, text.length * fontSize * 0.68) + padding * 2);
  const height = Math.ceil(fontSize * 1.35 + padding * 2);
  const fill = normalizeColor(overlay.textColor, "#111827");
  const bg = normalizeColor(overlay.backgroundColor, "#FFFFFF");
  const stroke = normalizeColor(overlay.borderColor, "#7C5CFF");
  const borderWidth = overlay.borderEnabled ? overlay.borderWidth : 0;
  const radius = overlay.backgroundEnabled || overlay.borderEnabled ? overlay.cornerRadius : 0;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      ${
        overlay.backgroundEnabled
          ? `<rect x="${borderWidth / 2}" y="${borderWidth / 2}" width="${width - borderWidth}" height="${height - borderWidth}" rx="${radius}" fill="${bg}" fill-opacity="${overlay.opacity}" />`
          : ""
      }
      ${
        overlay.borderEnabled
          ? `<rect x="${borderWidth / 2}" y="${borderWidth / 2}" width="${width - borderWidth}" height="${height - borderWidth}" rx="${radius}" fill="none" stroke="${stroke}" stroke-width="${borderWidth}" stroke-opacity="${overlay.opacity}" />`
          : ""
      }
      <text x="${padding}" y="${padding + fontSize}" font-family="${escapeXml(overlay.fontFamily)}" font-size="${fontSize}" fill="${fill}" fill-opacity="${overlay.opacity}">${escapeXml(text)}</text>
    </svg>`;
  return { buffer: Buffer.from(svg), width, height };
}

async function imageOverlaySvg(
  sharp: SharpFactory,
  overlay: ResolvedWatermarkOverlay,
): Promise<{ buffer: Buffer; width: number; height: number } | null> {
  if (!overlay.assetUrl) return null;
  const source = await loadImageBytes(overlay.assetUrl);
  const meta = await sharp(source.buffer).metadata();
  if (!meta.width || !meta.height) return null;
  const width = Math.round(overlay.widthPx);
  const height = Math.max(1, Math.round((width * meta.height) / meta.width));
  const href = svgDataUri(source.buffer, overlay.assetMimeType || source.mimeType);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <image href="${href}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet" opacity="${overlay.opacity}" />
    </svg>`;
  return { buffer: Buffer.from(svg), width, height };
}

export async function applyWatermarksToImage(
  imageUrl: string,
  overlays: ResolvedWatermarkOverlay[],
): Promise<{ imageUrl: string; appliedAssetIds: string[] }> {
  const enabled = overlays.filter(
    (o) => o.enabled !== false && (o.assetUrl || (o.text ?? "").trim().length > 0),
  );
  if (enabled.length === 0) return { imageUrl, appliedAssetIds: [] };

  const sharpModule = await import("sharp");
  const sharp = sharpModule.default as SharpFactory;
  const base = await loadImageBytes(imageUrl);
  const baseImage = sharp(base.buffer);
  const meta = await baseImage.metadata();
  if (!meta.width || !meta.height) return { imageUrl, appliedAssetIds: [] };

  const composites: Array<{ input: Buffer; left: number; top: number }> = [];
  const appliedAssetIds: string[] = [];
  for (const overlay of enabled) {
    const imageLayer = await imageOverlaySvg(sharp, overlay);
    const textLayer = textOverlaySvg(overlay);
    for (const layer of [imageLayer, textLayer]) {
      if (!layer) continue;
      const pos = topLeftFor(
        overlay,
        { width: meta.width, height: meta.height },
        { width: layer.width, height: layer.height },
      );
      composites.push({ input: layer.buffer, left: pos.left, top: pos.top });
    }
    if (overlay.assetId && imageLayer) appliedAssetIds.push(overlay.assetId);
  }

  if (composites.length === 0) return { imageUrl, appliedAssetIds: [] };
  const output = await sharp(base.buffer).composite(composites).png().toBuffer();
  return {
    imageUrl: `data:image/png;base64,${output.toString("base64")}`,
    appliedAssetIds: Array.from(new Set(appliedAssetIds)),
  };
}
