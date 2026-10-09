import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { StudioMaterialUploadInput, StudioMaterialUploadQuery, StudioMaterialUploadView, STUDIO_MATERIAL_MAX_BYTES } from "../src/studio-materials";
vi.mock("../../../apps/web/src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
import { readStudioMaterialForm, assertStudioUploadCapacity, STUDIO_UPLOAD_WORKSPACE_BYTES, STUDIO_UPLOAD_GLOBAL_BYTES } from "../../../apps/web/src/lib/studio-materials-policy";
import { inspectStudioMaterialImage } from "../../../apps/web/src/lib/studio-materials-image";

const mutationId = "831a0280-2cf1-41ba-ac94-621053c4a4c6";
const material = { id: "asset", assetId: "asset", assetSha256: "a".repeat(64), fileName: "image.png", mimeType: "image/png", sizeBytes: 123, width: 2, height: 3, url: "/api/workspaces/w/assets/asset/raw", kind: "image" };
const receipt = { taskId: "task", projectId: "project", mutationId, status: "PENDING", progress: 0, expiresAt: "2026-10-09T00:06:00.000Z" };
function request(file: Blob, extra?: (form: FormData) => void) { const form = new FormData(); form.append("projectId", "project"); form.append("mutationId", mutationId); form.append("file", file, "photo.png"); extra?.(form); return new Request("http://127.0.0.1/studio/material-upload", { method: "POST", body: form }); }

describe("studio material wire contracts", () => {
  it("keeps server identity outside the client form and rejects null IDs", () => {
    expect(StudioMaterialUploadInput.parse({ projectId: "p", mutationId })).toEqual({ projectId: "p", mutationId });
    for (const input of [{ projectId: "p", mutationId, userId: "other" }, { projectId: "p", mutationId, objectKey: "foreign" }, { projectId: "p", mutationId: "same" }]) expect(StudioMaterialUploadInput.safeParse(input).success).toBe(false);
    expect(StudioMaterialUploadQuery.safeParse({ projectId: "p", taskId: null }).success).toBe(false);
  });
  it("never presents pending or failed uploads as persistent materials", () => {
    expect(StudioMaterialUploadView.safeParse(receipt).success).toBe(true);
    expect(StudioMaterialUploadView.safeParse({ ...receipt, material }).success).toBe(false);
    expect(StudioMaterialUploadView.safeParse({ ...receipt, status: "SUCCEEDED" }).success).toBe(false);
    expect(StudioMaterialUploadView.safeParse({ ...receipt, status: "SUCCEEDED", material }).success).toBe(true);
    expect(StudioMaterialUploadView.safeParse({ ...receipt, status: "FAILED" }).success).toBe(false);
    expect(StudioMaterialUploadView.safeParse({ ...receipt, status: "FAILED", error: "Upload expired" }).success).toBe(true);
    for (const url of ["blob:temp", "data:image/png;base64,a", "https://object.invalid/a", "/api/workspaces/w/assets/asset/raw\n"]) expect(StudioMaterialUploadView.safeParse({ ...receipt, status: "SUCCEEDED", material: { ...material, url } }).success).toBe(false);
  });
});

describe("bounded image intake", () => {
  it("hashes actual multipart bytes and ignores filename as a storage path", async () => {
    const result = await readStudioMaterialForm(request(new Blob(["image bytes"], { type: "image/png" })));
    expect(result.body.toString()).toBe("image bytes"); expect(result.sha256).toHaveLength(64); expect(result.projectId).toBe("project");
  });
  it("rejects extra fields, duplicate fields, zero bytes and active image types", async () => {
    const image = new Blob(["x"], { type: "image/png" });
    await expect(readStudioMaterialForm(request(image, f => f.append("userId", "victim")))).rejects.toMatchObject({ status: 422 });
    await expect(readStudioMaterialForm(request(image, f => f.append("projectId", "other")))).rejects.toMatchObject({ status: 422 });
    await expect(readStudioMaterialForm(request(new Blob([], { type: "image/png" })))).rejects.toMatchObject({ status: 400 });
    await expect(readStudioMaterialForm(request(new Blob(["<svg/>"], { type: "image/svg+xml" })))).rejects.toMatchObject({ status: 415 });
  });
  it("limits chunked actual bytes even without Content-Length and cancels the stream", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } });
    const req = new Request("http://127.0.0.1/upload", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=test" }, body: stream, duplex: "half" } as RequestInit);
    await expect(readStudioMaterialForm(req)).rejects.toMatchObject({ status: 413 }); expect(cancelled).toBe(true);
  });
  it("rejects a misleading huge Content-Length before reading and bounds outbox capacity", async () => {
    const req = request(new Blob(["x"], { type: "image/png" })); req.headers.set("content-length", String(STUDIO_MATERIAL_MAX_BYTES + 100000));
    await expect(readStudioMaterialForm(req)).rejects.toMatchObject({ status: 413 });
    expect(() => assertStudioUploadCapacity(STUDIO_UPLOAD_WORKSPACE_BYTES - 1, 1, 1)).not.toThrow();
    expect(() => assertStudioUploadCapacity(STUDIO_UPLOAD_WORKSPACE_BYTES, 1, 1)).toThrow();
    expect(() => assertStudioUploadCapacity(0, STUDIO_UPLOAD_GLOBAL_BYTES, 1)).toThrow();
  });
  it("fully decodes server-side dimensions and refuses forged/truncated images", async () => {
    const bytes = await sharp({ create: { width: 7, height: 11, channels: 4, background: "#8866ff" } }).png().toBuffer();
    expect(await inspectStudioMaterialImage(bytes, "image/png")).toEqual({ width: 7, height: 11 });
    await expect(inspectStudioMaterialImage(bytes, "image/jpeg")).rejects.toMatchObject({ status: 422 });
    await expect(inspectStudioMaterialImage(Buffer.from("not an image"), "image/png")).rejects.toMatchObject({ status: 422 });
    await expect(inspectStudioMaterialImage(bytes.subarray(0, 40), "image/png")).rejects.toMatchObject({ status: 422 });
  });
});
