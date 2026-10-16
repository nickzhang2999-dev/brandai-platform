import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
const f = vi.hoisted(() => ({ user: vi.fn(), role: vi.fn(), owned: vi.fn(), create: vi.fn(), folder: vi.fn(), asset: vi.fn(), upload: vi.fn(), read: vi.fn(),
  ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } },
}));
vi.mock("../../db/src/index", () => ({ prisma: { asset: { create: f.create, findUnique: f.asset }, assetFolder: { findUnique: f.folder } } }));
vi.mock("@/lib/api", () => ({ ApiException: f.ApiException, requireUser: f.user,
  ok: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  handleError: (error: Error & { status?: number }) => Response.json({ error: error.message }, { status: error.status ?? 500 }),
}));
vi.mock("../../../apps/web/src/lib/api", () => ({ ApiException: f.ApiException }));
vi.mock("@/lib/workspace", () => ({ requireWorkspaceRole: f.role, requireOwnedWorkspace: f.owned }));
vi.mock("@/lib/s3", () => ({ uploadBuffer: f.upload, getObjectStream: f.read }));
vi.mock("@/lib/assets", () => ({ serializeAsset: (asset: unknown) => asset, decodeImageResolution: () => undefined }));
vi.mock("@/lib/asset-upload-policy", () => import("../../../apps/web/src/lib/asset-upload-policy"));
vi.mock("@/lib/settings", () => ({ getEffectiveStorage: vi.fn() }));
vi.mock("@/lib/ssrf", () => ({ safeFetch: vi.fn() }));
vi.mock("@/lib/queue", () => ({ enqueueImagePreview: vi.fn() }));
vi.mock("@/lib/studio-decomposition", () => ({ readStudioLayerAsset: vi.fn() }));
vi.mock("@/lib/image-preview", () => ({ IMAGE_PREVIEW_WIDTH: 512, parseImagePreviewWidth: () => null, imagePreviewEtag: vi.fn(), imagePreviewHeaders: vi.fn(), nodeStreamToBuffer: vi.fn() }));
import { POST } from "../../../apps/web/src/app/api/workspaces/[wsId]/assets/upload/route";
import { GET } from "../../../apps/web/src/app/api/workspaces/[wsId]/assets/[assetId]/raw/route";

const params = Promise.resolve({ wsId: "workspace-a", assetId: "asset-a" });
function request(body: Buffer | string, type = "image/png", extra?: (form: FormData) => void) {
  const form = new FormData(); form.append("file", new Blob([typeof body === "string" ? body : new Uint8Array(body)], { type }), "untrusted.png");
  form.append("category", "OTHER"); extra?.(form);
  return new Request("http://127.0.0.1/upload", { method: "POST", body: form });
}
beforeEach(() => {
  vi.resetAllMocks(); f.user.mockResolvedValue({ id: "user-a" }); f.role.mockResolvedValue({}); f.owned.mockResolvedValue({});
  f.upload.mockResolvedValue({ key: "workspace-a/object", url: "https://storage.invalid/object" });
  f.create.mockImplementation(({ data }: { data: object }) => ({ id: "asset-a", ...data }));
  f.read.mockImplementation(() => Promise.resolve({ body: Readable.from(Buffer.from("document bytes")), contentType: "application/octet-stream", contentLength: 14 }));
});

describe("asset upload route content policy and authorization", () => {
  it("stores server-detected PNG MIME instead of forged client HTML MIME", async () => {
    const body = await sharp({ create: { width: 1, height: 1, channels: 4, background: "white" } }).png().toBuffer();
    const response = await POST(request(body, "text/html"), { params });
    expect(response.status).toBe(201); expect(await response.json()).toMatchObject({ mimeType: "image/png", workspaceId: "workspace-a" });
    expect(f.role).toHaveBeenCalledWith("workspace-a", "user-a", "EDITOR");
    expect(f.upload).toHaveBeenCalledWith(body, "image/png", "workspace-a");
  });
  it.each([["<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", "image/svg+xml"], ["%PDF-1.7\n%%EOF", "application/pdf"]])("keeps document MIME for library operations but forces object storage to octet-stream", async (body, mime) => {
    const response = await POST(request(body), { params });
    expect(response.status).toBe(201); expect(await response.json()).toMatchObject({ mimeType: mime });
    expect(f.upload).toHaveBeenCalledWith(Buffer.from(body), "application/octet-stream", "workspace-a");
  });
  it("refuses HTML disguised as PNG before any storage/database mutation", async () => {
    const response = await POST(request("<html><script>alert(1)</script></html>"), { params });
    expect(response.status).toBe(415); expect(f.upload).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled();
  });
  it("refuses an actual oversized image despite a forged document MIME", async () => {
    const image = await sharp({ create: { width: 1, height: 1, channels: 4, background: "white" } }).png().toBuffer();
    const body = Buffer.alloc(8 * 1024 * 1024 + 1); image.copy(body);
    const response = await POST(request(body, "application/pdf"), { params });
    expect(response.status).toBe(413); expect(f.upload).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled();
  });
  it("retains folder ownership validation before storage/database writes", async () => {
    f.folder.mockResolvedValue({ workspaceId: "workspace-b" });
    const response = await POST(request("%PDF-1.7\n%%EOF", "application/pdf", form => form.append("folderId", "foreign-folder")), { params });
    expect(response.status).toBe(404); expect(f.upload).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled();
  });
  it("does not consume unauthenticated or viewer upload bodies", async () => {
    f.role.mockRejectedValue(new f.ApiException(403, "Forbidden")); const req = request("data");
    const response = await POST(req, { params }); expect(response.status).toBe(403); expect(req.bodyUsed).toBe(false); expect(f.upload).not.toHaveBeenCalled();
  });
});

describe("asset raw document download headers", () => {
  it.each(["image/svg+xml", "application/pdf", "image/vnd.adobe.photoshop", "image/x-photoshop"])("serves %s as an attachment with nosniff", async mimeType => {
    f.asset.mockResolvedValue({ id: "asset-a", workspaceId: "workspace-a", storageKey: "workspace-a/file", url: "https://storage.invalid/file", mimeType });
    const response = await GET(new Request("http://127.0.0.1/raw"), { params });
    expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toBe("attachment"); expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("document bytes");
  });
  it("keeps PNG inline and refuses a foreign workspace asset", async () => {
    f.asset.mockResolvedValue({ id: "asset-a", workspaceId: "workspace-a", storageKey: "workspace-a/file", url: "https://storage.invalid/file", mimeType: "image/png" });
    const response = await GET(new Request("http://127.0.0.1/raw"), { params });
    expect(response.headers.get("content-type")).toBe("image/png"); expect(response.headers.has("content-disposition")).toBe(false); await response.text();
    f.asset.mockResolvedValue({ workspaceId: "workspace-b" }); f.read.mockClear();
    expect((await GET(new Request("http://127.0.0.1/raw"), { params })).status).toBe(404); expect(f.read).not.toHaveBeenCalled();
  });
});
