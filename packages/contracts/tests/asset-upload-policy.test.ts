import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
vi.mock("../../../apps/web/src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
import { ASSET_UPLOAD_TIMEOUT_MS, detectAssetUploadMime, readAssetUploadForm, validateAssetUpload } from "../../../apps/web/src/lib/asset-upload-policy";
import { imageUploadLimitError, MAX_ASSET_UPLOAD_BODY_BYTES, MAX_ASSET_UPLOAD_BYTES, MAX_IMAGE_UPLOAD_BYTES } from "../../../apps/web/src/lib/upload-limits";

function request(file: Blob, extra?: (form: FormData) => void) {
  const form = new FormData(); form.append("category", "OTHER"); form.append("file", file, "untrusted.html"); extra?.(form);
  return new Request("http://127.0.0.1/upload", { method: "POST", body: form });
}
function streamRequest(stream: ReadableStream<Uint8Array>, headers?: Record<string, string>, signal?: AbortSignal) {
  return new Request("http://127.0.0.1/upload", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=test", ...headers }, body: stream, duplex: "half", signal } as RequestInit);
}
function psd(size = 41) {
  const bytes = Buffer.alloc(size); bytes.write("8BPS"); bytes.writeUInt16BE(1, 4); bytes.writeUInt16BE(3, 12);
  bytes.writeUInt32BE(1, 14); bytes.writeUInt32BE(1, 18); bytes.writeUInt16BE(8, 22); bytes.writeUInt16BE(3, 24);
  return bytes;
}
afterEach(() => vi.useRealTimers());

describe("legacy asset upload signatures and size policy", () => {
  it.each(["png", "jpeg", "webp", "gif"] as const)("recognizes actual %s bytes independently of a MIME or filename", async format => {
    const bytes = await sharp({ create: { width: 2, height: 3, channels: 4, background: "#8866ff" } }).toFormat(format).toBuffer();
    expect(validateAssetUpload(bytes, "payload.html")).toEqual({ mimeType: `image/${format}`, storageMimeType: `image/${format}` });
  });
  it.each([
    ['<?xml version="1.0" encoding="UTF-8"?>\n<!-- logo --><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>', "image/svg+xml"],
    ["\uFEFF <svg xmlns='http://www.w3.org/2000/svg' />", "image/svg+xml"],
    ["%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF", "application/pdf"],
    ["%PDF-2.0\r\n%%EOF", "application/pdf"],
  ])("recognizes document signature and forces public storage to attachment MIME", (text, mimeType) => {
    expect(validateAssetUpload(Buffer.from(text), "forged.png")).toEqual({ mimeType, storageMimeType: "application/octet-stream" });
  });
  it("recognizes a PSD header as a document instead of imposing the image cap", () => {
    expect(validateAssetUpload(psd(MAX_IMAGE_UPLOAD_BYTES + 1), "layered.psd")).toEqual({ mimeType: "image/vnd.adobe.photoshop", storageMimeType: "application/octet-stream" });
    expect(imageUploadLimitError({ size: MAX_ASSET_UPLOAD_BYTES, type: "image/vnd.adobe.photoshop" })).toBeNull();
    const invalid = psd(); invalid.writeUInt16BE(2, 4);
    expect(detectAssetUploadMime(invalid)).toBeNull(); // PSB is not PSD.
  });
  it.each([
    "<html><svg></svg></html>", "<!doctype html><svg/>", "<?xml version='1.0'?><!DOCTYPE svg SYSTEM 'https://invalid.test/evil'><svg/>",
    "<svg><!ENTITY x SYSTEM 'file:///secret'></svg>", "<svg></svg><script>alert(1)</script>", "<svg-not-an-image/>", "<svg", "PNG", "%PDF-9.9\n", "GIF89a", "RIFFxxxxWEBP",
  ])("refuses unsupported, wrapped, truncated or DTD content: %s", text => {
    expect(() => validateAssetUpload(Buffer.from(text), "forged.png")).toThrow(expect.objectContaining({ status: 415 }));
  });
  it("does not accept high-bit lookalikes of ASCII magic", () => {
    const fake = psd(); for (let i = 0; i < 4; i++) fake[i] |= 0x80;
    expect(detectAssetUploadMime(fake)).toBeNull();
  });
  it("keeps SVG active bytes out of the public image MIME without claiming sanitization", () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>');
    expect(validateAssetUpload(svg, "logo.svg").storageMimeType).toBe("application/octet-stream");
  });
  it("accepts document limit exactly and reports 413 above it before sniffing", () => {
    const pdf = Buffer.alloc(MAX_ASSET_UPLOAD_BYTES + 1); pdf.write("%PDF-1.7\n");
    expect(validateAssetUpload(pdf.subarray(0, MAX_ASSET_UPLOAD_BYTES), "manual.pdf").mimeType).toBe("application/pdf");
    expect(() => validateAssetUpload(pdf, "manual.pdf")).toThrow(expect.objectContaining({ status: 413 }));
    expect(imageUploadLimitError({ size: MAX_ASSET_UPLOAD_BYTES + 1, type: "application/pdf" })).toContain("50.0 MB");
  });
  it("enforces the 8 MiB image limit using detected bytes even when client calls it a PDF", async () => {
    const image = await sharp({ create: { width: 1, height: 1, channels: 4, background: "#8866ff" } }).png().toBuffer();
    const bytes = Buffer.alloc(MAX_IMAGE_UPLOAD_BYTES + 1); image.copy(bytes);
    expect(validateAssetUpload(bytes.subarray(0, MAX_IMAGE_UPLOAD_BYTES), "forged.pdf").mimeType).toBe("image/png");
    expect(() => validateAssetUpload(bytes, "forged.pdf")).toThrow(expect.objectContaining({ status: 413 }));
  });
});

describe("bounded legacy multipart intake", () => {
  it("parses only one file and known scalar fields", async () => {
    const form = await readAssetUploadForm(request(new Blob(["%PDF-1.7\n"], { type: "text/html" }), f => { f.append("libraryKind", "MATERIAL"); f.append("folderId", "folder"); }));
    expect(form.get("category")).toBe("OTHER"); expect(form.get("file")).toBeInstanceOf(File);
    expect(await (form.get("file") as File).text()).toBe("%PDF-1.7\n");
  });
  it.each([
    (form: FormData) => form.append("file", new Blob(["extra"]), "extra.png"),
    (form: FormData) => form.append("category", "LOGO"),
    (form: FormData) => form.append("workspaceId", "foreign"),
    (form: FormData) => form.append("folderId", new Blob(["not a string"]), "folder"),
  ])("rejects ambiguous or unexpected fields", async mutate => {
    await expect(readAssetUploadForm(request(new Blob(["x"]), mutate))).rejects.toMatchObject({ status: 422 });
  });
  it.each([undefined, "1"])("bounds actual chunked bytes with Content-Length %s and cancels", async contentLength => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } });
    await expect(readAssetUploadForm(streamRequest(stream, contentLength ? { "content-length": contentLength } : undefined))).rejects.toMatchObject({ status: 413 });
    expect(cancelled).toBe(true);
  });
  it("rejects declared oversize before consuming the body", async () => {
    const req = request(new Blob(["x"])); req.headers.set("content-length", String(MAX_ASSET_UPLOAD_BODY_BYTES + 1));
    await expect(readAssetUploadForm(req)).rejects.toMatchObject({ status: 413 }); expect(req.bodyUsed).toBe(false);
  });
  it("returns controlled errors for wrong content type and broken multipart", async () => {
    await expect(readAssetUploadForm(new Request("http://127.0.0.1/upload", { method: "POST", body: "html" }))).rejects.toMatchObject({ status: 415 });
    await expect(readAssetUploadForm(new Request("http://127.0.0.1/upload", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=test" }, body: "broken" }))).rejects.toMatchObject({ status: 400 });
  });
  it("times out a stalled stream even when cancel never settles", async () => {
    vi.useFakeTimers(); let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; return new Promise<void>(() => undefined); } });
    const result = expect(readAssetUploadForm(streamRequest(stream))).rejects.toMatchObject({ status: 408 });
    await vi.advanceTimersByTimeAsync(ASSET_UPLOAD_TIMEOUT_MS); await result; expect(cancelled).toBe(true);
  });
  it("cancels on disconnect without waiting for the full deadline", async () => {
    let cancelled = false; const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const result = expect(readAssetUploadForm(streamRequest(stream, {}, controller.signal))).rejects.toMatchObject({ status: 408 });
    controller.abort(); await result; expect(cancelled).toBe(true);
  });
});
