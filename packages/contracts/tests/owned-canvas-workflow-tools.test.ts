import { describe, expect, it, vi } from "vitest";
vi.mock("../../../apps/web/src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
import { emptyOwnedDocument, serializeOwnedDocument } from "../../../apps/web/src/lib/owned-canvas-model";
import { encodeOwnedCanvas } from "../../../apps/web/src/lib/owned-canvas-codec";
import { deriveStudioExactLayout } from "../../../apps/web/src/lib/studio-exact-geometry";
import { workflowAssets, workflowIssues } from "../../../apps/web/src/lib/studio-workflow-codec";

const sha = "a".repeat(64), url = "/api/workspaces/own/assets/image/raw";
function scene() {
  const doc = emptyOwnedDocument();
  doc.items = [{ id: "shape:frame", kind: "frame", x: 0, y: 0, w: 1000, h: 500, opacity: 1, rotation: 0 },
    { id: "shape:image", kind: "image", x: 100, y: 100, w: 200, h: 100, opacity: 1, rotation: 0, url, assetId: "image", assetSha256: sha }];
  return doc;
}
function exact(doc: ReturnType<typeof scene>) {
  const store = (serializeOwnedDocument(doc).tldrawSnapshot as { document: { store: unknown } }).document.store;
  return deriveStudioExactLayout({ store, outputFrameId: "shape:frame", outputWidth: 1000, outputHeight: 500,
    references: [{ shapeId: "shape:image", assetId: "image", sha256: sha, width: 200, height: 100 }] });
}
describe("new owned editing effects remain visible to server generation guards", () => {
  it("blocks hidden references without silently deleting their saved participation", async () => {
    const doc = scene(); doc.items[1]!.hidden = true;
    const view = workflowAssets("project", await encodeOwnedCanvas(doc), [{ sha256: sha, url, mimeType: "image/png" }]);
    expect(view.assets[0]).toMatchObject({ shapeId: "shape:image", valid: false });
    const input = { references: [{ shapeId: "shape:image", assetSha256: sha, purpose: "EXACT" as const, participates: true }], target: null };
    expect(workflowIssues(input, view.assets)[0]).toMatchObject({ code: "SHAPE_HIDDEN", blocking: true });
    expect(input.references[0]!.participates).toBe(true);
    expect(() => exact(doc)).toThrow(/隐藏/);
  });
  it("keeps a visible locked image usable as an explicit reference", async () => {
    const doc = scene(); doc.items[1]!.locked = true;
    const view = workflowAssets("project", await encodeOwnedCanvas(doc), [{ sha256: sha, url, mimeType: "image/png" }]);
    expect(view.assets[0]!.valid).toBe(true);
    expect(exact(doc).assetUsages).toHaveLength(1);
  });
  it("inherits visibility from flat owned frame links", async () => {
    const doc = scene(); doc.items[0]!.hidden = true; doc.items[1]!.frameId = "shape:frame";
    const view = workflowAssets("project", await encodeOwnedCanvas(doc), [{ sha256: sha, url, mimeType: "image/png" }]);
    expect(view.assets[0]!.valid).toBe(false);
    expect(() => exact(doc)).toThrow(/隐藏/);
    doc.items[0]!.hidden = false;
    const visible = workflowAssets("project", await encodeOwnedCanvas(doc), [{ sha256: sha, url, mimeType: "image/png" }]);
    expect(visible.assets[0]!.valid).toBe(true);
  });
  it("does not silently submit original pixels after a display crop", () => {
    const doc = scene(); doc.items[1]!.crop = { x: .25, y: 0, w: .5, h: 1 };
    expect(() => exact(doc)).toThrow(/裁切/);
  });
  it("preserves the existing server deterministic flip geometry", () => {
    const doc = scene(); doc.items[1]!.flipX = true;
    expect(exact(doc).assetUsages[0]!.exactTransform!.flipX).toBe(true);
  });
});
