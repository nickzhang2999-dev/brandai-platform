import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyOwnedDocument, parseOwnedDocument, serializeOwnedDocument, type OwnedCanvasDocument, type OwnedCanvasItem } from "../../../apps/web/src/lib/owned-canvas-model";
import { decodeOwnedCanvas, encodeOwnedCanvas } from "../../../apps/web/src/lib/owned-canvas-codec";
import { exportOwnedSvg, getOwnedBounds } from "../../../apps/web/src/lib/owned-canvas-export";
import { inspectEditorDocument } from "../../../apps/web/src/lib/editor-document-codec";
import { workflowAssets } from "../../../apps/web/src/lib/studio-workflow-codec";

const item = (id: string, kind: OwnedCanvasItem["kind"] = "shape", extra: Partial<OwnedCanvasItem> = {}): OwnedCanvasItem => ({
  id: "shape:" + id, kind, x: 30, y: 40, w: 160, h: 90, rotation: 0, opacity: 1,
  ...(kind === "image" ? { url: "/api/workspaces/own/assets/a1/raw" } : {}),
  ...(kind === "text" ? { text: "中文\n第二行", fontSize: 24 } : {}),
  ...(kind === "stroke" ? { points: [{ x: 0, y: 0 }, { x: 30, y: 20 }] } : {}), ...extra,
});
function scene(items = [item("image", "image"), item("text", "text"), item("shape"), item("pen", "stroke")]): OwnedCanvasDocument {
  return { ...emptyOwnedDocument(), items };
}
const sourceStore = (source: Record<string, unknown>) => (source.tldrawSnapshot as { document: { store: Record<string, Record<string, unknown>> } }).document.store;
function legacySource() {
  const source = emptyOwnedDocument().source, store = sourceStore(source);
  source.futureExtension = { retained: [1, "未知内容"] };
  store["opaque:record"] = { id: "opaque:record", typeName: "opaque", future: { value: true } };
  store["shape:image"] = { id: "shape:image", typeName: "shape", type: "c-image", parentId: "page:novart",
    index: "a1", x: 30, y: 40, rotation: 0.5, opacity: 0.8, meta: { future: [7] },
    props: { w: 160, h: 90, url: "/api/workspaces/own/assets/a1/raw", futureData: { retained: true } } };
  return source;
}

describe("owned canvas lossless compatibility boundary", () => {
  it("keeps new empty documents and owned images compatible with backend document and workflow readers", async () => {
    const empty = await encodeOwnedCanvas(emptyOwnedDocument());
    expect(inspectEditorDocument(empty).urls).toEqual([]);
    expect(workflowAssets("project-test", empty, []).assets).toEqual([]);
    const encoded = await encodeOwnedCanvas(scene());
    const assets = workflowAssets("project-test", encoded, [{ url: "/api/workspaces/own/assets/a1/raw", sha256: "a".repeat(64), mimeType: "image/png" }]);
    expect(assets.issues).toEqual([]);
    expect(assets.assets).toHaveLength(1);
    expect(assets.assets[0]).toMatchObject({ shapeId: "shape:image", assetSha256: "a".repeat(64), width: 160, height: 90, valid: true });
  });
  it("round-trips a mixed scene through real gzip and the existing backend inspection", async () => {
    const document = scene();
    const encoded = await encodeOwnedCanvas(document);
    expect(inspectEditorDocument(encoded).urls).toEqual(["/api/workspaces/own/assets/a1/raw"]);
    const restored = await decodeOwnedCanvas(encoded);
    expect(restored.warnings).toEqual([]);
    expect(restored.items.map(value => value.kind)).toEqual(["image", "text", "shape", "stroke"]);
    expect(restored.items[1]!.text).toBe("中文\n第二行");
    expect(restored.items[3]!.points).toEqual(document.items[3]!.points);
    expect(restored.camera).toEqual(document.camera);
  });
  it("preserves unknown root, document, record, prop and metadata fields when editing an image", () => {
    const source = legacySource(), before = structuredClone(source), document = parseOwnedDocument(source);
    document.items[0]!.x = 222;
    const encoded = serializeOwnedDocument(document), shape = sourceStore(encoded)["shape:image"]!;
    expect(encoded.futureExtension).toEqual(source.futureExtension);
    expect(sourceStore(encoded)["opaque:record"]).toEqual(sourceStore(source)["opaque:record"]);
    expect((shape.props as Record<string, unknown>).futureData).toEqual({ retained: true });
    expect(shape.meta).toEqual({ future: [7] });
    expect(shape.x).toBe(222); expect(shape.rotation).toBe(0.5); expect(shape.opacity).toBe(0.8);
    expect(source).toEqual(before);
  });
  it("allows explicit removal of supported shapes without deleting unrelated records", () => {
    const document = parseOwnedDocument(legacySource()); document.items = [];
    const store = sourceStore(serializeOwnedDocument(document));
    expect(store["shape:image"]).toBeUndefined(); expect(store["opaque:record"]).toBeDefined();
  });
  it("retains unsupported compressed old pen records and refuses save even if warnings are cleared", () => {
    const source = legacySource();
    sourceStore(source)["shape:oldpen"] = { id: "shape:oldpen", typeName: "shape", type: "draw", props: { segments: [{ points: "compressed-native-data" }] } };
    const document = parseOwnedDocument(source);
    expect(document.warnings.length).toBeGreaterThan(0); expect(sourceStore(document.source)["shape:oldpen"]).toEqual(sourceStore(source)["shape:oldpen"]);
    document.warnings = [];
    expect(() => serializeOwnedDocument(document)).toThrow();
  });
  it("marks nested parents, clipping, rich formatting, bindings and malformed shape records read-only", () => {
    for (const mutate of [
      (store: ReturnType<typeof sourceStore>) => { store["shape:image"]!.parentId = "shape:frame"; },
      (store: ReturnType<typeof sourceStore>) => { (store["shape:image"]!.props as Record<string, unknown>).cropRegion = { x: 0, y: 0, w: 0.5, h: 1 }; },
      (store: ReturnType<typeof sourceStore>) => { store["shape:image"]!.type = "future-rich-text"; },
      (store: ReturnType<typeof sourceStore>) => { store["binding:x"] = { typeName: "binding" }; },
      (store: ReturnType<typeof sourceStore>) => { store["shape:bad"] = { typeName: "future-shape" }; },
    ]) {
      const source = legacySource(); mutate(sourceStore(source)); const document = parseOwnedDocument(source);
      expect(document.warnings.length).toBeGreaterThan(0); expect(() => serializeOwnedDocument(document)).toThrow();
    }
  });
  it("does not flatten rotated parents or silently drop another page", () => {
    const source = legacySource(), store = sourceStore(source);
    store["page:two"] = { id: "page:two", typeName: "page" }; store["shape:image"]!.parentId = "page:two";
    expect(parseOwnedDocument(source).warnings.length).toBeGreaterThan(0);
    expect(() => serializeOwnedDocument(scene([item("nested", "shape", { parentId: "shape:frame" })]))).toThrow();
  });
  it("writes explicit owned pen format and c-image metadata required by existing workflows", () => {
    const document = scene([item("image", "image", { assetId: "a1", assetSha256: "a".repeat(64), versionId: "v1" }), item("pen", "stroke")]);
    const store = sourceStore(serializeOwnedDocument(document));
    expect(store["shape:image"]!.type).toBe("c-image");
    expect(store["shape:image"]!.meta).toMatchObject({ novartAssetId: "a1", novartAssetSha256: "a".repeat(64), novartVersionId: "v1" });
    expect(store["shape:pen"]!.type).toBe("novart-stroke");
    expect(store["shape:pen"]!.props).toMatchObject({ novartKind: "stroke", novartVersion: 1, novartPoints: document.items[1]!.points });
  });
  it("rejects duplicate identities, unsafe colors, transient images and invalid geometry", () => {
    for (const document of [scene([item("dup"), item("dup")]), scene([item("bad", "shape", { fill: 'url(https://foreign.test)' })]),
      scene([item("bad", "image", { url: "data:image/png;base64,AA==" })]), scene([item("bad", "shape", { w: 0 })]),
      scene([item("bad", "shape", { x: Infinity })]), scene([item("bad", "stroke", { points: [] })])]) expect(() => serializeOwnedDocument(document)).toThrow();
  });
  it("rejects non-JSON and deeply recursive data before cloning", () => {
    expect(() => parseOwnedDocument({ value: Infinity })).toThrow();
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => parseOwnedDocument(cyclic)).toThrow();
  });
  it("rejects malformed gzip, noncanonical base64 and decompression bombs", async () => {
    const bomb = "SHAKKERDATA://" + gzipSync('"' + "a".repeat(33 * 1024 * 1024) + '"').toString("base64");
    for (const value of ["{}", "SHAKKERDATA://AAAA", "SHAKKERDATA://A===", bomb]) await expect(decodeOwnedCanvas(value)).rejects.toThrow();
    expect((await decodeOwnedCanvas("")).items).toEqual([]);
  });
  it("preserves item order, camera extras and frame data over multiple edits", async () => {
    const document = scene([item("z"), item("A", "frame"), item("b", "text")]);
    document.camera = { x: -300, y: 42, zoom: 0.8 };
    const restored = await decodeOwnedCanvas(await encodeOwnedCanvas(document));
    restored.items.reverse();
    const reopened = await decodeOwnedCanvas(await encodeOwnedCanvas(restored));
    expect(reopened.items.map(value => value.id)).toEqual(["shape:b", "shape:A", "shape:z"]);
    expect(reopened.camera).toEqual(document.camera);
  });
  it("converts real native page-state cameras to pixel offsets and patches back without dropping session extras", async () => {
    const source = legacySource(); delete source.novartOwnedCanvas;
    const snapshot = source.tldrawSnapshot as { session: Record<string, unknown> };
    snapshot.session = { version: 0, currentPageId: "page:novart", futureSession: { retained: true }, pageStates: [
      { pageId: "page:novart", camera: { x: -400, y: 120, z: 0.5, futureCamera: true }, selectedShapeIds: ["shape:image"], focusedGroupId: null },
      { pageId: "page:other", camera: { x: 12, y: 34, z: 2 }, unknownState: true },
    ] };
    const document = parseOwnedDocument(source);
    expect(document.warnings).toEqual([]);
    expect(document.camera).toEqual({ x: -200, y: 60, zoom: 0.5 });
    document.camera = { x: 80, y: -40, zoom: 2 };
    const serialized = serializeOwnedDocument(document);
    const session = (serialized.tldrawSnapshot as { session: Record<string, unknown> }).session;
    expect(session.futureSession).toEqual({ retained: true });
    expect(session.pageStates).toEqual([
      { pageId: "page:novart", camera: { x: 40, y: -20, z: 2, futureCamera: true }, selectedShapeIds: ["shape:image"], focusedGroupId: null },
      { pageId: "page:other", camera: { x: 12, y: 34, z: 2 }, unknownState: true },
    ]);
    expect((await decodeOwnedCanvas(await encodeOwnedCanvas(document))).camera).toEqual(document.camera);
  });
  it("protects malformed/duplicate cameras and unknown hidden/locked states", () => {
    const source = legacySource(), snapshot = source.tldrawSnapshot as { session: Record<string, unknown> };
    snapshot.session.pageStates = [{ pageId: "page:novart", camera: { x: 0, y: 0, z: 1 } }, { pageId: "page:novart", camera: { x: 1, y: 0, z: 1 } }];
    expect(parseOwnedDocument(source).warnings.length).toBeGreaterThan(0);
    for (const [key, value] of [["hidden", "unknown"], ["isLocked", true], ["visible", null]] as const) {
      const input = legacySource(); sourceStore(input)["shape:image"]![key] = value;
      expect(parseOwnedDocument(input).warnings.length).toBeGreaterThan(0);
    }
  });
  it("never promotes missing, ambiguous or corrupt old page/session records to a writable blank scene", () => {
    for (const mutate of [
      (source: Record<string, unknown>) => { delete sourceStore(source)["page:novart"]; },
      (source: Record<string, unknown>) => { sourceStore(source)["page:novart"]!.id = "page:other"; },
      (source: Record<string, unknown>) => { sourceStore(source)["page:novart"]!.typeName = "future-page"; },
      (source: Record<string, unknown>) => { (source.tldrawSnapshot as { session: Record<string, unknown> }).session.currentPageId = "page:missing"; },
      (source: Record<string, unknown>) => {
        delete (source.tldrawSnapshot as { session: Record<string, unknown> }).session.currentPageId;
        sourceStore(source)["page:other"] = { id: "page:other", typeName: "page" };
      },
      (source: Record<string, unknown>) => { (source.tldrawSnapshot as Record<string, unknown>).session = "invalid-session"; },
      (source: Record<string, unknown>) => { (source.tldrawSnapshot as { session: Record<string, unknown> }).session.camera = { z: 1 }; },
    ]) {
      const source = emptyOwnedDocument().source; mutate(source); const document = parseOwnedDocument(source);
      expect(document.items).toEqual([]); expect(document.warnings.length).toBeGreaterThan(0);
      document.warnings = []; expect(() => serializeOwnedDocument(document)).toThrow();
      expect(document.source).toEqual(source);
    }
  });
});

describe("owned canvas complete-scene export", () => {
  const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxV8AAAAASUVORK5CYII=", "base64"));
  // Node exercises the export policy; browser acceptance separately exercises
  // the actual platform raster decoder and PNG canvas rendering.
  beforeEach(() => vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() }))));
  afterEach(() => vi.unstubAllGlobals());
  it("embeds same-origin images, text, shape and stroke without external references", async () => {
    const fetcher = vi.fn(async () => new Response(png, { headers: { "content-type": "image/png" } }));
    const svg = await exportOwnedSvg(scene(), { origin: "https://novart.test", fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]).toEqual(expect.arrayContaining(["https://novart.test/api/workspaces/own/assets/a1/raw"]));
    expect(svg).toContain('href="data:image/png;base64,'); expect(svg).toContain("中文"); expect(svg).toContain("<rect"); expect(svg).toContain("<polyline");
    expect(svg).not.toContain('href="https:');
  });
  it("escapes text instead of allowing markup/script injection", async () => {
    const svg = await exportOwnedSvg(scene([item("t", "text", { text: '<script>alert("x")</script>&' })]));
    expect(svg).toContain("&lt;script&gt;"); expect(svg).not.toContain("<script>");
  });
  it("deduplicates image fetches and denies cross-origin and redirected assets", async () => {
    const fetcher = vi.fn(async () => new Response(png, { headers: { "content-type": "image/png" } }));
    await exportOwnedSvg(scene([item("a", "image"), item("b", "image")]), { origin: "https://novart.test", fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(exportOwnedSvg(scene([item("x", "image", { url: "https://other.test/p.png" })]), { origin: "https://novart.test", fetcher })).rejects.toThrow();
    const redirect = new Response(png, { headers: { "content-type": "image/png" } }); Object.defineProperty(redirect, "redirected", { value: true });
    await expect(exportOwnedSvg(scene(), { origin: "https://novart.test", fetcher: async () => redirect })).rejects.toThrow();
  });
  it("bounds total embedded bytes even when many shapes reuse one legal image", async () => {
    const padded = new Uint8Array(8 * 1024 * 1024); padded.set(png);
    const fetcher = vi.fn(async () => new Response(padded, { headers: { "content-type": "image/png" } }));
    const repeated = scene([item("a", "image"), item("b", "image"), item("c", "image")]);
    await expect(exportOwnedSvg(repeated, { origin: "https://novart.test", fetcher })).rejects.toThrow("32 MiB");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const distinct = scene(Array.from({ length: 5 }, (_, n) => item(`image${n}`, "image", { url: `/api/workspaces/own/assets/a${n}/raw` })));
    fetcher.mockClear();
    await expect(exportOwnedSvg(distinct, { origin: "https://novart.test", fetcher })).rejects.toThrow("32 MiB");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("fails the entire export for missing, SVG or malformed raster images", async () => {
    for (const response of [new Response("missing", { status: 404 }), new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }),
      new Response("<script/>", { headers: { "content-type": "image/png" } })]) {
      await expect(exportOwnedSvg(scene(), { origin: "https://novart.test", fetcher: async () => response })).rejects.toThrow();
    }
  });
  it("rejects raster decode failures and excessive source dimensions before allocating a bitmap", async () => {
    const decoder = vi.fn(async () => { throw new Error("Corrupt compressed pixels"); });
    vi.stubGlobal("createImageBitmap", decoder);
    const options = { origin: "https://novart.test", fetcher: async () => new Response(png, { headers: { "content-type": "image/png" } }) };
    await expect(exportOwnedSvg(scene(), options)).rejects.toThrow("Corrupt");
    decoder.mockClear(); const huge = png.slice(); new DataView(huge.buffer).setUint32(16, 100_000);
    await expect(exportOwnedSvg(scene(), { ...options, fetcher: async () => new Response(huge, { headers: { "content-type": "image/png" } }) })).rejects.toThrow("源图片尺寸");
    expect(decoder).not.toHaveBeenCalled();
  });
  it("uses top-left rotation geometry and bounds pixel allocation", async () => {
    const doc = scene([item("r", "shape", { x: 10, y: 20, w: 100, h: 50, rotation: Math.PI / 2, strokeWidth: 0 })]);
    const bounds = getOwnedBounds(doc); expect(bounds.x).toBe(-40); expect(bounds.y).toBe(20);
    expect(bounds.w).toBeLessThanOrEqual(51); expect(bounds.h).toBe(100);
    expect(await exportOwnedSvg(doc)).toContain("rotate(90)");
    await expect(exportOwnedSvg(scene([item("huge", "shape", { w: 9000 })]))).rejects.toThrow("导出范围");
  });
  it("refuses partial exports when the source includes unsupported records", async () => {
    const source = legacySource(); sourceStore(source)["shape:unsupported"] = { typeName: "shape", type: "draw" };
    const document = parseOwnedDocument(source); document.warnings = [];
    await expect(exportOwnedSvg(document)).rejects.toThrow();
  });
});
