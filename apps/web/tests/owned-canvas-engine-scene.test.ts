import { describe, expect, it } from "vitest";
import type { OwnedCanvasItem } from "../src/lib/owned-canvas-model";
import { screenToWorld, worldToScreen, zoomCameraAt } from "../src/lib/owned-canvas-engine/camera";
import { OwnedCanvasScene } from "../src/lib/owned-canvas-engine/scene";

const item = (id: string, patch: Partial<OwnedCanvasItem> = {}): OwnedCanvasItem => ({
  id, kind: "shape", x: 0, y: 0, w: 40, h: 40, rotation: 0, opacity: 1, ...patch,
});
const camera = { x: 0, y: 0, zoom: 1 };
const viewport = { width: 100, height: 100 };
const none = new Set<string>();
const near = (actual: { x: number; y: number }, expected: { x: number; y: number }) => {
  expect(actual.x).toBeCloseTo(expected.x, 8);
  expect(actual.y).toBeCloseTo(expected.y, 8);
};

describe("owned engine camera coordinates", () => {
  it.each([0.1, 0.75, 1, 4])("round trips world and canvas-local screen coordinates at zoom %s", zoom => {
    const view = { x: -245.5, y: 133.25, zoom };
    const world = { x: -400.25, y: 760.75 }, screen = { x: 302.5, y: 74.25 };
    near(screenToWorld(worldToScreen(world, view), view), world);
    near(worldToScreen(screenToWorld(screen, view), view), screen);
  });

  it.each([[0.001, 0.1], [2.5, 2.5], [100, 4]])("preserves the anchor's world point when zoom %s is clamped to %s", (requested, expected) => {
    const before = { x: -247, y: 89, zoom: 0.75 }, anchor = { x: 313, y: 241 };
    const world = screenToWorld(anchor, before), after = zoomCameraAt(before, requested, anchor);
    expect(after.zoom).toBe(expected);
    near(worldToScreen(world, after), anchor);
    expect(before).toEqual({ x: -247, y: 89, zoom: 0.75 });
  });

  it("ignores invalid zoom input without replacing the camera", () => {
    expect(zoomCameraAt(camera, NaN, { x: 10, y: 20 })).toBe(camera);
    expect(zoomCameraAt(camera, Infinity, { x: 10, y: 20 })).toBe(camera);
    expect(zoomCameraAt(camera, 2, { x: Infinity, y: 20 })).toBe(camera);
  });
});

describe("owned engine scene visibility and paint ordering", () => {
  it("keeps rotated geometry whose visual extent reaches the viewport", () => {
    const scene = new OwnedCanvasScene();
    scene.update([
      item("shape:rotated", { x: 250, y: 0, w: 100, h: 100, rotation: Math.PI / 2 }),
      item("shape:outside", { x: 250, y: 0, w: 100, h: 100 }),
    ]);
    expect([...scene.cull(camera, viewport, none)]).toEqual(["shape:outside"]);
  });

  it("includes the painted stroke width near the viewport edge", () => {
    const scene = new OwnedCanvasScene();
    scene.update([
      item("shape:thick-line", { shape: "line", x: 0, y: 201, w: 100, h: 1, strokeWidth: 12 }),
      item("shape:thin-line", { shape: "line", x: 0, y: 201, w: 100, h: 1, strokeWidth: 2 }),
      item("shape:pen", { kind: "stroke", x: 0, y: 201, w: 100, h: 1, strokeWidth: 12, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }),
    ]);
    expect([...scene.cull(camera, viewport, none)]).toEqual(["shape:thin-line"]);
  });

  it("uses screen-space overscan at different zoom levels", () => {
    const scene = new OwnedCanvasScene();
    scene.update([item("shape:a", { kind: "image", x: 300, y: 0, w: 10, h: 10 })]);
    expect(scene.cull(camera, viewport, none).has("shape:a")).toBe(true);
    expect(scene.cull({ ...camera, zoom: 0.5 }, viewport, none).has("shape:a")).toBe(false);
  });

  it.each([{ width: 0, height: 100 }, { width: 100, height: 0 }, { width: 0, height: 0 }])("does not blank objects before the host is measured: %j", size => {
    const scene = new OwnedCanvasScene();
    scene.update([item("shape:outside", { x: 10000 })]);
    expect(scene.cull(camera, viewport, none).size).toBe(1);
    expect(scene.cull(camera, size, none).size).toBe(0);
  });

  it("keeps selected or actively edited offscreen objects mounted until protection is released", () => {
    const scene = new OwnedCanvasScene();
    scene.update([item("shape:selected", { x: 10000 }), item("shape:editing", { x: 20000 }), item("shape:other", { x: 30000 })]);
    expect([...scene.cull(camera, viewport, new Set(["shape:selected", "shape:editing"]))]).toEqual(["shape:other"]);
    expect(scene.cull(camera, viewport, none).size).toBe(3);
  });

  it("reuses the culled set when camera or document changes leave membership unchanged", () => {
    const scene = new OwnedCanvasScene(), outside = item("shape:outside", { x: 10000 });
    scene.update([item("shape:visible"), outside]);
    const first = scene.cull(camera, viewport, none);
    expect(scene.cull({ ...camera, x: 1 }, viewport, new Set())).toBe(first);
    scene.update([item("shape:visible", { x: 1 }), { ...outside, x: 11000 }]);
    expect(scene.cull(camera, viewport, none)).toBe(first);
    const unculled = scene.cull(camera, viewport, new Set([outside.id]));
    expect(unculled).not.toBe(first);
    expect([...first]).toEqual([outside.id]);
    expect(scene.cull(camera, viewport, new Set([outside.id]))).toBe(unculled);
  });

  it("invalidates cached bounds after an immutable object move", () => {
    const scene = new OwnedCanvasScene(), original = item("shape:moved");
    scene.update([original]);
    expect(scene.cull(camera, viewport, none).size).toBe(0);
    scene.update([{ ...original, x: 1000 }]);
    expect(scene.cull(camera, viewport, none).has(original.id)).toBe(true);
    expect(scene.cull({ ...camera, x: -1000 }, viewport, none).has(original.id)).toBe(false);
    scene.update([original]);
    expect(scene.cull({ ...camera, x: -1000 }, viewport, none).has(original.id)).toBe(true);
    expect(scene.cull(camera, viewport, none).has(original.id)).toBe(false);
  });

  it("keeps stable DOM order while paint order follows the document", () => {
    const scene = new OwnedCanvasScene(), a = item("shape:a"), z = item("shape:z"), m = item("shape:m");
    const initial = [z, a, m];
    scene.update(initial);
    const entries = scene.renderEntries;
    expect(entries.map(entry => [entry.item.id, entry.zIndex])).toEqual([[a.id, 1], [m.id, 2], [z.id, 0]]);
    expect(entries.map(entry => entry.item)).toEqual([a, m, z]);
    scene.update(initial);
    expect(scene.renderEntries).toBe(entries);
    scene.update([m, z, a]);
    expect(scene.renderEntries.map(entry => [entry.item.id, entry.zIndex])).toEqual([[a.id, 2], [m.id, 0], [z.id, 1]]);
    expect(initial).toEqual([z, a, m]);
  });

  it("inherits hidden and locked state through nested frames and refreshes it after changes", () => {
    const scene = new OwnedCanvasScene();
    const parent = item("shape:outer", { kind: "frame", hidden: true, locked: true });
    const frame = item("shape:inner", { kind: "frame", frameId: parent.id });
    const child = item("shape:image", { kind: "image", frameId: frame.id });
    scene.update([child, frame, parent]);
    expect(scene.sceneFlags.get(child.id)).toEqual({ hidden: true, locked: true });
    expect(scene.sceneFlags.get(frame.id)).toEqual({ hidden: true, locked: true });
    scene.update([child, frame, { ...parent, hidden: false, locked: false }]);
    expect(scene.sceneFlags.get(child.id)).toEqual({ hidden: false, locked: false });
    expect(scene.renderEntries).toHaveLength(3);
  });
});
