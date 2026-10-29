import { describe, expect, it, vi } from "vitest";
import { createOwnedEditorApi } from "../src/components/owned-canvas/owned-editor-api";
const input = { projectId: "p", mutationId: "00000000-0000-4000-8000-000000000001", sourceShapeId: "shape:a", assetId: "a", assetSha256: "a".repeat(64), documentRevision: 3, layerCount: 4 };
const pending = { ...input, layerMode: "MANUAL", analysisStatus: "NOT_REQUESTED", analysisSummary: null, requestId: "r", sourceWidth: 100, sourceHeight: 100, status: "PENDING", error: null, createdAt: "2026-10-12T00:00:00.000Z", expiresAt: "2026-10-12T00:06:00.000Z", archiveExpiresAt: null, canRetryArchive: false, layers: [] };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const setup = (fetcher: typeof fetch) => createOwnedEditorApi("w", "p", "u", { fetcher, origin: "https://novart.test" });
const complete = (requestedLayerCount: number) => ({ ...pending, requestedLayerCount, layerCount: 2, status: "SUCCEEDED",
  layers: [0, 1].map(order => ({ order, assetId: `layer-${order}`, assetSha256: "b".repeat(64), mimeType: "image/png",
    width: 100, height: 100, sizeBytes: 100, url: `/api/workspaces/w/assets/layer-${order}/raw`,
    alphaBounds: { left: 0, top: 0, width: 100, height: 100 }, inkCoverage: .5 })) });
describe("owned decomposition API", () => {
  it("confirms a completed replay using the accepted count, not the model's output count", async () => {
    const value = complete(4), fetcher = vi.fn().mockResolvedValue(response(value, 202));
    expect(await setup(fetcher).submitDecomposition(input)).toEqual({ ...value, quality: null });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("still rejects a completed receipt for a different requested count", async () => {
    await expect(setup(vi.fn().mockResolvedValue(response(complete(5), 202))).submitDecomposition(input))
      .rejects.toMatchObject({ uncertain: true, code: "INVALID_RECEIPT" });
  });
  it("pins the requested workspace/account, source identity and immutable mutation", async () => {
    const fetcher = vi.fn().mockResolvedValue(response(pending, 202));
    expect(await setup(fetcher).submitDecomposition(input)).toEqual({ ...pending, quality: null });
    const [path, init] = fetcher.mock.calls[0]!;
    expect(path).toBe("/studio/decomposition?projectId=p&workspaceId=w");
    expect(JSON.parse(init.body)).toEqual(input); expect(new Headers(init.headers).get("X-Novart-User")).toBe("u");
  });
  it.each(["projectId", "assetId", "sourceShapeId", "mutationId"])("retains uncertain paid intent when the server receipt changes %s", async field => {
    const altered = { ...pending, [field]: field === "sourceShapeId" ? "shape:other" : field === "mutationId" ? "00000000-0000-4000-8000-000000000002" : "other" };
    await expect(setup(vi.fn().mockResolvedValue(response(altered, 202))).submitDecomposition(input)).rejects.toMatchObject({ uncertain: true, code: "INVALID_RECEIPT" });
  });
  it("does not publish pending layers or follow a foreign asset URL", async () => {
    const layer = { order: 0, assetId: "layer-a", assetSha256: "b".repeat(64), mimeType: "image/png", width: 100, height: 100, sizeBytes: 100, url: "/api/workspaces/other/assets/layer-a/raw", alphaBounds: { left: 0, top: 0, width: 100, height: 100 }, inkCoverage: 1 };
    await expect(setup(vi.fn().mockResolvedValue(response({ requests: [{ ...pending, layers: [layer] }] }))).listDecompositions()).rejects.toThrow();
  });
  it("archive retry only addresses the original task, with no source/provider intake", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ ...pending, status: "RUNNING" }, 202));
    await setup(fetcher).retryLayerArchive("r");
    expect(fetcher.mock.calls[0]![0]).toBe("/studio/decomposition/retry-archive?projectId=p&workspaceId=w");
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ projectId: "p", requestId: "r" }); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("submits AUTO without a guessed count and accepts a resolved server plan", async () => {
    const { layerCount: _unused, ...identity } = input;
    const automatic = { ...identity, layerMode: "AUTO" as const };
    const fetcher = vi.fn().mockResolvedValue(response({ ...pending, layerMode: "AUTO", layerCount: 6, analysisStatus: "SUCCEEDED", analysisSummary: "合成六层方案" }, 202));
    const result = await setup(fetcher).submitDecomposition(automatic);
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual(automatic); expect(result.layerCount).toBe(6);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("keeps the original AUTO journal when a receipt silently switches to manual", async () => {
    const { layerCount: _unused, ...identity } = input;
    await expect(setup(vi.fn().mockResolvedValue(response(pending, 202))).submitDecomposition({ ...identity, layerMode: "AUTO" })).rejects.toMatchObject({ uncertain: true, code: "INVALID_RECEIPT" });
  });
});
