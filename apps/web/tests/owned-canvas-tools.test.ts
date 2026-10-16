import { describe, expect, it } from "vitest";
import { decodeOwnedCanvas, encodeOwnedCanvas } from "../src/lib/owned-canvas-codec";
import { emptyOwnedDocument, parseOwnedDocument, serializeOwnedDocument, type OwnedCanvasItem } from "../src/lib/owned-canvas-model";
import { alignItems, attachItemsToFrame, deleteItems, distributeItems, duplicateItems, expandSelection, getMoveSnap, getSceneFlags, groupItems,
  isItemHidden, isItemLocked, moveItems, reorderItems, ungroupItems } from "../src/lib/owned-canvas-operations";

const item = (id: string, patch: Partial<OwnedCanvasItem> = {}): OwnedCanvasItem => ({
  id: `shape:${id}`, kind: "shape", x: 0, y: 0, w: 100, h: 50, rotation: 0, opacity: 1, ...patch,
});
const scene = (items: OwnedCanvasItem[]) => ({ ...emptyOwnedDocument(), items });
const store = (source: Record<string, unknown>) => (source.tldrawSnapshot as { document: { store: Record<string, { props: Record<string, unknown>; meta: Record<string, unknown> }> } }).document.store;

describe("owned editing persistence and compatibility", () => {
  it("round-trips owned styles, crop, flip, visibility, groups, frame membership and line endpoints through gzip", async () => {
    const items = [item("frame", { kind: "frame" }), item("text", { kind: "text", text: "中文\n第二行", fontSize: 30,
      fontFamily: "serif", fontWeight: "bold", fontStyle: "italic", textAlign: "right", lineHeight: 1.8,
      groupId: "group:title", frameId: "shape:frame", hidden: false, locked: true }),
    item("image", { kind: "image", url: "/api/workspaces/own/assets/a1/raw", assetId: "a1", assetSha256: "a".repeat(64), versionId: "v1",
      crop: { x: 0.1, y: 0.2, w: 0.6, h: 0.7 }, flipX: true, flipY: false, groupId: "group:title", frameId: "shape:frame", hidden: true }),
    item("arrow", { shape: "arrow", points: [{ x: 10, y: 40 }, { x: 95, y: 3 }] })];
    const document = scene(items), source = serializeOwnedDocument(document), image = store(source)["shape:image"]!;
    expect(source.novartOwnedCanvas).toEqual({ version: 2 });
    expect(image.props).toMatchObject({ novartVersion: 2, cropRegion: items[2]!.crop, flipX: true, flipY: false });
    expect(image.meta.novartOwned).toEqual({ version: 2, hidden: true, groupId: "group:title", frameId: "shape:frame" });
    const restored = await decodeOwnedCanvas(await encodeOwnedCanvas(document));
    expect(restored.warnings).toEqual([]);
    for (const original of items) expect(restored.items.find(value => value.id === original.id)).toMatchObject(original);
    expect((await decodeOwnedCanvas(await encodeOwnedCanvas(restored))).items).toEqual(restored.items);
  });

  it("preserves v1 basics and unrelated retained metadata while clearing an owned advanced setting", () => {
    const basic = serializeOwnedDocument(scene([item("basic")]));
    expect(store(basic)["shape:basic"]!.props.novartVersion).toBe(1);
    const document = scene([item("image", { kind: "image", url: "/a.png", crop: { x: 0.2, y: 0, w: 0.5, h: 1 }, flipX: true })]);
    const source = serializeOwnedDocument(document); store(source)["shape:image"]!.meta.future = { kept: true };
    const restored = parseOwnedDocument(source); delete restored.items[0]!.crop; delete restored.items[0]!.flipX;
    const cleared = serializeOwnedDocument(restored);
    expect(store(cleared)["shape:image"]!.props.cropRegion).toBeUndefined();
    expect(store(cleared)["shape:image"]!.props.flipX).toBeUndefined();
    expect(store(cleared)["shape:image"]!.meta.future).toEqual({ kept: true });
    expect(parseOwnedDocument(cleared).warnings).toEqual([]);
  });

  it("rejects native/unknown crop, flip, containers and future owned versions instead of guessing", () => {
    for (const edit of [
      (shape: ReturnType<typeof store>[string]) => { shape.props.cropRegion = { x: 0.2, y: 0, w: 0.5, h: 1 }; },
      (shape: ReturnType<typeof store>[string]) => { shape.props.flipX = true; },
      (shape: ReturnType<typeof store>[string]) => { shape.props.novartVersion = 3; },
      (shape: ReturnType<typeof store>[string]) => { shape.props.frameId = "shape:legacy-container"; },
      (shape: ReturnType<typeof store>[string]) => { shape.meta.novartOwned = { version: 2, hidden: true }; },
      (shape: ReturnType<typeof store>[string]) => { Object.assign(shape, { parentId: "shape:container" }); },
    ]) {
      const source = serializeOwnedDocument(scene([item("image", { kind: "image", url: "/a.png" })])); edit(store(source)["shape:image"]!);
      const document = parseOwnedDocument(source); expect(document.warnings.length).toBeGreaterThan(0);
      document.warnings = []; expect(() => serializeOwnedDocument(document)).toThrow();
      expect(document.source).toEqual(source);
    }
  });

  it("bounds styles, normalized crop, group references, frame references and cycles at save", () => {
    const invalid = [
      [item("i", { kind: "image", url: "/a.png", crop: { x: 0.8, y: 0, w: 0.3, h: 1 } })],
      [item("i", { kind: "image", url: "/a.png", crop: { x: -0.1, y: 0, w: 1, h: 1 } })],
      [item("t", { kind: "text", text: "test", lineHeight: 10 })],
      [item("t", { kind: "text", text: "test", fontFamily: "script" as "sans" })],
      [item("a", { shape: "line", points: [{ x: 0, y: 0 }] })],
      [item("a", { groupId: "group:missing" })],
      [item("a", { frameId: "shape:missing" })],
      [item("a", { kind: "frame", frameId: "shape:b" }), item("b", { kind: "frame", frameId: "shape:a" })],
      [item("a", { hidden: "true" as unknown as boolean })],
    ];
    for (const items of invalid) expect(() => serializeOwnedDocument(scene(items))).toThrow();
  });

  it("keeps corrupted owned graph metadata read-only even if a caller clears warnings", () => {
    const source = serializeOwnedDocument(scene([item("a", { kind: "frame" }), item("b", { frameId: "shape:a" })]));
    (store(source)["shape:b"]!.meta.novartOwned as Record<string, unknown>).frameId = "shape:missing";
    const document = parseOwnedDocument(source); expect(document.warnings.length).toBeGreaterThan(0);
    document.warnings = []; expect(() => serializeOwnedDocument(document)).toThrow();
  });

  it("removes owned line endpoints when changing a line into another shape", async () => {
    const source = serializeOwnedDocument(scene([item("line", { shape: "line", points: [{ x: 0, y: 0 }, { x: 100, y: 50 }] })]));
    const document = parseOwnedDocument(source); document.items[0]!.shape = "rect"; delete document.items[0]!.points;
    const restored = await decodeOwnedCanvas(await encodeOwnedCanvas(document));
    expect(restored.warnings).toEqual([]); expect(restored.items[0]!.shape).toBe("rect"); expect(restored.items[0]!.points).toBeUndefined();
  });
});

describe("pure owned scene operations", () => {
  it("copies whole frame/group units, remaps internal relationships and reuses image identity", async () => {
    const original = [item("f", { kind: "frame", x: 20 }),
      item("a", { kind: "image", url: "/asset.png", assetId: "asset1", assetSha256: "b".repeat(64), versionId: "version1", frameId: "shape:f", groupId: "group:pair", hidden: true }),
      item("b", { frameId: "shape:f", groupId: "group:pair", points: undefined })];
    const before = structuredClone(original), copied = duplicateItems(original, ["shape:f"]);
    expect(original).toEqual(before); expect(copied.selectedIds).toHaveLength(3);
    const frame = copied.items[3]!, image = copied.items[4]!, shape = copied.items[5]!;
    expect(frame.id).not.toBe(original[0]!.id); expect(image.frameId).toBe(frame.id); expect(shape.frameId).toBe(frame.id);
    expect(image.groupId).toBe(shape.groupId); expect(image.groupId).not.toBe("group:pair");
    expect(image).toMatchObject({ url: "/asset.png", assetId: "asset1", assetSha256: "b".repeat(64), versionId: "version1", hidden: true, x: 24 });
    const twice = duplicateItems(copied.items, ["shape:f"]); expect(new Set(twice.items.map(value => value.id)).size).toBe(twice.items.length);
    expect((await decodeOwnedCanvas(await encodeOwnedCanvas(scene(copied.items)))).warnings).toEqual([]);
  });

  it("groups and ungroups siblings, expands all group members and moves hidden descendants with the frame", () => {
    const original = [item("f", { kind: "frame" }), item("a", { frameId: "shape:f", hidden: true }), item("b", { frameId: "shape:f" }), item("outside")];
    const grouped = groupItems(original, ["shape:a", "shape:b"]);
    expect(expandSelection(grouped.items, ["shape:b"])).toEqual(["shape:a", "shape:b"]);
    expect(expandSelection(grouped.items, ["shape:f"])).toEqual(["shape:f", "shape:a", "shape:b"]);
    const moved = moveItems(grouped.items, ["shape:f"], { x: 25, y: -10 });
    expect(moved.slice(0, 3).map(value => value.x)).toEqual([25, 25, 25]); expect(moved[3]!.x).toBe(0);
    expect(ungroupItems(grouped.items, ["shape:b"]).every(value => !value.groupId)).toBe(true);
  });

  it("blocks a whole transform/delete when a locked child or locked ancestor participates", () => {
    const items = [item("f", { kind: "frame" }), item("a", { frameId: "shape:f", locked: true }), item("b")];
    expect(moveItems(items, ["shape:f"], { x: 100, y: 0 })).toBe(items);
    expect(deleteItems(items, ["shape:f"])).toBe(items);
    const lockedFrame = [item("f", { kind: "frame", locked: true, hidden: true }), item("a", { frameId: "shape:f" })];
    expect(isItemLocked(lockedFrame, "shape:a")).toBe(true); expect(isItemHidden(lockedFrame, "shape:a")).toBe(true);
    expect(moveItems(lockedFrame, ["shape:a"], { x: 10, y: 0 })).toBe(lockedFrame);
  });

  it("attaches and detaches without changing world geometry and rejects a frame cycle", () => {
    const items = [item("f", { kind: "frame", x: 500, rotation: 0.5 }), item("a", { x: 80, y: 30 })];
    const attached = attachItemsToFrame(items, ["shape:a"], "shape:f");
    expect(attached[1]).toMatchObject({ x: 80, y: 30, frameId: "shape:f" });
    expect(attachItemsToFrame(attached, ["shape:a"], null)[1]).toEqual(items[1]);
    expect(() => attachItemsToFrame(attached, ["shape:f"], "shape:f")).toThrow();
    const nested = [item("a", { kind: "frame" }), item("b", { kind: "frame", frameId: "shape:a" })];
    expect(() => attachItemsToFrame(nested, ["shape:a"], "shape:b")).toThrow();
  });

  it("aligns rotated visual bounds while keeping grouped offsets and frame child offsets", () => {
    const items = [item("a", { x: 100, rotation: Math.PI / 2 }), item("b", { x: 300, y: 80 })];
    const aligned = alignItems(items, ["shape:a", "shape:b"], "left");
    expect(aligned[0]!.x).toBeCloseTo(100); expect(aligned[1]!.x).toBeCloseTo(50);
    const frames = [item("f", { kind: "frame", x: 200 }), item("child", { frameId: "shape:f", x: 230 }), item("other", { x: 0 })];
    const alignedFrames = alignItems(frames, ["shape:f", "shape:other"], "left");
    expect(alignedFrames[0]!.x).toBe(0); expect(alignedFrames[1]!.x).toBe(30);
    const grouped = groupItems([item("a", { x: 100 }), item("b", { x: 220 }), item("c", { x: 500 })], ["shape:a", "shape:b"]).items;
    const alignedGroup = alignItems(grouped, ["shape:a", "shape:c"], "right");
    expect(alignedGroup[1]!.x - alignedGroup[0]!.x).toBe(120); expect(alignedGroup[1]!.x + 100).toBe(600);
  });

  it("distributes equal gaps with differently sized objects and keeps outer objects fixed", () => {
    const items = [item("a", { x: 0, w: 20 }), item("b", { x: 60, w: 50 }), item("c", { x: 300, w: 30 })];
    const distributed = distributeItems(items, items.map(value => value.id), "horizontal");
    expect(distributed[0]).toBe(items[0]); expect(distributed[2]).toBe(items[2]);
    expect(distributed[1]!.x - 20).toBeCloseTo(300 - distributed[1]!.x - 50);
  });

  it("reorders whole grouped units, deletes frame descendants and leaves unrelated layers untouched", () => {
    const items = [item("a", { groupId: "group:pair" }), item("x"), item("b", { groupId: "group:pair" }), item("y")];
    expect(reorderItems(items, ["shape:a"], "front").map(value => value.id)).toEqual(["shape:x", "shape:y", "shape:a", "shape:b"]);
    expect(reorderItems(items, ["shape:a"], "forward").map(value => value.id)).toEqual(["shape:x", "shape:a", "shape:y", "shape:b"]);
    expect(deleteItems(items, ["shape:b"]).map(value => value.id)).toEqual(["shape:x", "shape:y"]);
    const frames = [item("f", { kind: "frame" }), item("a", { frameId: "shape:f" }), item("z")];
    expect(deleteItems(frames, ["shape:f"])).toEqual([frames[2]]);
  });

  it("snaps to visible shape edges and falls back to grid without mutating input", () => {
    const items = [item("a", { w: 10, h: 10 }), item("b", { x: 100, y: 300, w: 20 }), item("hidden", { x: 99, hidden: true })];
    const before = structuredClone(items), snap = getMoveSnap(items, ["shape:a"], { x: 88, y: 63 }, { grid: 10, threshold: 3 });
    expect(snap.delta).toEqual({ x: 90, y: 60 }); expect(snap.guides).toContainEqual({ axis: "x", value: 100 });
    expect(items).toEqual(before);
  });

  it("memoizes deep frame flags without recursion and fails closed for malformed graph cycles", () => {
    const items = Array.from({ length: 10_000 }, (_, index) => item(String(index), { kind: "frame", ...(index > 0 ? { frameId: `shape:${index - 1}` } : { hidden: true, locked: true }) })).reverse();
    const flags = getSceneFlags(items);
    expect(flags.size).toBe(10_000); expect(flags.get("shape:9999")).toEqual({ hidden: true, locked: true });
    const cycle = [item("a", { kind: "frame", frameId: "shape:b" }), item("b", { kind: "frame", frameId: "shape:a" })];
    expect(getSceneFlags(cycle).get("shape:a")).toEqual({ hidden: true, locked: true });
    const grouped = Array.from({ length: 10_000 }, (_, index) => item(String(index), { groupId: "group:large" }));
    expect(expandSelection(grouped, ["shape:0"])).toHaveLength(10_000);
  });
});


describe("bounded cropped-image display geometry", () => {
  it("rejects subnormal crop ratios before SVG or DOM geometry becomes infinite", () => {
    const document = scene([item("tiny-crop", { kind: "image", url: "/a.png", crop: { x: 0, y: 0, w: 1e-320, h: 1 } })]);
    expect(() => serializeOwnedDocument(document)).toThrow(/范围过小/);
  });
  it("retains the minimum crop reachable through the UI on the largest supported item", () => {
    const document = scene([item("legal-crop", { kind: "image", url: "/a.png", w: 1e7, h: 1e7, crop: { x: 0, y: 0, w: .01, h: .01 } })]);
    expect(() => serializeOwnedDocument(document)).not.toThrow();
  });
});
