import { describe, expect, it } from "vitest";
import { emptyOwnedDocument, type OwnedCanvasItem } from "../src/lib/owned-canvas-model";
import { requireOwnedLayerRepairMaterial, requireOwnedLayerRepairSource } from "../src/components/owned-canvas/owned-layer-repair";
import { StudioDecompositionView } from "../../../packages/contracts/src/studio-decomposition";

const task = StudioDecompositionView.parse({ requestId: "task", mutationId: "00000000-0000-4000-8000-000000000001", projectId: "p", sourceShapeId: "shape:original", assetId: "original", assetSha256: "a".repeat(64), documentRevision: 0,
  sourceWidth: 1024, sourceHeight: 768, layerCount: 2, status: "SUCCEEDED", error: null, createdAt: "2026-10-30T00:00:00.000Z", expiresAt: "2026-10-30T00:06:00.000Z", archiveExpiresAt: null, canRetryArchive: false,
  layers: [0, 1].map(order => ({ order, assetId: `l${order}`, assetSha256: "b".repeat(64), width: 1024, height: 768, mimeType: "image/png", sizeBytes: 200, url: `/api/workspaces/w/assets/l${order}/raw`, alphaBounds: { left: 0, top: 0, width: 1024, height: 768 }, inkCoverage: 0.3 })) });
const document = emptyOwnedDocument();
const original: OwnedCanvasItem = { id: task.sourceShapeId, kind: "image", assetId: task.assetId, assetSha256: task.assetSha256, url: "/api/workspaces/w/assets/original/raw", parentId: document.pageId, x: 0, y: 0, w: 512, h: 384, rotation: 0, opacity: 1 };
document.items = [original, { ...original, id: "shape:foreground", assetId: "l1", assetSha256: "b".repeat(64) }];
const material = { assetId: task.assetId, assetSha256: task.assetSha256, url: original.url!, width: 1024, height: 768 };

describe("explicit layer background repair source", () => {
  it("targets the saved original even when a decomposed layer follows it; no input is mutated", () => {
    const before = structuredClone(document);
    expect(requireOwnedLayerRepairSource(document, task, "p")).toBe(original);
    expect(requireOwnedLayerRepairMaterial([material, { ...material, assetId: "l1" }], task, "w")).toBe(material);
    expect(document).toEqual(before);
  });
  it("rejects a missing original, copied shape, replacement hash, and a task from another project", () => {
    for (const value of [null, { ...document, items: document.items.slice(1) }, { ...document, items: [{ ...original, id: "shape:copy" }] },
      { ...document, items: [{ ...original, assetSha256: "c".repeat(64) }] }]) expect(() => requireOwnedLayerRepairSource(value, task, "p")).toThrow(/原图/);
    expect(() => requireOwnedLayerRepairSource(document, task, "other")).toThrow(/当前项目/);
    expect(() => requireOwnedLayerRepairSource(document, { ...task, status: "RUNNING" }, "p")).toThrow(/已完成/);
  });
  it.each([{ hidden: true }, { locked: true }, { opacity: .7 }, { rotation: 90 }, { flipX: true }, { flipY: true }, { crop: { x: 0, y: 0, w: .5, h: 1 } }])("blocks a source that no longer represents the editable full frame: %j", change => {
    expect(() => requireOwnedLayerRepairSource({ ...document, items: [{ ...original, ...change }] }, task, "p")).toThrow();
  });
  it("does not substitute a layer or a foreign/dimension-mismatched material for original pixels", () => {
    for (const candidate of [{ ...material, assetId: "l1" }, { ...material, assetSha256: "c".repeat(64) },
      { ...material, width: 2048 }, { ...material, url: "/api/workspaces/other/assets/original/raw" }])
      expect(() => requireOwnedLayerRepairMaterial([candidate], task, "w")).toThrow(/持久化版本/);
  });
});
