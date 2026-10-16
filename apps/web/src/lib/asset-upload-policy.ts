import { ApiException } from "./api";
import { imageUploadLimitError, MAX_ASSET_UPLOAD_BODY_BYTES, MAX_ASSET_UPLOAD_BYTES } from "./upload-limits";

export const ASSET_UPLOAD_TIMEOUT_MS = 30_000;

/** Bound bytes before multipart parsing, including absent or dishonest lengths. */
export async function readAssetUploadForm(req: Request): Promise<FormData> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;/i.test(contentType)) throw new ApiException(415, "请使用文件上传表单。");
  const length = req.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_ASSET_UPLOAD_BODY_BYTES))
    throw new ApiException(413, "上传请求不能超过 50 MiB（另含有限表单头）。");
  if (!req.body) throw new ApiException(400, "缺少文件。");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ApiException(408, "上传超时，请重新选择文件。")), ASSET_UPLOAD_TIMEOUT_MS);
    abort = () => reject(new ApiException(408, "上传已中断，请重新选择文件。"));
    req.signal.addEventListener("abort", abort, { once: true });
    if (req.signal.aborted) abort();
  });
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), interrupted]);
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_ASSET_UPLOAD_BODY_BYTES) throw new ApiException(413, "上传文件不能超过 50 MiB。");
      chunks.push(chunk.value);
    }
    const body = Buffer.concat(chunks, total);
    chunks.length = 0;
    let form: FormData;
    try {
      form = await Promise.race([new Response(body, { headers: { "content-type": contentType } }).formData(), interrupted]);
    } catch (error) {
      if (error instanceof ApiException) throw error;
      throw new ApiException(400, "无法读取文件上传表单。");
    }
    const allowed = new Set(["file", "category", "libraryKind", "folderId"]);
    for (const key of form.keys()) {
      if (!allowed.has(key) || form.getAll(key).length !== 1) throw new ApiException(422, "上传表单字段无效。");
      if (key !== "file" && typeof form.get(key) !== "string") throw new ApiException(422, "上传表单字段无效。");
    }
    return form;
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) req.signal.removeEventListener("abort", abort);
    // A hostile/failed underlying stream may never settle cancel(). Do not
    // turn the timeout itself into another unbounded await.
    void reader.cancel().catch(() => undefined);
  }
}

/** File signatures, never filename or client Content-Type, select the format. */
export function detectAssetUploadMime(body: Buffer): string | null {
  if (body.length >= 24 && body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && body.readUInt32BE(8) === 13 && body.toString("latin1", 12, 16) === "IHDR"
    && body.readUInt32BE(16) > 0 && body.readUInt32BE(20) > 0) return "image/png";
  if (body.length >= 4 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff && body[3] !== 0 && body[3] !== 0xff) return "image/jpeg";
  if (body.length >= 16 && body.toString("latin1", 0, 4) === "RIFF" && body.readUInt32LE(4) + 8 === body.length
    && body.toString("latin1", 8, 12) === "WEBP" && ["VP8 ", "VP8L", "VP8X"].includes(body.toString("latin1", 12, 16))) return "image/webp";
  if (body.length >= 13 && ["GIF87a", "GIF89a"].includes(body.toString("latin1", 0, 6))
    && body.readUInt16LE(6) > 0 && body.readUInt16LE(8) > 0) return "image/gif";
  if (/^%PDF-(?:1\.[0-7]|2\.0)(?:\r|\n|\s)/.test(body.toString("latin1", 0, 12))) return "application/pdf";
  if (body.length >= 26 && body.toString("latin1", 0, 4) === "8BPS" && body.readUInt16BE(4) === 1
    && body.subarray(6, 12).every(value => value === 0) && body.readUInt16BE(12) >= 1 && body.readUInt16BE(12) <= 56
    && body.readUInt32BE(14) >= 1 && body.readUInt32BE(14) <= 30000 && body.readUInt32BE(18) >= 1 && body.readUInt32BE(18) <= 30000
    && [1, 8, 16, 32].includes(body.readUInt16BE(22)) && [0, 1, 2, 3, 4, 7, 8, 9].includes(body.readUInt16BE(24))) return "image/vnd.adobe.photoshop";
  // SVG has no binary magic. Recognize an XML SVG root, not an SVG substring
  // hidden in HTML. This is not sanitization: SVG uses octet-stream in object
  // storage, while the authenticated raw route enforces attachment + nosniff.
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(body); } catch { return null; }
  text = text.replace(/^\uFEFF/, "").trimStart();
  if (text.startsWith("<?xml")) text = text.replace(/^<\?xml\s[^?]*\?>\s*/, "");
  while (text.startsWith("<!--")) {
    const end = text.indexOf("-->");
    if (end < 0) return null;
    text = text.slice(end + 3).trimStart();
  }
  // DTD/entity processing is not needed for logos and can invoke external
  // resources in downstream parsers. Fail closed before any XML consumer.
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) return null;
  if (/^<svg(?:\s|\/?>)/.test(text) && (/<\/svg\s*>\s*$/.test(text) || /^<svg\b[^<>]*\/\s*>\s*$/.test(text))) return "image/svg+xml";
  return null;
}

export function validateAssetUpload(body: Buffer, fileName: string): { mimeType: string; storageMimeType: string } {
  if (!body.length) throw new ApiException(400, "缺少文件。");
  if (body.length > MAX_ASSET_UPLOAD_BYTES) throw new ApiException(413, "上传文件不能超过 50 MiB。");
  const mimeType = detectAssetUploadMime(body);
  if (!mimeType) throw new ApiException(415, "仅支持 PNG、JPEG、WebP、GIF、SVG、PDF 和 PSD 文件，请检查文件内容。");
  const error = imageUploadLimitError({ name: fileName, size: body.length, type: mimeType });
  if (error) throw new ApiException(413, error);
  // Keep vector data intact, but never serve user-controlled active content
  // as a document on the object store's public origin. /assets/:id/raw already
  // forces SVG/PDF/non-raster files to attachment + nosniff.
  const storageMimeType = ["image/svg+xml", "application/pdf", "image/vnd.adobe.photoshop"].includes(mimeType)
    ? "application/octet-stream" : mimeType;
  return { mimeType, storageMimeType };
}
