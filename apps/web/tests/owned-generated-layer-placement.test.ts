import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { emptyOwnedDocument, parseOwnedDocument, serializeOwnedDocument } from "../src/lib/owned-canvas-model";
import { generatedOwnedSourceShapeId, placeGeneratedOwnedLayers } from "../src/components/owned-canvas/owned-generated-layer-placement";
import { createEdit, applyEdit } from "../src/components/owned-canvas/geometry";

const source = { assetId: "auto-original", assetSha256: "a".repeat(64), width: 12, height: 8, url: "/api/workspaces/w/assets/auto-original/raw" };
const sourceShapeId = "shape:generated-" + createHash("sha256").update(source.assetId).digest("hex").slice(0, 40);
const task = { requestId: "auto-decomposition", sourceShapeId, ...source, status: "SUCCEEDED", sourceWidth: 12, sourceHeight: 8,
  layers: [0, 1].map(order => ({ order, assetId: "auto-layer-" + order, assetSha256: String(order + 1).repeat(64), width: 12, height: 8, url: `/api/workspaces/w/assets/auto-layer-${order}/raw` })) };
describe("automatic PSD layer placement", () => {
  it("matches worker SHA source identity without importing Node crypto into browser", async () => {
    expect(await generatedOwnedSourceShapeId(source.assetId)).toBe(sourceShapeId);
  });
  it("stages original and all layers as one undoable saved mutation", async () => {
    const before = emptyOwnedDocument(), placed = await placeGeneratedOwnedLayers(before, task as never, "w", source);
    expect(before.items).toEqual([]); expect(placed.document.items).toHaveLength(3); expect(placed.document.items[0]).toMatchObject({ id: sourceShapeId, assetId: source.assetId, hidden: true });
    expect(placed.document.items.slice(1).map(item => item.assetId)).toEqual(["auto-layer-0", "auto-layer-1"]);
    const edit = createEdit(before, placed.document)!; expect(applyEdit(placed.document, edit, "before").items).toEqual([]);
    expect(parseOwnedDocument(serializeOwnedDocument(placed.document)).items).toEqual(placed.document.items);
  });
  it("reuses an already placed and transformed original instead of adding another", async () => {
    const original = { id: "shape:already-placed", kind: "image" as const, x: 30, y: 70, w: 120, h: 80, rotation: 0.4, opacity: 1, parentId: "page:novart", ...source };
    const before = { ...emptyOwnedDocument(), items: [original] }, placed = await placeGeneratedOwnedLayers(before, task as never, "w", source, [original.id]);
    expect(placed.document.items).toHaveLength(3); expect(placed.document.items[0]).toEqual({ ...original, hidden: true });
    for (const layer of placed.document.items.slice(1)) expect(layer).toMatchObject({ x: 30, y: 70, w: 120, h: 80, rotation: 0.4 });
  });
  it("replay preserves modified layer positions, and a partly deleted group is never silently filled", async () => {
    const first = await placeGeneratedOwnedLayers(emptyOwnedDocument(), task as never, "w", source);
    const modified = { ...first.document, items: first.document.items.map((item, index) => index ? { ...item, x: 900 } : item) };
    const replay = await placeGeneratedOwnedLayers(modified, task as never, "w", source); expect(replay.replayed).toBe(true); expect(replay.document).toBe(modified);
    await expect(placeGeneratedOwnedLayers({ ...modified, items: modified.items.slice(0, 2) }, task as never, "w", source)).rejects.toThrow(/部分/);
  });
  it.each([undefined, { ...source, assetSha256: "b".repeat(64) }, { ...source, width: 11 }, { ...source, url: "/api/workspaces/foreign/assets/auto-original/raw" }])("does not insert a missing source from unverified generated metadata", async changed => {
    const before = emptyOwnedDocument(); await expect(placeGeneratedOwnedLayers(before, task as never, "w", changed)).rejects.toThrow(); expect(before.items).toEqual([]);
  });
  it("does not permit missing-source bypass for manual task identities", async () => {
    await expect(placeGeneratedOwnedLayers(emptyOwnedDocument(), { ...task, sourceShapeId: "shape:manual" } as never, "w", source)).rejects.toThrow(/原图片/);
  });
  it("preserves locked, hidden or transparent original rather than duplicating it", async () => {
    const original = { id: sourceShapeId, kind: "image" as const, x: 0, y: 0, w: 12, h: 8, rotation: 0, opacity: 1, parentId: "page:novart", ...source };
    for (const change of [{ locked: true }, { hidden: true }, { opacity: 0.5 }]) {
      const before = { ...emptyOwnedDocument(), items: [{ ...original, ...change }] };
      await expect(placeGeneratedOwnedLayers(before, task as never, "w", source)).rejects.toThrow(/避免重复/); expect(before.items).toHaveLength(1);
    }
  });
});
