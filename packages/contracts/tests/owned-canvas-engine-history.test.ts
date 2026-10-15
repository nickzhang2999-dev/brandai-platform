import { describe, expect, it } from "vitest";
import { OwnedCanvasHistory } from "../../../apps/web/src/lib/owned-canvas-engine/history";
import { createEdit } from "../../../apps/web/src/components/owned-canvas/geometry";
import { emptyOwnedDocument, type OwnedCanvasDocument, type OwnedCanvasItem } from "../../../apps/web/src/lib/owned-canvas-model";

const item = (id = "shape:a", extra: Partial<OwnedCanvasItem> = {}): OwnedCanvasItem => ({
  id, kind: "shape", x: 10, y: 20, w: 100, h: 80, rotation: 0, opacity: 1, shape: "rect", ...extra,
});
const doc = (items: OwnedCanvasItem[]): OwnedCanvasDocument => ({ ...emptyOwnedDocument(), items });

describe("owned canvas engine history", () => {
  it("ignores equivalent clones, key order and optional undefined without clearing redo", () => {
    const history = new OwnedCanvasHistory();
    const original = doc([item("shape:a", { points: [{ x: 0, y: 2 }], crop: { x: 0, y: 0, w: 1, h: 1 } })]);
    const moved = { ...original, items: [{ ...original.items[0]!, x: 90 }] };
    expect(history.record(original, moved)).toBe(true);
    const undone = history.undo(moved)!;
    const clone = { ...undone, camera: { x: 1, y: 2, zoom: 3 }, items: undone.items.map(value => ({
      text: undefined, ...value, points: value.points?.map(point => ({ y: point.y, x: point.x })),
      crop: { h: 1, w: 1, y: 0, x: 0 },
    })) };
    expect(history.record(undone, clone)).toBe(false);
    expect(createEdit(clone, undone)).toBeNull();
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(true);
    expect(history.redo(clone)?.items[0]!.x).toBe(90);
  });

  it("protects nested point and crop snapshots from caller and undo-result mutations", () => {
    const history = new OwnedCanvasHistory();
    const before = doc([item("shape:a", { points: [{ x: 1, y: 2 }], crop: { x: 0, y: 0, w: 1, h: 1 } })]);
    const after = doc([item("shape:a", { points: [{ x: 5, y: 6 }], crop: { x: 0.1, y: 0, w: 0.9, h: 1 } })]);
    history.record(before, after);
    before.items[0]!.points![0]!.x = 999;
    before.items[0]!.crop!.w = 0.1;
    after.items[0]!.points![0]!.y = 999;
    after.items[0]!.crop!.x = 0.9;
    const undone = history.undo(after)!;
    expect(undone.items[0]!.points).toEqual([{ x: 1, y: 2 }]);
    expect(undone.items[0]!.crop!.w).toBe(1);
    undone.items[0]!.points![0]!.x = 222;
    const redone = history.redo(undone)!;
    expect(redone.items[0]!.points).toEqual([{ x: 5, y: 6 }]);
    expect(redone.items[0]!.crop!.x).toBe(0.1);
    redone.items[0]!.points![0]!.y = 333;
    expect(history.undo(redone)?.items[0]!.points).toEqual([{ x: 1, y: 2 }]);
  });

  it("preserves independent uploads, latest camera and document metadata", () => {
    const history = new OwnedCanvasHistory(), original = doc([item()]);
    const moved = { ...original, items: [{ ...original.items[0]!, x: 90 }] };
    history.record(original, moved);
    const upload = item("shape:upload", { kind: "image", url: "/asset.png" });
    const current = { ...moved, items: [...moved.items, upload], camera: { x: 200, y: 200, zoom: 2 }, source: { saved: true }, warnings: ["keep"] };
    const undone = history.undo(current)!;
    expect(undone.items.map(value => value.id)).toEqual(["shape:a", "shape:upload"]);
    expect(undone.items[0]!.x).toBe(10);
    expect(undone.items[1]).toBe(upload);
    expect(undone.camera).toBe(current.camera);
    expect(undone.source).toBe(current.source);
    expect(undone.warnings).toBe(current.warnings);
    const redone = history.redo(undone)!;
    expect(redone.items[0]!.x).toBe(90);
    expect(redone.items[1]).toBe(upload);
  });

  it("restores deletions and reorder-only edits around later objects", () => {
    const history = new OwnedCanvasHistory(), a = item("shape:a"), b = item("shape:b"), c = item("shape:c");
    const initial = doc([a, b]), swapped = doc([b, a]);
    expect(history.record(initial, swapped)).toBe(true);
    expect(history.undo(doc([b, a, c]))?.items).toEqual([a, b, c]);
    const redone = history.redo(doc([a, b, c]))!;
    expect(redone.items).toEqual([b, a, c]);
    const removed = { ...redone, items: [b, c] };
    history.record(redone, removed);
    expect(history.undo(removed)?.items).toEqual([b, a, c]);
  });

  it("clears both stacks on a project or page scope reset", () => {
    const history = new OwnedCanvasHistory(), initial = doc([item()]);
    const moved = doc([item("shape:a", { x: 90 })]);
    history.record(initial, moved);
    history.undo(moved);
    expect(history.canRedo).toBe(true);
    history.clear();
    const otherProject = { ...initial, source: { project: "other" } };
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
    expect(history.undo(otherProject)).toBeNull();
    expect(history.redo(otherProject)).toBeNull();
  });

  it("discards redo after a new edit and retains only the configured number of edits", () => {
    const history = new OwnedCanvasHistory(2);
    const states = [0, 1, 2, 3, 4].map(x => doc([item("shape:a", { x })]));
    for (let index = 1; index < 4; index++) history.record(states[index - 1]!, states[index]!);
    const undone = history.undo(states[3]!)!;
    expect(undone.items[0]!.x).toBe(2);
    expect(history.undo(undone)?.items[0]!.x).toBe(1);
    expect(history.undo(states[1]!)).toBeNull();
    const redone = history.redo(states[1]!)!;
    expect(redone.items[0]!.x).toBe(2);
    history.record(redone, states[4]!);
    expect(history.canRedo).toBe(false);
    expect(history.redo(states[4]!)).toBeNull();
  });

  it("defaults to sixty edits and validates memory bounds", () => {
    const history = new OwnedCanvasHistory();
    let state = doc([item("shape:a", { x: 0 })]);
    for (let x = 1; x <= 65; x++) {
      const next = doc([item("shape:a", { x })]); history.record(state, next); state = next;
    }
    let undos = 0;
    while (history.canUndo) { state = history.undo(state)!; undos++; }
    expect(undos).toBe(60);
    expect(state.items[0]!.x).toBe(5);
    for (const limit of [0, -1, 1.2, 201, NaN, Infinity]) expect(() => new OwnedCanvasHistory(limit)).toThrow(RangeError);
    expect(() => new OwnedCanvasHistory(200)).not.toThrow();
  });
});
