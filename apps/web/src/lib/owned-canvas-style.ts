import type { OwnedCanvasItem } from "./owned-canvas-model";

/** Local fonts only: canvas preview and self-contained SVG use the same stack. */
const LOCAL_FONTS = {
  sans: "Arial, Helvetica, sans-serif",
  serif: "Georgia, Times New Roman, serif",
  mono: "Courier New, Courier, monospace",
} as const;

export function getOwnedFontFamily(family: OwnedCanvasItem["fontFamily"]): string {
  return LOCAL_FONTS[family ?? "sans"];
}

/** Explicit newline layout, clipped by the item box. Coordinates are SVG baselines. */
export function getOwnedTextLayout(item: OwnedCanvasItem) {
  const fontSize = item.fontSize ?? 24, lineHeight = item.lineHeight ?? 1.2;
  const textAlign = item.textAlign ?? "left";
  const anchor: "start" | "middle" | "end" = textAlign === "center" ? "middle" : textAlign === "right" ? "end" : "start";
  const x = textAlign === "center" ? item.w / 2 : textAlign === "right" ? item.w : 0;
  const lineHeightPx = fontSize * lineHeight;
  return {
    fontFamily: getOwnedFontFamily(item.fontFamily), fontSize,
    fontWeight: item.fontWeight ?? "normal", fontStyle: item.fontStyle ?? "normal",
    textAlign, lineHeight, lineHeightPx, anchor, x,
    lines: (item.text ?? "").split(/\r?\n/).map((text, row) => ({ text, x, y: fontSize + row * lineHeightPx })),
  };
}

/** Crop refers to normalized ORIGINAL pixels; flipping happens after cropping. */
export function getOwnedImageLayout(item: OwnedCanvasItem) {
  const crop = item.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const sx = item.flipX ? -1 : 1, sy = item.flipY ? -1 : 1;
  const tx = item.flipX ? item.w : 0, ty = item.flipY ? item.h : 0;
  return {
    x: crop.x ? -crop.x * item.w / crop.w : 0, y: crop.y ? -crop.y * item.h / crop.h : 0,
    w: item.w / crop.w, h: item.h / crop.h,
    flipTransform: `translate(${tx} ${ty}) scale(${sx} ${sy})`,
    // Apply to a full-size inner wrapper with transformOrigin: "0 0".
    cssTransform: `translate(${tx}px, ${ty}px) scale(${sx}, ${sy})`,
  };
}

export function getOwnedLinePoints(item: OwnedCanvasItem): [{ x: number; y: number }, { x: number; y: number }] {
  return item.points?.length === 2 ? [item.points[0]!, item.points[1]!] : [{ x: 0, y: 0 }, { x: item.w, y: item.h }];
}

/** Keep preview/export arrowheads identical, with their tip on the local endpoint. */
export function getOwnedArrowMarker() {
  return {
    path: "M0 0 L6 3 L0 6 Z", viewBox: "0 0 6 6",
    markerWidth: 6, markerHeight: 6, refX: 6, refY: 3,
    orient: "auto" as const, markerUnits: "strokeWidth" as const,
  };
}

/** Arrowhead vertices are included in export allocation, not clipped by line bounds. */
export function getOwnedArrowBoundsPoints(item: OwnedCanvasItem): { x: number; y: number }[] {
  const [start, end] = getOwnedLinePoints(item), length = Math.hypot(end.x - start.x, end.y - start.y);
  const ux = length ? (end.x - start.x) / length : 1, uy = length ? (end.y - start.y) / length : 0;
  const width = item.strokeWidth ?? 2;
  return [start, end,
    { x: end.x - 6 * width * ux - 3 * width * uy, y: end.y - 6 * width * uy + 3 * width * ux },
    { x: end.x - 6 * width * ux + 3 * width * uy, y: end.y - 6 * width * uy - 3 * width * ux }];
}
