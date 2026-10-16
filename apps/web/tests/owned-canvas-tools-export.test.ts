import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyOwnedDocument, parseOwnedDocument, serializeOwnedDocument, type OwnedCanvasItem } from "../src/lib/owned-canvas-model";
import { exportOwnedSvg, getExportDocument, getOwnedBounds, selectOwnedExportScene } from "../src/lib/owned-canvas-export";
import { getOwnedImageLayout, getOwnedTextLayout } from "../src/lib/owned-canvas-style";

const item = (id: string, patch: Partial<OwnedCanvasItem> = {}): OwnedCanvasItem => ({
  id: `shape:${id}`, kind: "shape", shape: "rect", x: 0, y: 0, w: 100, h: 50, rotation: 0, opacity: 1,
  fill: "#ffffff", stroke: "#7c5cff", strokeWidth: 0, ...patch,
});
const scene = (items: OwnedCanvasItem[]) => ({ ...emptyOwnedDocument(), items });
const origin = "https://novart.test";
const imageFetcher = (png: Uint8Array) => vi.fn(async () => new Response(png, { headers: { "content-type": "image/png" } }));
const pixel = (pixels: Uint8Array, width: number, x: number, y: number) => [...pixels.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
const nearColor = (actual: number[], expected: number[]) => actual.forEach((channel, index) => expect(Math.abs(channel - expected[index]!)).toBeLessThanOrEqual(20));

// Node verifies export policy and actual SVG pixels via sharp. Browser acceptance
// separately verifies the platform decoder used before embedding and PNG output.
beforeEach(() => vi.stubGlobal("createImageBitmap", vi.fn(async (blob: Blob) => {
  const bytes = await blob.arrayBuffer(), view = new DataView(bytes);
  return { width: view.getUint32(16), height: view.getUint32(20), close: vi.fn() };
})));
afterEach(() => vi.unstubAllGlobals());

describe("owned tools self-contained export", () => {
  it("lets a single-image raster tool omit group siblings without changing normal group export", () => {
    const document = scene([item("image", { kind: "image", url: "/image.png", groupId: "group:one" }), item("text", { kind: "text", text: "sibling", groupId: "group:one" })]);
    expect(selectOwnedExportScene(document, { itemIds: ["shape:image"] }).document.items).toHaveLength(2);
    expect(selectOwnedExportScene(document, { itemIds: ["shape:image"], expandGroups: false }).document.items.map(value => value.id)).toEqual(["shape:image"]);
    expect(document.items).toHaveLength(2);
  });
  it("round-trips font, line, memberships and hidden state before exporting the same scene", async () => {
    const document = scene([
      item("frame", { kind: "frame", w: 300, h: 200 }),
      item("text", { kind: "text", text: '<script>"&中文</script>\n第二行', fontSize: 20,
        fontFamily: "serif", fontWeight: "bold", fontStyle: "italic", textAlign: "right", lineHeight: 1.5,
        groupId: "group:one", frameId: "shape:frame", locked: true }),
      item("arrow", { shape: "arrow", points: [{ x: 8, y: 42 }, { x: 91, y: 7 }], strokeWidth: 3,
        groupId: "group:one", frameId: "shape:frame" }),
      item("hidden", { hidden: true, x: 1_000_000 }),
    ]);
    const source = serializeOwnedDocument(document), before = structuredClone(source), restored = parseOwnedDocument(source);
    expect(restored.warnings).toEqual([]);
    expect(restored.items[1]).toMatchObject({ locked: true, frameId: "shape:frame", fontFamily: "serif", textAlign: "right", lineHeight: 1.5 });
    expect(restored.items[2]!.points).toEqual(document.items[2]!.points);
    expect(await exportOwnedSvg(restored)).toBe(await exportOwnedSvg(document));
    expect(source).toEqual(before);
  });

  it("shares exact text anchors, line spacing and safe local font attributes with preview", async () => {
    const text = item("text", { kind: "text", text: '第一行<&"\n第二行', w: 120, fontSize: 20,
      fontFamily: "mono", fontWeight: "bold", fontStyle: "italic", textAlign: "center", lineHeight: 1.6 });
    expect(getOwnedTextLayout(text)).toMatchObject({ fontFamily: "Courier New, Courier, monospace", anchor: "middle", lineHeightPx: 32,
      lines: [{ text: '第一行<&"', x: 60, y: 20 }, { text: "第二行", x: 60, y: 52 }] });
    const svg = await exportOwnedSvg(scene([text]));
    expect(svg).toContain('font-family="Courier New, Courier, monospace"');
    expect(svg).toContain('font-weight="bold" font-style="italic" text-anchor="middle"');
    expect(svg).toContain('<tspan x="60" y="20">第一行&lt;&amp;&quot;</tspan>');
    expect(svg).toContain('<tspan x="60" y="52">第二行</tspan>');
    expect(svg).not.toContain("@font-face"); expect(svg).not.toContain("<script");
    const right = await exportOwnedSvg(scene([{ ...text, textAlign: "right" }]));
    expect(right).toContain('text-anchor="end"'); expect(right).toContain('<tspan x="120"');
  });

  it("crops original pixels then flips both axes, preserving the result across save/reload", async () => {
    const png = await sharp(Buffer.from([
      255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0,
      255, 0, 255, 0, 255, 255, 255, 255, 255, 0, 0, 0,
    ]), { raw: { width: 4, height: 2, channels: 3 } }).png().toBuffer();
    const image = item("image", { kind: "image", w: 20, h: 20, url: "/api/workspaces/ws/assets/pixels/raw",
      assetId: "pixels", assetSha256: "a".repeat(64), crop: { x: .25, y: 0, w: .5, h: 1 }, flipX: true, flipY: true });
    expect(getOwnedImageLayout(image)).toMatchObject({ x: -10, y: 0, w: 40, h: 20, flipTransform: "translate(20 20) scale(-1 -1)" });
    const restored = parseOwnedDocument(serializeOwnedDocument(scene([image])));
    expect(restored.items[0]).toMatchObject({ crop: image.crop, flipX: true, flipY: true, assetSha256: "a".repeat(64) });
    const fetcher = imageFetcher(png), svg = await exportOwnedSvg(restored, { origin, fetcher });
    const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([20, 20]);
    // Upscaled raster pixels interpolate at half-pixel centers. Color direction
    // must remain correct even when the decoder blends a neighboring pixel.
    nearColor(pixel(data, 20, 4, 4), [255, 255, 255, 255]);
    nearColor(pixel(data, 20, 15, 4), [0, 255, 255, 255]);
    nearColor(pixel(data, 20, 4, 15), [0, 0, 255, 255]);
    nearColor(pixel(data, 20, 15, 15), [0, 255, 0, 255]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(svg).not.toContain('href="https:');
  });

  it("exports real local line endpoints and arrow markers, with enough room for arrowheads", async () => {
    const line = item("line", { shape: "line", w: 1_000_000, h: 1_000_000,
      points: [{ x: 10, y: 20 }, { x: 40, y: 20 }], strokeWidth: 2 });
    const arrow = item("arrow", { shape: "arrow", w: 100, h: 100,
      points: [{ x: 10, y: 20 }, { x: 40, y: 20 }], strokeWidth: 2 });
    expect(getOwnedBounds(scene([line]))).toEqual({ x: 9, y: 19, w: 32, h: 2 });
    expect(getOwnedBounds(scene([arrow]))).toEqual({ x: 9, y: 13, w: 32, h: 14 });
    const svg = await exportOwnedSvg(scene([line, arrow]));
    expect(svg).toContain('<line x1="10" y1="20" x2="40" y2="20"');
    expect(svg).toContain('marker-end="url(#owned-arrow-1)"');
    expect(svg).toContain('refX="6" refY="3" orient="auto" markerUnits="strokeWidth"');
  });

  it("excludes hidden content from allocation and fetches while keeping locked content", async () => {
    const fetcher = vi.fn(() => { throw new Error("hidden image must not be read"); });
    const document = scene([
      item("locked", { kind: "text", text: "锁定文字仍导出", locked: true, fontSize: 12 }),
      item("hidden", { kind: "image", url: "https://external.test/hidden.png", hidden: true, x: 1_000_000 }),
    ]);
    expect(getOwnedBounds(document)).toEqual({ x: 0, y: 0, w: 100, h: 50 });
    expect(await exportOwnedSvg(document, { origin, fetcher })).toContain("锁定文字仍导出");
    expect(fetcher).not.toHaveBeenCalled();
    await expect(exportOwnedSvg(document, { itemIds: ["shape:hidden"] })).rejects.toThrow("没有可导出");
  });

  it("expands selected groups and frames, preserves stacking and never mutates the original document", async () => {
    const document = scene([
      item("frame", { kind: "frame" }),
      item("a", { groupId: "group:one", frameId: "shape:frame" }),
      item("b", { groupId: "group:one", frameId: "shape:frame", x: 120 }),
      item("other", { x: 400 }),
    ]), before = structuredClone(document);
    expect(getExportDocument(document, { itemIds: ["shape:a"] }).items.map(value => value.id)).toEqual(["shape:a", "shape:b"]);
    expect(getExportDocument(document, { itemIds: ["shape:frame"] }).items.map(value => value.id)).toEqual(["shape:frame", "shape:a", "shape:b"]);
    const selected = selectOwnedExportScene(document, { itemIds: ["shape:b"] });
    selected.document.items[0]!.x = 99;
    expect(document).toEqual(before); expect(selected.document.source).toBe(document.source);
    await expect(exportOwnedSvg(document, { itemIds: ["shape:missing"] })).rejects.toThrow("不存在");
  });

  it("exports a rotated frame in its own pixel coordinates and clips children at its edge", async () => {
    const document = scene([
      item("frame", { kind: "frame", x: 100, y: 100, w: 40, h: 20, rotation: Math.PI / 2 }),
      item("child", { x: 100, y: 100, w: 80, h: 20, rotation: Math.PI / 2, frameId: "shape:frame", fill: "#ff0000" }),
      item("unrelated", { x: 80, y: 100, w: 40, h: 100, fill: "#0000ff" }),
    ]), before = structuredClone(document);
    expect(getOwnedBounds(document, { frameId: "shape:frame" })).toEqual({ x: 0, y: 0, w: 40, h: 20 });
    const svg = await exportOwnedSvg(document, { frameId: "shape:frame" });
    expect(svg).toContain('viewBox="0 0 40 20"');
    expect(svg).toContain('rotate(-90) translate(-100 -100)');
    expect(svg).toContain('clip-path="url(#owned-export-frame)"');
    const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([40, 20]);
    expect(pixel(data, 40, 2, 2)).toEqual([255, 0, 0, 255]);
    expect(pixel(data, 40, 38, 18)).toEqual([255, 0, 0, 255]);
    expect(document).toEqual(before);
  });

  it("validates the entire original scene before any selected/hidden filtering", async () => {
    const document = scene([item("valid"), item("invalid", { hidden: true, x: Number.NaN })]);
    await expect(exportOwnedSvg(document, { itemIds: ["shape:valid"] })).rejects.toThrow();
    const source = emptyOwnedDocument().source;
    const store = (source.tldrawSnapshot as { document: { store: Record<string, unknown> } }).document.store;
    store["shape:unsupported"] = { id: "shape:unsupported", typeName: "shape", type: "unknown" };
    const parsed = parseOwnedDocument(source); parsed.warnings = []; parsed.items = [item("valid")];
    await expect(exportOwnedSvg(parsed, { itemIds: ["shape:valid"] })).rejects.toThrow();
  });

  it("inherits frame visibility so hidden frame children never fetch or affect bounds", async () => {
    const document = scene([
      item("frame", { kind: "frame", hidden: true, x: 100_000, w: 9000 }),
      item("child", { kind: "image", frameId: "shape:frame", x: 100_000, url: "https://external.test/hidden.png" }),
      item("visible"),
    ]), fetcher = vi.fn(() => { throw new Error("hidden descendant must not be read"); });
    expect(getOwnedBounds(document)).toEqual({ x: 0, y: 0, w: 100, h: 50 });
    await exportOwnedSvg(document, { origin, fetcher }); expect(fetcher).not.toHaveBeenCalled();
    await expect(exportOwnedSvg(document, { frameId: "shape:frame" })).rejects.toThrow("可见画框");
  });
});
