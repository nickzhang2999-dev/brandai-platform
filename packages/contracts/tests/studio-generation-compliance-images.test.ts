import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ rules: vi.fn(), assets: vi.fn(), bytes: vi.fn(), inspect: vi.fn() }));
vi.mock("../../db/src/index", () => ({ prisma: { prohibitionRule: { findMany: f.rules }, asset: { findMany: f.assets } } }));
vi.mock("../../../apps/web/src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("../../../apps/web/src/lib/studio-generation-artifacts-image", () => ({ artifactDeadline: async (p: Promise<any>) => p, readArtifactImageBytes: f.bytes, inspectArtifactImage: f.inspect, STUDIO_ARTIFACT_MAX_BYTES: 32 * 1024 * 1024 }));
import { loadStudioComplianceReferences } from "../../../apps/web/src/lib/studio-generation-compliance-images";
const signal = () => AbortSignal.timeout(10000);
beforeEach(() => {
  vi.resetAllMocks(); f.rules.mockResolvedValue([{ id: "rule", description: "Keep original logo", positiveExampleAssetId: "asset", negativeExampleAssetId: null }]);
  f.assets.mockResolvedValue([{ id: "asset", url: "http://private/w/asset", storageKey: "w/asset" }]); f.bytes.mockResolvedValue(Buffer.from("image")); f.inspect.mockResolvedValue({ sha256: "a".repeat(64), mimeType: "image/png" });
});
describe("visual compliance private and complete example transport", () => {
  it("uses workspace-scoped asset IDs and forwards verified image bytes instead of internal URLs", async () => {
    const out = await loadStudioComplianceReferences("w", signal(), 10);
    expect(f.assets).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: "w", id: { in: ["asset"] }, deprecatedAt: null } }));
    expect(f.bytes).toHaveBeenCalledWith({ imageUrl: "http://private/w/asset", objectKey: "w/asset" }, expect.any(AbortSignal));
    expect(out.referenceImages[0]).toMatchObject({ sourceHint: "UPLOAD", polarity: "positive", source: "prohibition:rule", url: "data:image/png;base64,aW1hZ2U=" });
    expect(out.audit[0]).toEqual({ assetId: "asset", sha256: "a".repeat(64), source: "prohibition:rule", polarity: "positive" });
  });
  it("fails for missing or foreign assets instead of silently dropping active references", async () => {
    f.assets.mockResolvedValue([]); await expect(loadStudioComplianceReferences("w", signal(), 10)).rejects.toMatchObject({ status: 422 }); expect(f.bytes).not.toHaveBeenCalled();
  });
  it("rejects references that would be silently truncated by the VLM eight-image ceiling", async () => {
    f.rules.mockResolvedValue(Array.from({ length: 9 }, (_, i) => ({ id: `r${i}`, description: "", positiveExampleAssetId: `a${i}` })));
    await expect(loadStudioComplianceReferences("w", signal(), 10)).rejects.toMatchObject({ status: 422 }); expect(f.assets).not.toHaveBeenCalled();
  });
  it("enforces the main-image plus reference-byte total before sending anything to the provider", async () => {
    await expect(loadStudioComplianceReferences("w", signal(), 32 * 1024 * 1024)).rejects.toMatchObject({ status: 422 }); expect(f.inspect).not.toHaveBeenCalled();
  });
});
