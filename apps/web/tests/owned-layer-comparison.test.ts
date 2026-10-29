import { describe, expect, it } from "vitest";
import { ownedLayerComparisonPlan } from "../src/components/owned-canvas/owned-layer-comparison";
import { ownedLayerQualityLabel, ownedLayerTaskNotice, ownedLayerTaskTitle } from "../src/components/owned-canvas/owned-layer-options";
import { StudioDecompositionView } from "../../../packages/contracts/src/studio-decomposition";
import { STUDIO_LAYER_QUALITY_THRESHOLDS } from "../../../packages/contracts/src/studio-layer-quality";

const task = StudioDecompositionView.parse({ requestId: "t", mutationId: "00000000-0000-4000-8000-000000000001", projectId: "p", sourceShapeId: "shape:s", assetId: "s", assetSha256: "a".repeat(64), documentRevision: 0,
  sourceWidth: 2048, sourceHeight: 1024, layerCount: 2, status: "SUCCEEDED", error: null, createdAt: "2026-10-29T00:00:00.000Z", expiresAt: "2026-10-29T00:06:00.000Z", archiveExpiresAt: null, canRetryArchive: false,
  layers: [0, 1].map(order => ({ order, assetId: `l${order}`, assetSha256: "b".repeat(64), width: 2048, height: 1024, mimeType: "image/png", sizeBytes: 200, url: `/api/workspaces/w/assets/l${order}/raw`, alphaBounds: { left: 0, top: 0, width: 2048, height: 1024 }, inkCoverage: 0.3 })) });
describe("owned layer comparison boundaries", () => {
  it("uses same workspace raw assets and preserves full-frame aspect and stacking order", () => {
    const plan = ownedLayerComparisonPlan({ ...task, layers: [...task.layers].reverse() }, "w", "p");
    expect(plan.sourceUrl).toBe("/api/workspaces/w/assets/s/raw");
    expect([plan.width, plan.height]).toEqual([1024, 512]);
    expect(plan.layers.map(layer => layer.order)).toEqual([0, 1]);
  });
  it("rejects foreign projects, assets, incomplete orders and oversized pixel budgets before reading", () => {
    for (const invalid of [{ ...task, projectId: "other" }, { ...task, status: "RUNNING" as const },
      { ...task, layers: task.layers.map(layer => ({ ...layer, url: layer.url.replace("/w/", "/other/") })) },
      { ...task, layers: task.layers.map(layer => ({ ...layer, order: 0 })) },
      { ...task, sourceWidth: 16384, sourceHeight: 16384 }]) expect(() => ownedLayerComparisonPlan(invalid, "w", "p")).toThrow();
  });
  it("never calls stored PNGs editable text or calls legacy and uncertain quality passed", () => {
    expect(ownedLayerTaskTitle(task)).toBe("2 个图片图层");
    expect(ownedLayerTaskNotice(task)).toContain("文字仍是图片");
    expect(ownedLayerQualityLabel(task)).toBe("尚未做质量初检");
    const quality = { revision: "layer-quality-r1" as const, sourceSha256: task.assetSha256, sourceWidth: 2048, sourceHeight: 1024,
      sampleWidth: 1024, sampleHeight: 512, status: "COMPOSITE_MATCH" as const, metrics: { meanAbsoluteError: 0, changedPixelRatio: 0, alphaMeanAbsoluteError: 0 },
      regions: [], warnings: [], unavailableReason: null, thresholds: STUDIO_LAYER_QUALITY_THRESHOLDS, semanticsChecked: false as const, textChecked: false as const, humanReviewRequired: true as const, checkedAt: "2026-10-29T00:00:00.000Z" };
    expect(ownedLayerQualityLabel({ ...task, quality })).toBe("像素初检未见明显重合成差异");
    expect(ownedLayerQualityLabel({ ...task, quality: { ...quality, status: "REVIEW_REQUIRED" } })).toContain("需复核");
    expect(ownedLayerQualityLabel({ ...task, quality: { ...quality, status: "UNAVAILABLE" } })).toContain("不可用");
    for (const status of ["COMPOSITE_MATCH", "REVIEW_REQUIRED", "UNAVAILABLE"] as const)
      expect(ownedLayerTaskNotice({ ...task, quality: { ...quality, status } })).not.toContain("通过");
  });
});
