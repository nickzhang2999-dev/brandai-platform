import type { OwnedCanvasDocument } from "@/lib/owned-canvas-model";
/** Native text objects use the existing history, autosave and export pipeline. */
export function placeCopywriting(document: OwnedCanvasDocument, text: string, receiptId: string, anchorId?: string): OwnedCanvasDocument {
  const id = "shape:copy-" + receiptId.replace(/[^a-zA-Z0-9_-]/g, "");
  if (document.items.some(item => item.id === id)) return document;
  if (document.warnings.length || !text.trim() || text.length > 5000) throw new Error("当前画布或文案无法插入，请检查后再试。");
  const anchor = document.items.find(item => item.id === anchorId && !item.hidden);
  const x = anchor ? anchor.x + anchor.w + 40 : (-document.camera.x + 80) / document.camera.zoom;
  const y = anchor ? anchor.y : (-document.camera.y + 80) / document.camera.zoom;
  // The native SVG renderer lays out explicit lines, so wrap before insertion.
  const lines = text.split("\n").flatMap(line => { const result: string[] = []; let current = "", width = 0;
    for (const char of line) { const size = /[\u0000-\u007f]/.test(char) ? 0.6 : 1; if (width + size > 18) { result.push(current); current = ""; width = 0; } current += char; width += size; }
    return [...result, current]; });
  return { ...document, items: [...document.items, { id, kind: "text", text: lines.join("\n"), x, y, w: 460, h: Math.max(90, lines.length * 34),
    rotation: 0, opacity: 1, fontSize: 24, fontFamily: "sans", fontWeight: "normal", fontStyle: "normal", textAlign: "left", lineHeight: 1.4 }] };
}
