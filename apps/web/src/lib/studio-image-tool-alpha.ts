import sharp from "sharp";
import { ApiException } from "./api";
import { artifactDeadline, STUDIO_ARTIFACT_MAX_BYTES } from "./studio-generation-artifacts-image";
import { STUDIO_IMAGE_TOOL_MAX_PIXELS } from "@brandai/contracts";

/** Check before any contain/padding and again after final composition. Neither
 * a white backdrop nor a uniformly translucent rectangle counts as removal.
 * This is only a file-integrity gate, not semantic cutout quality acceptance. */
export async function requireStudioTransparentForeground(body: Buffer, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!body.length || body.length > STUDIO_ARTIFACT_MAX_BYTES) throw new ApiException(422, "去背景输出超过文件上限，原图仍保留。");
  const image = sharp(body, { limitInputPixels: STUDIO_IMAGE_TOOL_MAX_PIXELS, failOn: "warning" });
  const abort = () => image.destroy(); signal.addEventListener("abort", abort, { once: true });
  try {
    const meta = await artifactDeadline(image.metadata(), signal);
    if (meta.format !== "png" || !meta.hasAlpha || (meta.pages ?? 1) !== 1) throw new ApiException(422, "去背景服务未返回真实透明 PNG，原图仍保留。");
    const stats = await artifactDeadline(image.stats(), signal), alpha = stats.channels.at(-1);
    if (!alpha || alpha.min !== 0 || alpha.max <= 0) throw new ApiException(422, "去背景结果没有透明背景或前景已经丢失，未发布图片。");
    signal.throwIfAborted();
  } finally { signal.removeEventListener("abort", abort); image.destroy(); }
}
