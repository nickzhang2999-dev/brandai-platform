import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ assets: vi.fn(), read: vi.fn(), inspect: vi.fn() }));
vi.mock("../../db/src/index", () => ({ prisma: { asset: { findMany: f.assets } } }));
vi.mock("../../../apps/web/src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("../../../apps/web/src/lib/studio-generation-artifacts-image", () => ({ readArtifactImageBytes: f.read, inspectArtifactImage: f.inspect }));
import { inlineStudioGenerationReferences, studioProviderParams } from "../../../apps/web/src/lib/studio-generation-references";
beforeEach(() => { vi.resetAllMocks(); f.assets.mockResolvedValue([{ id: "asset", url: "http://private-minio/w/object", storageKey: "w/object" }]); f.read.mockResolvedValue(Buffer.from("bytes")); f.inspect.mockResolvedValue({ mimeType: "image/png", sha256: "a".repeat(64) }); });
describe("private source transport and public audit", () => {
  const refs = [{ url: "http://private-minio/w/object", source: "asset:asset", polarity: "positive" as const, mode: "STRICT" as const, note: "ASSET_USAGE:ADAPTIVE:1" }];
  it("uses actual authenticated object bytes for provider and only identity/hash for audit", async () => {
    const signal = new AbortController().signal;
    const result = await inlineStudioGenerationReferences("w", refs, signal, { asset: "a".repeat(64) });
    expect(f.assets).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId: "w", availableForGeneration: true, deprecatedAt: null }) }));
    expect(f.read).toHaveBeenCalledWith({ imageUrl: refs[0].url, objectKey: "w/object" }, signal);
    expect(result.references[0].url).toBe("data:image/png;base64,Ynl0ZXM=");
    expect(JSON.stringify(result.audit)).not.toMatch(/private-minio|data:image/); expect(result.audit[0]).toMatchObject({ assetId: "asset", sha256: "a".repeat(64) });
  });
  it("fails missing/foreign/ambiguous sources and invalid brand logos rather than omitting them", async () => {
    f.assets.mockResolvedValue([]); await expect(inlineStudioGenerationReferences("w", refs, new AbortController().signal, { asset: "a".repeat(64) })).rejects.toThrow(); expect(f.read).not.toHaveBeenCalled();
    f.assets.mockResolvedValue([{ id: "asset", url: refs[0].url, storageKey: "w/key" }]); f.inspect.mockRejectedValue(new Error("SVG unsupported")); await expect(inlineStudioGenerationReferences("w", refs, new AbortController().signal, { asset: "a".repeat(64) })).rejects.toThrow("SVG unsupported");
  });
  it("never copies upstream request echoes, base64 or signed URL params into visible version metadata", () => {
    expect(studioProviderParams({ actualWidth: 20, model: "model", request: { secret: true }, appliedReferenceImages: refs, quality: "data:image/png;base64,raw", provider: "https://signed/x" })).toEqual({ actualWidth: 20, model: "model" });
  });
  it("rejects changed bytes under the same accepted object key before producing a provider reference", async () => {
    f.inspect.mockResolvedValue({ mimeType: "image/png", sha256: "b".repeat(64) });
    await expect(inlineStudioGenerationReferences("w", refs, new AbortController().signal, { asset: "a".repeat(64) })).rejects.toMatchObject({ status: 422 });
    expect(f.read).toHaveBeenCalledWith({ imageUrl: refs[0].url, objectKey: "w/object" }, expect.any(AbortSignal));
  });
  it("rejects a missing or malformed expected SHA instead of downgrading to URL identity", async () => {
    for (const expected of [undefined, {}, { asset: "missing" }]) {
      await expect(inlineStudioGenerationReferences("w", refs, new AbortController().signal, expected)).rejects.toMatchObject({ status: 422 });
    }
    expect(f.read).not.toHaveBeenCalled();
  });
  it("rejects an accepted active asset dropped from the final reference payload, even if present as a brand reference", async () => {
    const expected = { asset: "a".repeat(64) };
    await expect(inlineStudioGenerationReferences("w", [], new AbortController().signal, expected)).rejects.toMatchObject({ status: 422 });
    await expect(inlineStudioGenerationReferences("w", [{ ...refs[0], source: "brand_rule:logo" }], new AbortController().signal, expected)).rejects.toMatchObject({ status: 422 });
    expect(f.read).not.toHaveBeenCalled();
  });
  it("keeps brand-only source preflight without inventing an accepted workflow digest", async () => {
    const result = await inlineStudioGenerationReferences("w", [{ ...refs[0], source: "brand_rule:logo" }], new AbortController().signal, {});
    expect(result.audit[0]).toMatchObject({ assetId: "asset", sha256: "a".repeat(64) });
    expect(result.references[0].url).toBe("data:image/png;base64,Ynl0ZXM=");
  });
});
