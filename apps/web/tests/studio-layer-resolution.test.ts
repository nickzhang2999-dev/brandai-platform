import { describe, expect, it } from "vitest";
import { StudioDecompositionLayer } from "@brandai/contracts";

const layer = { assetId: "layer_1", assetSha256: "b".repeat(64), mimeType: "image/png", width: 120, height: 80, order: 0,
  sizeBytes: 100, url: "/api/workspaces/workspace_1/assets/layer_1/raw", alphaBounds: { left: 10, top: 5, width: 20, height: 30 }, inkCoverage: 0.1 };
const resolution = { sourceWidth: 120, sourceHeight: 80, providerWidth: 60, providerHeight: 40, publishedWidth: 120,
  publishedHeight: 80, scaleX: 2, scaleY: 2, resampling: "LANCZOS3", rgbSource: "PROVIDER" };
describe("permanent layer resolution receipts", () => {
  it("keeps legacy provider size unknown and retains measured new receipts", () => {
    expect(StudioDecompositionLayer.parse(layer).resolution).toBeUndefined();
    expect(StudioDecompositionLayer.parse({ ...layer, resolution }).resolution).toEqual(resolution);
  });
  it.each([{ scaleX: 1 }, { scaleY: 1 }, { sourceWidth: 60 }, { publishedWidth: 60 }, { resampling: "NONE" }, { rgbSource: "SOURCE" }, { providerWidth: 0 }, { scaleX: Infinity }])("rejects untrue resolution evidence %j", patch => {
    expect(StudioDecompositionLayer.safeParse({ ...layer, resolution: { ...resolution, ...patch } }).success).toBe(false);
  });
  it("rejects null or a receipt that describes another published layer", () => {
    expect(StudioDecompositionLayer.safeParse({ ...layer, resolution: null }).success).toBe(false);
    expect(StudioDecompositionLayer.safeParse({ ...layer, width: 240, resolution }).success).toBe(false);
  });
  it("accepts native-size without claiming lossless reconstruction", () => {
    expect(StudioDecompositionLayer.parse({ ...layer, resolution: { ...resolution, providerWidth: 120, providerHeight: 80, scaleX: 1, scaleY: 1, resampling: "NONE" } }).resolution?.rgbSource).toBe("PROVIDER");
  });
});
