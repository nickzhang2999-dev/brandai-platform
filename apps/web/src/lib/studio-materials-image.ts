import sharp from "sharp";
import { ApiException } from "./api";
import { STUDIO_UPLOAD_MAX_PIXELS } from "./studio-materials-policy";

/** Decode in the worker, never accept browser-provided dimensions or MIME. */
export async function inspectStudioMaterialImage(body: Buffer, mimeType: string) {
  try {
    const image = sharp(body, { limitInputPixels: STUDIO_UPLOAD_MAX_PIXELS, failOn: "warning" });
    const meta = await image.metadata();
    const actual = ({ png: "image/png", jpeg: "image/jpeg", webp: "image/webp" } as Record<string, string>)[meta.format ?? ""];
    if (actual !== mimeType || (meta.pages ?? 1) > 1 || !meta.width || !meta.height || meta.width > 16384 || meta.height > 16384 || meta.width * meta.height > STUDIO_UPLOAD_MAX_PIXELS)
      throw new Error("unsupported image");
    // metadata alone accepts truncated payloads. Force a complete bounded decode.
    await image.stats();
    const rotated = (meta.orientation ?? 0) >= 5;
    return { width: rotated ? meta.height : meta.width, height: rotated ? meta.width : meta.height };
  } catch { throw new ApiException(422, "图片损坏或格式不受支持。请上传 4000 万像素以内的静态 PNG、JPEG 或 WebP。"); }
}
