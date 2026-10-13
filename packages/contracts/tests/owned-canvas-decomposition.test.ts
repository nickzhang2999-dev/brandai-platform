import { describe, expect, it } from "vitest";
import { emptyOwnedDocument, parseOwnedDocument, serializeOwnedDocument } from "../../../apps/web/src/lib/owned-canvas-model";
import { ownedLayerIds, placeOwnedLayers, requireOwnedLayerSource } from "../../../apps/web/src/lib/owned-canvas-decomposition";
import { createEdit, applyEdit } from "../../../apps/web/src/components/owned-canvas/geometry";

const source = { id: "shape:source", kind: "image" as const, x: 20, y: 30, w: 200, h: 100, rotation: 0.4, opacity: 1, parentId: "page:novart",
  assetId: "original", assetSha256: "a".repeat(64), url: "/api/workspaces/w/assets/original/raw", crop: { x: 0.1, y: 0.2, w: 0.6, h: 0.7 }, flipX: true };
const scene = () => ({ ...emptyOwnedDocument(), items: [{ ...source }] });
const result = { requestId: "decompose-test", sourceShapeId: source.id, assetId: source.assetId, assetSha256: source.assetSha256, status: "SUCCEEDED",
  layers: [0, 1].map(order => ({ order, assetId: "layer-" + order, assetSha256: String(order + 1).repeat(64), width: 200, height: 100, url: `/api/workspaces/w/assets/layer-${order}/raw` })) };

describe("owned canvas AI layer placement", () => {
  it("places ordered layers at the source transform and keeps its unchanged bytes", async () => {
    const before = scene(), placed = await placeOwnedLayers(before, { ...result, layers: [...result.layers].reverse() }, "w");
    expect(before.items).toEqual([source]);
    expect(placed.document.items[0]).toEqual({ ...source, hidden: true });
    expect(placed.document.items.slice(1).map(item => item.assetId)).toEqual(["layer-0", "layer-1"]);
    for (const item of placed.document.items.slice(1)) expect(item).toMatchObject({ x: 20, y: 30, w: 200, h: 100, rotation: 0.4, crop: source.crop, flipX: true });
    const reopened = parseOwnedDocument(serializeOwnedDocument(placed.document));
    expect(reopened.warnings).toEqual([]); expect(reopened.items).toEqual(placed.document.items);
    const edit = createEdit(before, placed.document)!;
    expect(applyEdit(placed.document, edit, "before").items).toEqual(before.items);
    expect(applyEdit(before, edit, "after").items).toEqual(placed.document.items);
  });
  it("a repeated result preserves the user's layer transforms without duplicate objects", async () => {
    const first = await placeOwnedLayers(scene(), result, "w"), modified = { ...first.document, items: first.document.items.map((item, index) => index ? { ...item, x: 555 } : item) };
    const repeat = await placeOwnedLayers(modified, result, "w");
    expect(repeat.replayed).toBe(true); expect(repeat.document).toBe(modified);
    expect((await ownedLayerIds(result.requestId, [0, 1])).itemIds).toEqual(first.itemIds);
  });
  it("fails closed on missing layers, foreign URLs, mismatched dimensions and edited source", async () => {
    for (const altered of [{ ...result, status: "RUNNING" }, { ...result, layers: [] },
      { ...result, layers: result.layers.map(layer => ({ ...layer, url: layer.url.replace("/w/", "/other/") })) },
      { ...result, layers: result.layers.map((layer, index) => ({ ...layer, width: 200 + index })) }, { ...result, assetSha256: "b".repeat(64) }]) {
      const before = scene(); await expect(placeOwnedLayers(before, altered, "w")).rejects.toThrow(); expect(before.items).toEqual([source]);
    }
  });
  it("rejects inherited locks and partial-opacity composition", () => {
    const hidden = { ...scene(), items: [{ ...source, frameId: "shape:frame" }, { id: "shape:frame", kind: "frame" as const, x: 0, y: 0, w: 400, h: 400, rotation: 0, opacity: 1, locked: true, parentId: "page:novart" }] };
    expect(() => requireOwnedLayerSource(hidden, result)).toThrow(/解锁/);
    expect(() => requireOwnedLayerSource({ ...scene(), items: [{ ...source, opacity: 0.5 }] }, result)).toThrow(/100%/);
  });
  it("does not silently repopulate a partly deleted layer group", async () => {
    const first = await placeOwnedLayers(scene(), result, "w");
    await expect(placeOwnedLayers({ ...first.document, items: first.document.items.slice(0, 2) }, result, "w")).rejects.toThrow(/部分/);
  });
});
