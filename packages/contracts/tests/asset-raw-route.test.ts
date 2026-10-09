import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ user: vi.fn(), member: vi.fn(), asset: vi.fn(), object: vi.fn(), remote: vi.fn() }));
vi.mock("../../db/src/index", () => ({ prisma: { asset: { findUnique: f.asset } } }));
vi.mock("@/lib/api", () => ({
  ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } },
  requireUser: f.user,
  handleError: (error: { status?: number }) => Response.json({ error: "Request failed" }, { status: error.status ?? 500 }),
}));
vi.mock("@/lib/workspace", () => ({ requireOwnedWorkspace: f.member }));
vi.mock("@/lib/ssrf", () => ({ safeFetch: f.remote }));
vi.mock("@/lib/s3", () => ({ getObjectStream: f.object }));
vi.mock("@/lib/settings", () => ({ getEffectiveStorage: vi.fn() }));
vi.mock("@/lib/queue", () => ({ enqueueImagePreview: vi.fn() }));
vi.mock("@/lib/image-preview", () => ({ parseImagePreviewWidth: () => null }));
import { GET } from "../../../apps/web/src/app/api/workspaces/[wsId]/assets/[assetId]/raw/route";

const params = { params: Promise.resolve({ wsId: "brand-a", assetId: "image-a" }) };
const request = () => new Request("http://127.0.0.1/api/workspaces/brand-a/assets/image-a/raw");
const asset = { id: "image-a", workspaceId: "brand-a", storageKey: "uploads/brand-a/photo.png",
  url: "http://private-storage.invalid/bucket/uploads/brand-a/photo.png", mimeType: "image/png" };
beforeEach(() => {
  vi.resetAllMocks();
  f.user.mockResolvedValue({ id: "member-a" });
  f.member.mockResolvedValue({ id: "brand-a" });
  f.asset.mockResolvedValue(asset);
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
