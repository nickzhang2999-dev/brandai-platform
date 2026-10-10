import { describe, expect, it } from "vitest";
import type { OwnedCanvasDocument, OwnedCanvasItem } from "../../../apps/web/src/lib/owned-canvas-model";
import { applyEdit, bounds, corners, createEdit, resize, resizeMany } from "../../../apps/web/src/components/owned-canvas/geometry";

const item = (id: string, patch: Partial<OwnedCanvasItem> = {}): OwnedCanvasItem => ({ id, kind: "shape", x: 10, y: 20, w: 100, h: 60, rotation: 0, opacity: 1, ...patch });
const doc = (items: OwnedCanvasItem[]): OwnedCanvasDocument => ({ items, camera: { x: 0, y: 0, zoom: 1 }, pageId: "page:test", source: { retained: { unknown: "preserved" } }, warnings: [] });
const near = (actual: { x: number; y: number }, expected: { x: number; y: number }) => { expect(actual.x).toBeCloseTo(expected.x); expect(actual.y).toBeCloseTo(expected.y); };

describe("owned canvas rotation and controlled edit history", () => {
  it("uses the original document's top-left rotation origin", () => {
    const rotated = item("shape:a", { rotation: Math.PI / 2 });
    near(corners(rotated)[0]!, { x: 10, y: 20 });
    near(corners(rotated)[2]!, { x: -50, y: 120 });
    const box = bounds([rotated])!;
    expect(box.x).toBeCloseTo(-50); expect(box.y).toBeCloseTo(20);
    expect(box.w).toBeCloseTo(60); expect(box.h).toBeCloseTo(100);
  });

  it.each([["nw", 0, 2], ["ne", 1, 3], ["se", 2, 0], ["sw", 3, 1]] as const)("keeps the opposite corner fixed while resizing rotated %s", (corner, moving, fixed) => {
    const original = item("shape:a", { rotation: 0.7 }), positions = corners(original), start = positions[moving]!;
    const changed = resize(original, corner, { x: start.x + 20, y: start.y + 35 }, false);
    near(corners(changed)[fixed]!, positions[fixed]!);
    expect(changed.w).toBeGreaterThan(0); expect(changed.h).toBeGreaterThan(0);
  });

  it("locks image aspect and rescales actual pen points with their box", () => {
    const original = item("shape:a", { kind: "stroke", points: [{ x: 0, y: 0 }, { x: 100, y: 60 }] });
    const changed = resize(original, "se", { x: 210, y: 100 }, true);
    expect(changed.w / changed.h).toBeCloseTo(original.w / original.h);
    expect(changed.points![1]!.x).toBeCloseTo(changed.w); expect(changed.points![1]!.y).toBeCloseTo(changed.h);
  });

  it("scales a rotated multi-selection uniformly without introducing skew", () => {
    const originals = [item("shape:a", { rotation: 0.4 }), item("shape:b", { x: 230 })], box = bounds(originals)!;
    const changed = resizeMany(originals, box, "se", { x: box.x + box.w * 2, y: box.y + box.h * 2 });
    expect(changed[0]!.rotation).toBe(originals[0]!.rotation);
    expect(changed[0]!.w / changed[0]!.h).toBeCloseTo(originals[0]!.w / originals[0]!.h);
    expect(changed[0]!.w).toBeCloseTo(originals[0]!.w * 2);
  });

  it("undoes and redoes a completed edit while keeping an externally uploaded object and current camera", () => {
    const original = doc([item("shape:a")]), moved = { ...original, items: [{ ...original.items[0]!, x: 90 }] }, edit = createEdit(original, moved)!;
    const upload = item("shape:uploaded", { kind: "image", url: "/fixture.png" });
    const current = { ...moved, items: [...moved.items, upload], camera: { x: 20, y: 40, zoom: 2 } };
    const undone = applyEdit(current, edit, "before"), redone = applyEdit(undone, edit, "after");
    expect(undone.items.map(value => value.id)).toEqual(["shape:a", "shape:uploaded"]);
    expect(undone.items[0]!.x).toBe(10); expect(redone.items[0]!.x).toBe(90);
    expect(redone.items[1]).toBe(upload); expect(redone.source).toBe(original.source); expect(redone.camera).toBe(current.camera);
  });

  it("restores deleted layers and ordering without discarding later uploads", () => {
    const a = item("shape:a"), b = item("shape:b"), c = item("shape:c"), original = doc([a, b]);
    const removed = { ...original, items: [b] }, edit = createEdit(original, removed)!;
    expect(applyEdit({ ...removed, items: [b, c] }, edit, "before").items.map(value => value.id)).toEqual([a.id, b.id, c.id]);
    const reorder = createEdit(original, { ...original, items: [b, a] })!;
    expect(applyEdit({ ...original, items: [b, a, c] }, reorder, "before").items.map(value => value.id)).toEqual([a.id, b.id, c.id]);
    expect(createEdit(original, { ...original, camera: { x: 5, y: 5, zoom: 2 } })).toBeNull();
  });
});
