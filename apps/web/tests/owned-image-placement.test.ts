import { describe, expect, it } from "vitest";
import { nextOwnedImagePosition } from "../src/components/owned-canvas/owned-image-placement";
import { bounds } from "../src/components/owned-canvas/geometry";
import { emptyOwnedDocument, type OwnedCanvasItem } from "../src/lib/owned-canvas-model";

const image = (id: string, x: number, y: number, w: number, h: number, extra: Partial<OwnedCanvasItem> = {}): OwnedCanvasItem =>
  ({ id, kind: "image", x, y, w, h, rotation: 0, opacity: 1, ...extra });
const add = (document: ReturnType<typeof emptyOwnedDocument>, id: string, w: number, h: number, source?: string) => {
  const center = nextOwnedImagePosition(document, w, h, source);
  const item = image(id, center.x - w / 2, center.y - h / 2, w, h);
  document.items.push(item);
  return item;
};

describe("world-coordinate image placement", () => {
  it("puts three new images in rows below all content without dependence on pan or zoom", () => {
    const document = emptyOwnedDocument();
    document.camera = { x: -50_000, y: 60_000, zoom: 0.05 };
    const first = add(document, "shape:first", 640, 480);
    document.camera = { x: 9_000, y: -3_000, zoom: 8 };
    const second = add(document, "shape:second", 320, 600);
    const third = add(document, "shape:third", 900, 200);
    expect([first.x, second.x, third.x]).toEqual([0, 0, 0]);
    expect([first.y, second.y, third.y]).toEqual([0, 528, 1176]);
  });

  it("accounts for rotated content instead of overlapping its axis-aligned footprint", () => {
    const document = emptyOwnedDocument();
    document.items = [image("shape:rotated", -100, -300, 300, 100, { rotation: Math.PI / 4 })];
    const occupied = bounds(document.items)!;
    const placed = add(document, "shape:next", 128, 256);
    expect(placed.x).toBeCloseTo(occupied.x);
    expect(placed.y).toBeCloseTo(occupied.y + occupied.h + 48);
  });

  it("places edits beside their original and avoids existing variants", () => {
    const document = emptyOwnedDocument();
    const original = image("shape:original", 100, 200, 600, 400);
    document.items = [original];
    const second = add(document, "shape:second", 400, 400, original.id);
    const third = add(document, "shape:third", 400, 400, original.id);
    expect([second.x, second.y]).toEqual([748, 200]);
    expect([third.x, third.y]).toEqual([1196, 200]);
    expect(document.items[0]).toEqual(original);
  });

  it("falls back to document ordering when the source is missing and ignores hidden content", () => {
    const document = emptyOwnedDocument();
    document.items = [image("shape:visible", -20, 100, 300, 200), image("shape:hidden", -9000, 9000, 900, 900, { hidden: true })];
    const placed = add(document, "shape:next", 200, 100, "shape:missing");
    expect([placed.x, placed.y]).toEqual([-20, 348]);
  });
});
