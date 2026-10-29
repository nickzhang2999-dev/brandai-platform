import { describe, expect, it } from "vitest";
import { placeCopywriting, placeWritingDocument } from "@/components/owned-canvas/owned-copywriting-placement";
import { decodeOwnedCanvas, encodeOwnedCanvas } from "@/lib/owned-canvas-codec";
import { inspectEditorDocument } from "@/lib/editor-document-codec";
import { emptyOwnedDocument, validateOwnedCanvasItems, type OwnedCanvasDocument, type OwnedCanvasItem } from "@/lib/owned-canvas-model";
import { OwnedCanvasHistory } from "@/lib/owned-canvas-engine/history";
import { getOwnedTextLayout } from "@/lib/owned-canvas-style";

const textOf = (document: OwnedCanvasDocument) => document.items.map(item => item.text ?? "").join("");
const shape = (id: string, extra: Partial<OwnedCanvasItem> = {}): OwnedCanvasItem => ({
  id: "shape:" + id, kind: "shape", x: 10, y: 20, w: 200, h: 100, rotation: 0, opacity: 1, ...extra,
});

describe("writing document handoff to native canvas", () => {
  it.each([
    ["5001 characters", "文".repeat(5001)],
    ["60000 characters", "这是完整的中文长稿。".repeat(6000)],
    ["60000 characters with many newlines", "字\n".repeat(30000)],
    ["60000 characters with mostly blank CRLF lines", "起" + "\r\n".repeat(29999) + "终"],
    ["60000 characters of emoji", "👩🏽‍💻".repeat(8571) + "尾尾尾"],
    ["spaces and original paragraph boundaries", "  首段 👨‍👩‍👧‍👦\r\n\r\n第二段 e\u0301 🇨🇳。\n\n" + "Read these original words without losing punctuation. ".repeat(100)],
  ])("preserves %s through real gzip codec and server inspection", async (_label, text) => {
    const original = emptyOwnedDocument(), snapshot = structuredClone(original);
    const placed = placeWritingDocument(original, text, "wd_document-8");
    expect(placed.items.length).toBeGreaterThan(1);
    expect(placed.items.length).toBeLessThan(10000);
    expect(textOf(placed)).toBe(text);
    expect(() => validateOwnedCanvasItems(placed.items, placed.pageId)).not.toThrow();
    for (const item of placed.items) {
      expect(item.text!.length).toBeLessThanOrEqual(4000);
      expect(item.h).toBeLessThanOrEqual(960);
      expect(item.w).toBe(720);
      expect(item.id).toMatch(/^shape:[A-Za-z0-9_-]{1,128}$/);
      for (const row of getOwnedTextLayout(item).lines.filter(row => row.text)) expect(row.y).toBeLessThanOrEqual(item.h);
    }
    const canvas = await encodeOwnedCanvas(placed);
    expect(inspectEditorDocument(canvas).urls).toEqual([]);
    const restored = await decodeOwnedCanvas(canvas);
    expect(restored.warnings).toEqual([]);
    expect(textOf(restored)).toBe(text);
    expect(restored.items.map(item => ({ id: item.id, text: item.text, x: item.x, y: item.y, w: item.w, h: item.h })))
      .toEqual(placed.items.map(item => ({ id: item.id, text: item.text, x: item.x, y: item.y, w: item.w, h: item.h })));
    expect(placeWritingDocument(restored, text, "wd_document-8")).toBe(restored);
    expect(original).toEqual(snapshot);
  });

  it("never splits grapheme clusters, CRLF or leading/trailing whitespace", () => {
    const text = ("👨‍👩‍👧‍👦👩🏽‍💻🇨🇳e\u0301  \r\n\n" + "a".repeat(33)).repeat(100);
    const document = placeWritingDocument(emptyOwnedDocument(), text, "graphemes-1");
    const boundaries = new Set(Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), value => value.index));
    boundaries.add(text.length);
    let offset = 0;
    for (const item of document.items) { offset += item.text!.length; expect(boundaries.has(offset)).toBe(true); }
    expect(offset).toBe(text.length); expect(textOf(document)).toBe(text);
  });

  it("inserts the whole long document in one real history undo/redo step", () => {
    const original = { ...emptyOwnedDocument(), items: [shape("existing")] };
    const placed = placeWritingDocument(original, "正文".repeat(30000), "wd_history-2", "shape:existing");
    expect(placed.items[1]).toMatchObject({ x: 250, y: 20 });
    expect(placed.items.some(item => item.x === 1050)).toBe(true);
    const history = new OwnedCanvasHistory();
    expect(history.record(original, placed)).toBe(true);
    const undone = history.undo(placed)!;
    expect(undone.items).toEqual(original.items); expect(history.canUndo).toBe(false);
    expect(history.redo(undone)!.items).toEqual(placed.items);
    expect(original.items).toHaveLength(1);
  });

  it("has stable receipt/chunk ids, preserves user edits and avoids prefix collisions", () => {
    const text = "新稿".repeat(3000), initial = placeWritingDocument(emptyOwnedDocument(), text, "document-1");
    const first = initial.items[0]!;
    const edited = { ...initial, items: initial.items.map(item => item.id === first.id ? { ...item, text: "画布中的手改", x: 555 } : item) };
    expect(placeWritingDocument(edited, text, "document-1")).toBe(edited);
    const second = placeWritingDocument(edited, text, "document-1-0");
    expect(second.items).toHaveLength(initial.items.length * 2);
    expect(new Set(second.items.map(item => item.id)).size).toBe(second.items.length);
    const partial = { ...initial, items: initial.items.slice(1) };
    expect(() => placeWritingDocument(partial, text, "document-1")).toThrow("部分");
    expect(partial.items).toEqual(initial.items.slice(1));
  });

  it("retains the existing short-copy behavior and recognizes an already handed-off legacy receipt", () => {
    const original = emptyOwnedDocument();
    const legacy = placeCopywriting(original, "短稿", "document-2");
    expect(placeWritingDocument(legacy, "短稿", "document-2")).toBe(legacy);
    expect(() => placeCopywriting(original, "文".repeat(5001), "old-limit")).toThrow();
  });

  it("rejects complete handoff atomically when item or aggregate text capacity is exhausted", () => {
    const full = { ...emptyOwnedDocument(), items: Array.from({ length: 9999 }, (_, index) => shape("filled-" + index)) };
    const before = structuredClone(full);
    expect(() => placeWritingDocument(full, "文".repeat(5001), "capacity-1")).toThrow("数量");
    expect(full).toEqual(before);
    const textFull = { ...emptyOwnedDocument(), items: Array.from({ length: 10 }, (_, index) => shape("text-" + index, { kind: "text", text: "a".repeat(100000), fontSize: 20 })) };
    expect(() => placeWritingDocument(textFull, "新稿", "capacity-2")).toThrow("文字超过");
    expect(textFull.items).toHaveLength(10);
  });

  it("rejects invalid coordinates, camera, warnings, malformed ids and oversize input without truncation", () => {
    const original = emptyOwnedDocument();
    const edge = { ...original, items: [shape("edge", { x: 1e7 })] };
    expect(() => placeWritingDocument(edge, "长稿", "edge-1", "shape:edge")).toThrow("坐标");
    expect(() => placeWritingDocument({ ...original, camera: { ...original.camera, zoom: 0 } }, "长稿", "bad-view")).toThrow("视角");
    expect(() => placeWritingDocument({ ...edge, camera: { ...edge.camera, x: Infinity } }, "长稿", "bad-view", "shape:edge")).toThrow("视角");
    expect(() => placeWritingDocument({ ...original, warnings: ["old data"] }, "长稿", "warning")).toThrow();
    for (const receipt of ["a/b", "a b", "a".repeat(101), ""]) expect(() => placeWritingDocument(original, "长稿", receipt)).toThrow("标识");
    for (const text of ["文".repeat(60001), "\n\n", "\0正文"]) expect(() => placeWritingDocument(original, text, "invalid-1")).toThrow();
    expect(() => placeWritingDocument(original, "a" + "\u0301".repeat(5000), "cluster-1")).toThrow("没有被截断");
    expect(original.items).toEqual([]);
  });
});
