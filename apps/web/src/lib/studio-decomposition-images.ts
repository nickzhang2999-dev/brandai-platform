import { createHash } from "node:crypto";
import sharp from "sharp";
import { INK_ALPHA_THRESHOLD } from "@brandai/contracts";
import { ApiException } from "./api";
import { artifactDeadline, STUDIO_ARTIFACT_MAX_BYTES } from "./studio-generation-artifacts-image";

export const STUDIO_LAYER_TOTAL_PIXELS = 40_000_000;
const formats = new Set(["png", "jpeg", "webp"]);
const failure = (message: string) => new ApiException(422, message);
const invalid = () => failure("分层图片损坏、格式不受支持或超过32MB，未发布图层。");

function validDimensions(width: number, height: number) {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height)
    && width > 0 && height > 0 && width <= 16384 && height <= 16384;
}

// The layer model resizes the whole input to ~640² pixels of area and rounds
// each side to a multiple of 32 independently (1920×2560 → 544×736,
// 1024² → 640²). Only that exact predicted frame is accepted as a stretched
// full frame; any other off-aspect size is still treated as a crop or pad.
const STUDIO_LAYER_PROVIDER_AREA = 640 * 640;
function roundToStep(value: number, step: number) {
  const units = value / step, floor = Math.floor(units);
  // Exact halves differ between round-half-even and half-up; accept both.
  return units - floor === 0.5 ? [floor * step, (floor + 1) * step] : [Math.round(units) * step];
}
export function studioLayerProviderFrames(sourceWidth: number, sourceHeight: number) {
  const ratio = sourceWidth / sourceHeight, width = Math.sqrt(STUDIO_LAYER_PROVIDER_AREA * ratio), height = width / ratio;
  return roundToStep(width, 32).flatMap(w => roundToStep(height, 32).map(h => ({ width: w, height: h }))).filter(frame => frame.width > 0 && frame.height > 0);
}

/** The caller checks this whole-group budget before provider/decode work. */
export function assertStudioLayerBudget(width: number, height: number, count: number): void {
  if (!validDimensions(width, height) || !Number.isSafeInteger(count) || count < 2 || count > 10
    || width * height * count > STUDIO_LAYER_TOTAL_PIXELS) {
    throw failure("分层数量或总像素超过处理上限，请减少图层数或降低原图尺寸（2–10层，总计不超过4000万像素）。");
  }
}

export type StudioInspectedLayer = {
  body: Buffer;
  assetSha256: string;
  mimeType: "image/png";
  width: number;
  height: number;
  sizeBytes: number;
  alphaBounds: { left: number; top: number; width: number; height: number };
  inkCoverage: number;
  hasTransparency: boolean;
};

/** Only actual bounded bytes reach Sharp. A smaller full-frame image may be
 * scaled uniformly to the source dimensions; a cropped/aspect-mismatched
 * image has no placement information and cannot be published as a layer.
 * Alpha stays intact: there is no flatten, white fill, trim or canvas crop. */
export async function inspectStudioLayer(
  body: Buffer,
  sourceWidth: number,
  sourceHeight: number,
  signal: AbortSignal,
): Promise<StudioInspectedLayer> {
  signal.throwIfAborted();
  if (!validDimensions(sourceWidth, sourceHeight) || sourceWidth * sourceHeight > STUDIO_LAYER_TOTAL_PIXELS) {
    throw failure("原图尺寸超过分层处理上限，请降低原图尺寸后重试。");
  }
  if (!Buffer.isBuffer(body) || !body.length || body.length > STUDIO_ARTIFACT_MAX_BYTES) throw invalid();
  const image = sharp(body, { limitInputPixels: STUDIO_LAYER_TOTAL_PIXELS, failOn: "warning" });
  const abort = () => { image.destroy(); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const metadata = await artifactDeadline(image.metadata(), signal);
    if (!formats.has(metadata.format ?? "") || !metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) throw invalid();
    const rotated = (metadata.orientation ?? 0) >= 5;
    const width = rotated ? metadata.height : metadata.width;
    const height = rotated ? metadata.width : metadata.height;
    if (!validDimensions(width, height) || width * height > STUDIO_LAYER_TOTAL_PIXELS) throw invalid();
    // A near aspect ratio alone cannot prove a full frame: a crop or padding
    // can also differ by one pixel. Accept only an exact same-aspect frame or
    // the provider's predicted resize frame for this source.
    const providerFrame = studioLayerProviderFrames(sourceWidth, sourceHeight).some(frame => frame.width === width && frame.height === height);
    if (!providerFrame && width * sourceHeight !== height * sourceWidth) {
      throw failure(`分层结果的比例与原图不一致，已保留原图。原图 ${sourceWidth}×${sourceHeight}，返回图层 ${width}×${height}；缺少完整画幅的位置记录，未拉伸或裁切发布。`);
    }
    if (!providerFrame && (width > sourceWidth || height > sourceHeight)) {
      throw failure(`分层结果的尺寸超出原图，已保留原图。原图 ${sourceWidth}×${sourceHeight}，返回图层 ${width}×${height}；缺少完整画幅的缩放记录，未缩放发布。`);
    }
    image.rotate().toColourspace("srgb").ensureAlpha();
    if (width !== sourceWidth || height !== sourceHeight) image.resize({ width: sourceWidth, height: sourceHeight, fit: "fill" });
    // Decode once to a bounded RGBA buffer. The PNG below is encoded from the
    // exact pixels analysed here, so its bounds/hash describe the public bytes.
    const decoded = await artifactDeadline(image.raw().toBuffer({ resolveWithObject: true }), signal);
    signal.throwIfAborted();
    if (decoded.info.width !== sourceWidth || decoded.info.height !== sourceHeight || decoded.info.channels !== 4
      || decoded.data.length !== sourceWidth * sourceHeight * 4) throw invalid();
    let ink = 0, minX = sourceWidth, minY = sourceHeight, maxX = -1, maxY = -1;
    let hasTransparency = false;
    for (let y = 0; y < sourceHeight; y++) {
      signal.throwIfAborted();
      for (let x = 0; x < sourceWidth; x++) {
        const alpha = decoded.data[(y * sourceWidth + x) * 4 + 3]!;
        if (alpha < 255) hasTransparency = true;
        if (alpha >= INK_ALPHA_THRESHOLD) ink++;
        // Faint shadows are real pixels. Keep the threshold for coverage,
        // never use it to discard a layer or crop its translucent edges.
        if (!alpha) continue;
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
    }
    if (maxX < 0) throw failure("分层服务返回了空白或全透明图层，未发布不完整的分层结果。");
    const encoding = sharp(decoded.data, { raw: { width: sourceWidth, height: sourceHeight, channels: 4 }, limitInputPixels: STUDIO_LAYER_TOTAL_PIXELS });
    const abortEncoding = () => { encoding.destroy(); };
    signal.addEventListener("abort", abortEncoding, { once: true });
    let output: Buffer;
    try { output = await artifactDeadline(encoding.png().toBuffer(), signal); }
    finally { signal.removeEventListener("abort", abortEncoding); encoding.destroy(); }
    signal.throwIfAborted();
    if (!output.length || output.length > STUDIO_ARTIFACT_MAX_BYTES) throw invalid();
    return { body: output, assetSha256: createHash("sha256").update(output).digest("hex"), mimeType: "image/png",
      width: sourceWidth, height: sourceHeight, sizeBytes: output.length,
      alphaBounds: { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
      inkCoverage: ink / (sourceWidth * sourceHeight), hasTransparency };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ApiException) throw error;
    throw invalid();
  } finally {
    signal.removeEventListener("abort", abort);
    image.destroy();
  }
}
