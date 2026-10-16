import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  user: vi.fn(), member: vi.fn(), asset: vi.fn(), object: vi.fn(), remote: vi.fn(),
  layer: vi.fn(), preview: vi.fn(), enqueuePreview: vi.fn(),
}));
vi.mock("../../../packages/db/src/index", () => ({ prisma: { asset: { findUnique: f.asset } } }));
vi.mock("@/lib/api", () => ({
  ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } },
  requireUser: f.user,
  handleError: (error: { status?: number }) => Response.json({ error: "Request failed" }, { status: error.status ?? 500 }),
}));
vi.mock("@/lib/workspace", () => ({ requireOwnedWorkspace: f.member }));
vi.mock("@/lib/ssrf", () => ({ safeFetch: f.remote }));
vi.mock("@/lib/s3", () => ({ getObjectStream: f.object }));
vi.mock("@/lib/settings", () => ({ getEffectiveStorage: vi.fn() }));
vi.mock("@/lib/queue", () => ({ enqueueImagePreview: f.enqueuePreview }));
vi.mock("@/lib/image-preview", () => ({ parseImagePreviewWidth: f.preview }));
vi.mock("@/lib/studio-decomposition", () => ({ readStudioLayerAsset: f.layer }));
import { GET } from "../src/app/api/workspaces/[wsId]/assets/[assetId]/raw/route";

const params = { params: Promise.resolve({ wsId: "brand-a", assetId: "image-a" }) };
const request = () => new Request("http://127.0.0.1/api/workspaces/brand-a/assets/image-a/raw");
const asset = { id: "image-a", workspaceId: "brand-a", storageKey: "uploads/brand-a/photo.png",
  url: "http://private-storage.invalid/bucket/uploads/brand-a/photo.png", mimeType: "image/png" };
beforeEach(() => {
  vi.resetAllMocks();
  f.user.mockResolvedValue({ id: "member-a" });
  f.member.mockResolvedValue({ id: "brand-a" });
  f.asset.mockResolvedValue(asset);
  f.preview.mockReturnValue(null);
  f.object.mockImplementation(async () => ({ body: Readable.from([Buffer.from("stored-image-bytes")]), contentType: "image/png", contentLength: 18 }));
  f.remote.mockImplementation(async () => new Response("remote-image-bytes", { headers: { "content-type": "image/png" } }));
});

describe("authenticated asset raw source selection", () => {
  it("reads the stored object despite a private or obsolete presentation URL", async () => {
    const response = await GET(request(), params);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("stored-image-bytes");
    expect(f.object).toHaveBeenCalledWith(asset.storageKey, expect.any(AbortSignal));
    expect(f.remote).not.toHaveBeenCalled();
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("private");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("keeps URL-backed legacy sources behind the SSRF-checked fetcher", async () => {
    f.asset.mockResolvedValue({ ...asset, storageKey: "https://source.invalid/original.png", url: "https://old.invalid/other.png" });
    const response = await GET(request(), params);
    expect(await response.text()).toBe("remote-image-bytes");
    expect(f.remote).toHaveBeenCalledWith("https://source.invalid/original.png");
    expect(f.object).not.toHaveBeenCalled();
  });

  it("allows a legacy URL-only row without treating missing sources as object keys", async () => {
    f.asset.mockResolvedValue({ ...asset, storageKey: "", url: "https://source.invalid/original.png" });
    expect((await GET(request(), params)).status).toBe(200);
    expect(f.remote).toHaveBeenCalledWith("https://source.invalid/original.png");
    f.asset.mockResolvedValue({ ...asset, storageKey: "", url: "" });
    expect((await GET(request(), params)).status).toBe(404);
    expect(f.object).not.toHaveBeenCalled();
  });

  it("checks membership and asset ownership before any source read", async () => {
    f.member.mockRejectedValueOnce({ status: 404 });
    expect((await GET(request(), params)).status).toBe(404);
    expect(f.asset).not.toHaveBeenCalled();
    f.asset.mockResolvedValue({ ...asset, workspaceId: "other-brand" });
    expect((await GET(request(), params)).status).toBe(404);
    expect(f.remote).not.toHaveBeenCalled(); expect(f.object).not.toHaveBeenCalled();
    expect(f.layer).not.toHaveBeenCalled();
    expect(f.member).toHaveBeenCalledWith("brand-a", "member-a");
  });

  it("preserves attachment handling for active content in stored objects", async () => {
    f.asset.mockResolvedValue({ ...asset, mimeType: "image/svg+xml" });
    const response = await GET(request(), params);
    expect(response.headers.get("content-disposition")).toBe("attachment");
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("does not fall back to the public URL when the authoritative object read fails", async () => {
    f.object.mockRejectedValue(new Error("object unavailable"));
    expect((await GET(request(), params)).status).toBe(500);
    expect(f.remote).not.toHaveBeenCalled();
  });
});

// This route fixture mocks decryption; cryptography and task ownership are
// covered by studio-decomposition-service.test.ts. Here the guard is that only
// an authorized asset reaches that reader, and failures never expose ciphertext.
describe("encrypted Studio layer raw access", () => {
  const layerAsset = {
    ...asset,
    storageKey: "brand-a/studio-layer-assets/project-a/request-a/archive-a/0.bin",
    previewStorageKey: "previews/brand-a/layer.webp",
    mimeType: "application/octet-stream",
  };
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const noGenericRead = () => {
    expect(f.object).not.toHaveBeenCalled();
    expect(f.remote).not.toHaveBeenCalled();
    expect(f.preview).not.toHaveBeenCalled();
    expect(f.enqueuePreview).not.toHaveBeenCalled();
  };
  beforeEach(() => {
    f.asset.mockResolvedValue(layerAsset);
    f.layer.mockResolvedValue(png);
  });

  it("serves only the authorized decrypted bytes, even when a preview is requested", async () => {
    const response = await GET(new Request(`${request().url}?w=320`), params);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
    expect(f.member).toHaveBeenCalledWith("brand-a", "member-a");
    expect(f.asset).toHaveBeenCalledWith({ where: { id: "image-a" } });
    expect(f.layer).toHaveBeenCalledTimes(1);
    expect(f.layer).toHaveBeenCalledWith("brand-a", layerAsset, expect.any(AbortSignal));
    expect(f.member.mock.invocationCallOrder[0]).toBeLessThan(f.asset.mock.invocationCallOrder[0]!);
    expect(f.asset.mock.invocationCallOrder[0]).toBeLessThan(f.layer.mock.invocationCallOrder[0]!);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-length")).toBe(String(png.length));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    noGenericRead();
  });

  it("rejects an unauthenticated request before membership, asset or layer reads", async () => {
    f.user.mockRejectedValueOnce({ status: 401 });
    expect((await GET(request(), params)).status).toBe(401);
    expect(f.member).not.toHaveBeenCalled();
    expect(f.asset).not.toHaveBeenCalled();
    expect(f.layer).not.toHaveBeenCalled();
    noGenericRead();
  });

  it("rejects a nonmember before looking up or decrypting a layer", async () => {
    f.member.mockRejectedValueOnce({ status: 404 });
    expect((await GET(request(), params)).status).toBe(404);
    expect(f.asset).not.toHaveBeenCalled();
    expect(f.layer).not.toHaveBeenCalled();
    noGenericRead();
  });

  it.each([
    ["missing asset", null],
    ["asset from another workspace", { ...layerAsset, workspaceId: "other-brand" }],
  ])("rejects %s before decrypting, regardless of a matching storage prefix", async (_name, row) => {
    f.asset.mockResolvedValueOnce(row);
    expect((await GET(request(), params)).status).toBe(404);
    expect(f.layer).not.toHaveBeenCalled();
    noGenericRead();
  });

  it.each([
    [404, "layer is not published by this task"],
    [422, "layer integrity check failed"],
    [500, "encrypted object unavailable"],
  ])("preserves layer reader failure %s without a raw-object, URL or preview fallback", async (status, message) => {
    f.layer.mockRejectedValueOnce({ status, message });
    const response = await GET(request(), params);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: "Request failed" });
    expect(f.layer).toHaveBeenCalledTimes(1);
    expect(f.layer).toHaveBeenCalledWith("brand-a", layerAsset, expect.any(AbortSignal));
    noGenericRead();
  });
});
