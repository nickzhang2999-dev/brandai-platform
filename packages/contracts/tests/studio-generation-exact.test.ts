import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExactAssetTransform } from "../src/resource-usage";
const f = vi.hoisted(() => ({ asset: vi.fn(), read: vi.fn(), inspect: vi.fn(), encryption: vi.fn() }));
vi.mock("../../db/src/index", () => ({ prisma: { asset: { findFirst: f.asset } } }));
vi.mock("../../../apps/web/src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("../../../apps/web/src/lib/studio-generation-artifacts-image", () => ({ artifactDeadline: async (work: Promise<unknown>) => work, readArtifactImageBytes: f.read, inspectArtifactImage: f.inspect, STUDIO_ARTIFACT_MAX_BYTES: 32 * 1024 * 1024 }));
vi.mock("../../../apps/web/src/lib/studio-generation-base", () => ({ requireStudioBaseEncryption: f.encryption }));
import { studioExactIntent, preflightStudioExactSources, assertStudioExactNotModelInput, loadStudioExactAsset, StudioExactSnapshot } from "../../../apps/web/src/lib/studio-generation-exact";
const digest = "a".repeat(64), transform = ExactAssetTransform.parse({ widthRatio: .2 });
function snapshot() { return StudioExactSnapshot.parse({ target: { width: 1024, height: 1024 }, frame: { shapeId: "shape:frame", width: 100, height: 100, pageId: "page:one", pageTransform: [1,0,0,1,20,30] },
  layers: [{ shapeId: "shape:image", assetId: "a", sha256: digest, width: 20, height: 10, displayWidth: 20, displayHeight: 10, relativeTransform: [1,0,0,1,40,45], transform }],
  assetUsages: [{ mode: "EXACT", assetId: "a", order: 0, exactTransform: transform }] }); }
function accepted() { const layout = snapshot(); return { studioExactLayout: layout, targets: [{ ...layout.target }], assetUsages: structuredClone(layout.assetUsages), studioExpectedAssetSha256: { a: digest } }; }
beforeEach(() => { vi.resetAllMocks(); f.asset.mockResolvedValue({ storageKey: "w/a", url: "https://storage.invalid/w/a" }); f.read.mockResolvedValue(Buffer.from("bytes")); f.inspect.mockResolvedValue({ sha256: digest, width: 20, height: 10 }); });
describe("accepted EXACT source boundary", () => {
  it("keeps locked inputs out of model expected digests without dropping adaptive inputs", () => {
    const job = accepted(); job.studioExpectedAssetSha256 = { ...job.studioExpectedAssetSha256, b: "b".repeat(64) } as any;
    job.assetUsages.push({ mode: "ADAPTIVE", assetId: "b", order: 1 });
    expect(studioExactIntent(job).modelExpected).toEqual({ b: "b".repeat(64) });
    expect(studioExactIntent({ studioExpectedAssetSha256: { b: "b".repeat(64) } }).modelExpected).toEqual({ b: "b".repeat(64) });
  });
  it("rejects missing, mismatched or downgrading accepted snapshots before I/O", () => {
    for (const mutate of [
      (j:any) => delete j.studioExactLayout,
      (j:any) => j.studioExactLayout.layers[0].sha256 = "b".repeat(64),
      (j:any) => j.studioExactLayout.layers[0].transform.xRatio = .1,
      (j:any) => j.studioExactLayout.assetUsages[0].exactTransform.xRatio = .1,
      (j:any) => j.targets[0].width = 2048,
      (j:any) => j.assetUsages = [],
    ]) { const value = structuredClone(accepted()); mutate(value); expect(() => studioExactIntent(value)).toThrow(); }
    expect(f.asset).not.toHaveBeenCalled();
  });
  it("checks project ownership and actual source bytes before a paid provider call", async () => {
    const signal = new AbortController().signal;
    await preflightStudioExactSources("w", "p", snapshot(), signal);
    expect(f.encryption).toHaveBeenCalledOnce();
    expect(f.asset).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "a", workspaceId: "w", projectLinks: { some: { projectId: "p", project: { workspaceId: "w" } } } }) }));
    expect(f.read).toHaveBeenCalledWith({ objectKey: "w/a", imageUrl: "https://storage.invalid/w/a" }, signal);
  });
  it("rejects changed pixels or upright dimensions before model submission", async () => {
    for (const meta of [{ sha256: "b".repeat(64), width: 20, height: 10 }, { sha256: digest, width: 10, height: 20 }]) {
      f.inspect.mockResolvedValue(meta); await expect(preflightStudioExactSources("w", "p", snapshot(), new AbortController().signal)).rejects.toMatchObject({ status: 422 });
    }
  });
  it("refuses disabled/foreign images and foreign/traversal object keys", async () => {
    f.asset.mockResolvedValue(null); await expect(loadStudioExactAsset("w", "p", "a")).rejects.toMatchObject({ status: 422 });
    for (const storageKey of ["other/a", "w/../other/a", "w/a?key=1", "https://host/w/a"]) {
      f.asset.mockResolvedValue({ storageKey, url: "https://storage.invalid/w/a" });
      await expect(loadStudioExactAsset("w", "p", "a")).rejects.toMatchObject({ status: 422 });
    }
  });
  it("prevents locked bytes entering through brand references or a second asset ID", () => {
    for (const audit of [[{ assetId: "a", sha256: "b".repeat(64) }], [{ assetId: "another", sha256: digest }]]) expect(() => assertStudioExactNotModelInput(snapshot(), audit)).toThrow();
    expect(() => assertStudioExactNotModelInput(snapshot(), [{ assetId: "brand", sha256: "b".repeat(64) }])).not.toThrow();
  });
});
