import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ assets: vi.fn(), read: vi.fn(), inspect: vi.fn(), lock: vi.fn() }));
vi.mock("../../../packages/db/src/index", () => ({ prisma: { asset: { findMany: f.assets } }, Prisma: { sql: vi.fn(), join: vi.fn() } }));
vi.mock("../src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("../src/lib/studio-generation-artifacts-image", () => ({ readArtifactImageBytes: f.read, inspectArtifactImage: f.inspect,
  artifactDeadline: (value: unknown) => value, STUDIO_ARTIFACT_MAX_BYTES: 32 * 1024 * 1024 }));
import { assertStudioFidelityReferenceBindings, loadStudioFidelityReferences } from "../src/lib/studio-visual-fidelity-images";
const sha = "a".repeat(64), refs = [{ assetId: "asset", sha256: sha, source: "asset:asset", polarity: "positive", mode: "STRICT", note: "仅借鉴风格" }];
const asset = { id: "asset", url: "http://private-storage/w/image", storageKey: "w/image" };
const signal = () => new AbortController().signal;
beforeEach(() => { vi.resetAllMocks(); f.assets.mockResolvedValue([asset]); f.read.mockResolvedValue(Buffer.from("image")); f.inspect.mockResolvedValue({ sha256: sha, mimeType: "image/png" }); });
describe("actual generation reference evidence", () => {
  it("reads scoped image bytes and carries reference context without claiming identity lock", async () => {
    const result = await loadStudioFidelityReferences("w", refs, signal(), 10);
    expect(f.assets).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId: "w", availableForGeneration: true, deprecatedAt: null }) }));
    expect(result.images[0]).toMatchObject({ sha256: sha, role: "reference-context", sourceHint: "UPLOAD" });
    expect(result.images[0]!.note).toContain("仅借鉴风格");
    expect(result.images[0]!.url).toBe("data:image/png;base64,aW1hZ2U="); expect(result.totalBytes).toBe(15);
  });
  it("rejects foreign, withdrawn or ambiguous assets before reading bytes", async () => {
    for (const assets of [[], [asset, asset]]) { f.assets.mockResolvedValue(assets); await expect(loadStudioFidelityReferences("w", refs, signal(), 0)).rejects.toMatchObject({ status: 422 }); }
    expect(f.read).not.toHaveBeenCalled();
  });
  it("rejects byte replacement beneath the same asset ID", async () => {
    f.inspect.mockResolvedValue({ sha256: "b".repeat(64), mimeType: "image/png" });
    await expect(loadStudioFidelityReferences("w", refs, signal(), 0)).rejects.toMatchObject({ status: 422 });
  });
  it("accounts for output, prohibition and edit-source bytes instead of resetting budget", async () => {
    await expect(loadStudioFidelityReferences("w", refs, signal(), 32 * 1024 * 1024 - 4)).rejects.toMatchObject({ status: 422 });
    expect(f.inspect).not.toHaveBeenCalled();
  });
  it("does not truncate excessive role text or a ninth reference", async () => {
    await expect(loadStudioFidelityReferences("w", [{ ...refs[0]!, note: "字".repeat(4000) }], signal(), 0)).rejects.toMatchObject({ status: 422 });
    await expect(loadStudioFidelityReferences("w", Array(9).fill(refs[0]), signal(), 0)).rejects.toMatchObject({ status: 422 });
  });
  it("locks scoped references at publication and rejects URL/key changes or withdrawal", async () => {
    const db = { asset: { findMany: f.assets }, $queryRaw: f.lock } as never;
    await assertStudioFidelityReferenceBindings(db, "w", refs, [asset]); expect(f.lock).toHaveBeenCalledOnce();
    f.assets.mockResolvedValue([{ ...asset, storageKey: "w/replaced" }]);
    await expect(assertStudioFidelityReferenceBindings(db, "w", refs, [asset])).rejects.toMatchObject({ status: 422 });
    f.assets.mockResolvedValue([]); await expect(assertStudioFidelityReferenceBindings(db, "w", refs, [asset])).rejects.toMatchObject({ status: 422 });
  });
  it("has no reference I/O for an ordinary new image without references", async () => {
    expect(await loadStudioFidelityReferences("w", [], signal(), 100)).toEqual({ images: [], totalBytes: 100, bindings: [] });
    expect(f.read).not.toHaveBeenCalled(); expect(f.assets).not.toHaveBeenCalled();
  });
});
