import { afterEach, describe, expect, it, vi } from "vitest";
import { createOwnedEditorApi } from "../../../apps/web/src/components/owned-canvas/owned-editor-api";

const workspaceId = "psd-workspace", projectId = "psd-project", requestId = "psd-generation";
const image = { assetId: "psd-original", assetSha256: "a".repeat(64), width: 12, height: 8, url: `/api/workspaces/${workspaceId}/assets/psd-original/raw` };
const decomposition = { projectId, requestId: "psd-decomposition", mutationId: "94f32517-d416-46ea-b8a0-401fe8d4ed65", sourceShapeId: "shape:generated-fixture", documentRevision: 0,
  assetId: image.assetId, assetSha256: image.assetSha256, sourceWidth: 12, sourceHeight: 8, layerCount: 2, status: "SUCCEEDED", error: null, createdAt: "2026-10-13T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z", archiveExpiresAt: null, canRetryArchive: false,
  layers: [0, 1].map(order => ({ order, assetId: "psd-layer-" + order, assetSha256: String(order + 1).repeat(64), mimeType: "image/png", width: 12, height: 8, sizeBytes: 48, url: `/api/workspaces/${workspaceId}/assets/psd-layer-${order}/raw`, alphaBounds: { left: 0, top: 0, width: 12, height: 8 }, inkCoverage: 0.5 })) };
const downloadUrl = `/api/workspaces/${workspaceId}/studio/decomposition/${decomposition.requestId}/export?projectId=${projectId}&format=psd`;
const receipt = { projectId, requestId, requested: true, status: "READY", error: null, decomposition, downloadUrl };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const setup = (fetcher: typeof fetch, signal?: AbortSignal) => createOwnedEditorApi(workspaceId, projectId, "psd-user", { origin: "https://novart.test", fetcher, signal });
function psdHeader() {
  const bytes = new Uint8Array(30), view = new DataView(bytes.buffer); bytes.set(new TextEncoder().encode("8BPS"));
  view.setUint16(4, 1); view.setUint16(12, 4); view.setUint32(14, 8); view.setUint32(18, 12); view.setUint16(22, 8); view.setUint16(24, 3); return bytes;
}
const input = { projectId, mutationId: "94f32517-d416-46ea-b8a0-401fe8d4ed65", prompt: "fixture only", sizeSelection: { ratioKey: "1:1" as const, resolutionTier: "1K" as const }, workflowRevision: 0, documentRevision: 0, psdLayerCount: 2 };
const generation = { mode: "generate", requestId, projectId, generationId: "psd-g", mutationId: input.mutationId, status: "SUCCEEDED", progress: null, expiresAt: "2099-01-01T00:00:00.000Z", archiveExpiresAt: null, archiveProcessingExpiresAt: null,
  displayText: "fixture only", resultState: "READY", results: [{ ...image, versionId: "psd-version", mimeType: "image/png" }], error: null, archiveError: null, canRetryArchive: false, psdLayerCount: 2 };
afterEach(() => vi.useRealTimers());

describe("owned automatic PSD client", () => {
  it("reads only current project server status with no generation or decomposition POST", async () => {
    const fetcher = vi.fn().mockResolvedValue(response(receipt)); const value = await setup(fetcher).getGeneratedPsd(requestId);
    expect(value.downloadUrl).toBe(downloadUrl); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(`/api/workspaces/${workspaceId}/studio/generated-psd?projectId=${projectId}&requestId=${requestId}&workspaceId=${workspaceId}`);
    expect(fetcher.mock.calls[0]?.[1].method).toBeUndefined();
  });
  it.each([
    { ...receipt, projectId: "other" }, { ...receipt, requestId: "other" },
    { ...receipt, downloadUrl: downloadUrl.replace(workspaceId, "other") },
    { ...receipt, downloadUrl: downloadUrl.replace(projectId, "other") },
    { ...receipt, downloadUrl: "https://foreign.test/file.psd" },
    { ...receipt, downloadUrl: downloadUrl + "&projectId=other" },
    { ...receipt, downloadUrl: downloadUrl.replace("psd-decomposition", "other") },
    { ...receipt, decomposition: { ...decomposition, projectId: "other" } },
    { ...receipt, decomposition: { ...decomposition, layers: decomposition.layers.map(layer => ({ ...layer, url: layer.url.replace(workspaceId, "other") })) } },
  ])("rejects foreign or inconsistent PSD scopes", async value => {
    await expect(setup(vi.fn().mockResolvedValue(response(value))).getGeneratedPsd(requestId)).rejects.toThrow();
  });
  it("keeps PSD failure separate from the already persisted generation image", async () => {
    const value = await setup(vi.fn().mockResolvedValue(response({ projectId, requestId, requested: true, status: "FAILED", error: "Layer model unavailable", decomposition: null, downloadUrl: null }))).getGeneratedPsd(requestId);
    expect(value.status).toBe("FAILED"); expect(generation.results).toHaveLength(1);
  });
  it.each([null, 4])("preserves uncertainty when accepted generation PSD choice differs: %s", async psdLayerCount => {
    await expect(setup(vi.fn().mockResolvedValue(response({ ...generation, psdLayerCount }, 202))).submitGeneration(input)).rejects.toMatchObject({ code: "INVALID_RECEIPT", uncertain: true });
  });
  it("submits chosen count once and accepts exactly matching immutable receipt", async () => {
    const fetcher = vi.fn().mockResolvedValue(response(generation, 202)); await setup(fetcher).submitGeneration(input);
    expect(JSON.parse(fetcher.mock.calls[0]?.[1].body)).toEqual(input); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("validates the binary before returning a downloadable PSD", async () => {
    const bytes = psdHeader(), fetcher = vi.fn().mockResolvedValue(new Response(bytes, { headers: { "content-type": "image/vnd.adobe.photoshop", "content-length": String(bytes.length) } }));
    const value = await setup(fetcher).downloadPsd(decomposition as never);
    expect(value.fileName).toBe("novart-psd-decomposition.psd"); expect(value.blob.size).toBe(30);
    expect(fetcher.mock.calls[0]?.[0]).toBe(downloadUrl + "&workspaceId=" + workspaceId);
  });
  it("does not download a JSON rejection as PSD", async () => {
    await expect(setup(vi.fn().mockResolvedValue(response({ error: "Not allowed" }, 403))).downloadPsd(decomposition as never)).rejects.toMatchObject({ status: 403 });
    await expect(setup(vi.fn().mockResolvedValue(response({ error: "Wrong content" }))).downloadPsd(decomposition as never)).rejects.toMatchObject({ status: 422 });
  });
  it.each(["signature", "version", "size", "depth", "mode", "truncated", "oversized"]) ("rejects malformed or over-budget binary: %s", async kind => {
    const bytes = psdHeader(), view = new DataView(bytes.buffer);
    if (kind === "signature") bytes[0] = 0; if (kind === "version") view.setUint16(4, 2);
    if (kind === "size") view.setUint32(18, 100); if (kind === "depth") view.setUint16(22, 16); if (kind === "mode") view.setUint16(24, 1);
    const fetcher = vi.fn().mockResolvedValue(new Response(bytes, { headers: { "content-type": "image/vnd.adobe.photoshop", "content-length": kind === "oversized" ? String(97 * 1024 * 1024) : kind === "truncated" ? "31" : "30" } }));
    await expect(setup(fetcher).downloadPsd(decomposition as never)).rejects.toMatchObject({ status: 422 });
  });
  it("keeps the bounded download deadline connected after headers", async () => {
    vi.useFakeTimers(); let aborted = false;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(new ReadableStream({ start(controller) { init?.signal?.addEventListener("abort", () => { aborted = true; controller.error(new DOMException("Abort", "AbortError")); }); } }), { headers: { "content-type": "image/vnd.adobe.photoshop" } }));
    const result = setup(fetcher).downloadPsd(decomposition as never), assertion = expect(result).rejects.toMatchObject({ status: null });
    await vi.advanceTimersByTimeAsync(60001); await assertion; expect(aborted).toBe(true);
  });
});
