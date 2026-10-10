import { describe, expect, it, vi } from "vitest";
vi.mock("../../../apps/web/src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
import { emptyOwnedDocument, serializeOwnedDocument } from "../../../apps/web/src/lib/owned-canvas-model";
import { deriveStudioExactLayout } from "../../../apps/web/src/lib/studio-exact-geometry";

function input() {
  const doc = emptyOwnedDocument();
  doc.items = [
    { id: "shape:frame", kind: "frame", x: 0, y: 0, w: 1000, h: 500, rotation: 0, opacity: 1 },
    { id: "shape:image", kind: "image", x: 100, y: 100, w: 200, h: 100, rotation: 0, opacity: 1,
      url: "/api/workspaces/ws/assets/asset/raw", assetId: "asset", assetSha256: "a".repeat(64) },
  ];
  const store = (serializeOwnedDocument(doc).tldrawSnapshot as { document: { store: unknown } }).document.store;
  return { doc, store, outputFrameId: "shape:frame", outputWidth: 2000, outputHeight: 1000,
    references: [{ shapeId: "shape:image", assetId: "asset", sha256: "a".repeat(64), width: 100, height: 50 }] };
}
describe("owned document used by the actual server EXACT geometry", () => {
  it("preserves source identity, page, frame, placement and stacking", () => {
    const result = deriveStudioExactLayout(input());
    expect(result.frame).toMatchObject({ shapeId: "shape:frame", pageId: "page:novart", width: 1000, height: 500 });
    expect(result.assetUsages).toEqual([{ assetId: "asset", mode: "EXACT", order: 0,
      exactTransform: { xRatio: .2, yRatio: .3, widthRatio: .2, rotationDeg: 0, flipX: false, zIndex: 0,
        crop: { left: 0, top: 0, right: 0, bottom: 0 } } }]);
  });
  it("retains server rejection of incompatible output aspect and opacity", () => {
    const value = input();
    expect(() => deriveStudioExactLayout({ ...value, outputWidth: 1000 })).toThrow(/比例/);
    value.doc.items[1]!.opacity = .5;
    const store = (serializeOwnedDocument(value.doc).tldrawSnapshot as { document: { store: unknown } }).document.store;
    expect(() => deriveStudioExactLayout({ ...value, store })).toThrow(/透明/);
  });
});
