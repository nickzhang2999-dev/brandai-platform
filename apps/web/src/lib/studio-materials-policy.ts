import { createHash } from "node:crypto";
import { STUDIO_MATERIAL_MAX_BYTES, StudioMaterialUploadInput } from "@brandai/contracts";
import { ApiException } from "./api";

export const STUDIO_UPLOAD_WORKSPACE_BYTES = 40 * 1024 * 1024;
export const STUDIO_UPLOAD_GLOBAL_BYTES = 256 * 1024 * 1024;
export const STUDIO_UPLOAD_MAX_PIXELS = 40_000_000;
export const STUDIO_UPLOAD_MIME = ["image/png", "image/jpeg", "image/webp"] as const;

/** Bound the actual stream, including chunked requests with no Content-Length. */
export async function readStudioMaterialForm(req: Request) {
  const maxBody = STUDIO_MATERIAL_MAX_BYTES + 64 * 1024;
  const contentType = req.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;/i.test(contentType)) throw new ApiException(415, "请以文件上传图片。");
  const contentLength = req.headers.get("content-length");
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBody)) throw new ApiException(413, "图片不能超过 10 MiB。");
  if (!req.body) throw new ApiException(400, "缺少图片文件。");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ApiException(408, "上传超时，请重新选择图片。")), 30_000); });
  try {
    for (;;) {
      const part = await Promise.race([reader.read(), timeout]);
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBody) throw new ApiException(413, "图片不能超过 10 MiB。");
      chunks.push(part.value);
    }
  } finally { if (timer) clearTimeout(timer); await reader.cancel().catch(() => undefined); }
  let form: FormData;
  try { form = await new Response(Buffer.concat(chunks), { headers: { "content-type": contentType } }).formData(); }
  catch { throw new ApiException(400, "无法读取图片上传表单。"); }
  for (const key of form.keys()) if (!["file", "projectId", "mutationId"].includes(key) || form.getAll(key).length !== 1) throw new ApiException(422, "上传表单字段无效。");
  const input = StudioMaterialUploadInput.parse({ projectId: form.get("projectId"), mutationId: form.get("mutationId") });
  const file = form.get("file");
  if (!(file instanceof File) || !file.size) throw new ApiException(400, "缺少图片文件。");
  if (file.size > STUDIO_MATERIAL_MAX_BYTES) throw new ApiException(413, "图片不能超过 10 MiB。");
  if (!(STUDIO_UPLOAD_MIME as readonly string[]).includes(file.type)) throw new ApiException(415, "目前支持静态 PNG、JPEG 和 WebP 图片。");
  const fileName = file.name.replace(/[\u0000-\u001f\u007f/\\]/g, "_").slice(0, 255) || "image";
  const body = Buffer.from(await file.arrayBuffer());
  return { ...input, fileName, mimeType: file.type, body, sha256: createHash("sha256").update(body).digest("hex") };
}

export function assertStudioUploadCapacity(workspaceBytes: number, globalBytes: number, incomingBytes: number) {
  if (workspaceBytes + incomingBytes > STUDIO_UPLOAD_WORKSPACE_BYTES || globalBytes + incomingBytes > STUDIO_UPLOAD_GLOBAL_BYTES)
    throw new ApiException(429, "待处理图片较多，请等待当前上传完成后重试。");
}
