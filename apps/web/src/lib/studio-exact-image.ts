import sharp, { type Sharp } from "sharp";
import { ExactAssetTransform } from "@brandai/contracts";
import { ApiException } from "./api";
import { artifactDeadline, inspectArtifactImage, readArtifactImageBytes, STUDIO_ARTIFACT_MAX_BYTES, STUDIO_ARTIFACT_MAX_PIXELS } from "./studio-generation-artifacts-image";

export type StudioExactLayer = {
  assetId: string;
  /** Digest and upright decoded dimensions frozen before the provider call. */
  sha256: string;
  width: number;
  height: number;
  transform: ExactAssetTransform;
};
type AssetSource = { imageUrl: string; objectKey?: string | null };
const failure = (message: string) => new ApiException(422, message);
const transparent = { r: 0, g: 0, b: 0, alpha: 0 };

function dimensions(width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > STUDIO_ARTIFACT_MAX_PIXELS) {
    throw failure("严格保留素材的合成尺寸超过处理上限，未发布图片。");
  }
}

/** Every libvips pipeline is observed and destroyed on abort, including a
 * pipeline that completes after the outer deadline. No URL reaches Sharp. */
async function render(body: Buffer, signal: AbortSignal, configure: (pipeline: Sharp) => Sharp) {
  signal.throwIfAborted();
  const pipeline = sharp(body, { limitInputPixels: STUDIO_ARTIFACT_MAX_PIXELS, failOn: "warning" });
  const abort = () => { pipeline.destroy(); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const output = await artifactDeadline(configure(pipeline).png().toBuffer(), signal);
    signal.throwIfAborted();
    if (!output.length || output.length > STUDIO_ARTIFACT_MAX_BYTES) throw failure("严格保留合成结果超过32MB，未发布图片。");
    return output;
  } finally {
    signal.removeEventListener("abort", abort);
    pipeline.destroy();
  }
}

function cropPixels(fraction: number, extent: number, maximum: number) {
  return Math.min(Math.max(Math.round(extent * fraction), 0), maximum);
}

/** Matches the company's full-source-width, center-anchor and crop-mask math.
 * Geometry adapters must reject unsupported native transforms before calling.
 * Authorization belongs to loadAsset; only a trusted ID, never a caller URL,
 * is passed to it. Returned bytes and metadata contain no source URL/key. */
export async function compositeStudioExactImage(
  base: Buffer,
  layers: StudioExactLayer[],
  loadAsset: (id: string) => Promise<AssetSource>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (!Array.isArray(layers) || layers.length > 32) throw failure("严格保留素材数量超过处理上限。");
  const parsed = layers.map(layer => {
    if (!layer || typeof layer.assetId !== "string" || !layer.assetId || typeof layer.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(layer.sha256)) throw failure("严格保留素材缺少有效身份或内容快照。");
    dimensions(layer.width, layer.height);
    const transform = ExactAssetTransform.safeParse(layer.transform);
    if (!transform.success) throw failure("严格保留素材的变换配置无效。");
    return { ...layer, transform: transform.data };
  }).sort((a, b) => a.transform.zIndex - b.transform.zIndex);
  const originalBase = await inspectArtifactImage(base, signal);
  // A JPEG's EXIF orientation changes the visible coordinate system. Normalize
  // both base and layers before using the company's raster transform math.
  let canvas = await render(base, signal, image => image.rotate());
  const canvasMeta = await inspectArtifactImage(canvas, signal);
  dimensions(canvasMeta.width, canvasMeta.height);
  let totalBytes = base.length;
  let totalPixels = originalBase.width * originalBase.height;
  const appliedAssetIds: string[] = [];
  for (const layer of parsed) {
    signal.throwIfAborted();
    // The frozen dimensions are validated against decoded bytes below, but can
    // already reject an impossible aggregate before another decode allocates.
    if (totalPixels + layer.width * layer.height > STUDIO_ARTIFACT_MAX_PIXELS) throw failure("严格保留素材和底图的总像素超过处理上限。");
    const source = await artifactDeadline(loadAsset(layer.assetId), signal);
    const bytes = await readArtifactImageBytes(source, signal);
    totalBytes += bytes.length;
    if (totalBytes > STUDIO_ARTIFACT_MAX_BYTES) throw failure("严格保留素材和底图合计超过32MB，未发布图片。");
    const meta = await inspectArtifactImage(bytes, signal);
    if (meta.sha256 !== layer.sha256 || meta.width !== layer.width || meta.height !== layer.height) throw failure("严格保留素材的内容或尺寸已变更，未替换为新的素材。");
    totalPixels += meta.width * meta.height;
    if (totalPixels > STUDIO_ARTIFACT_MAX_PIXELS) throw failure("严格保留素材和底图的总像素超过处理上限。");
    const t = layer.transform;
    const width = Math.max(1, Math.round(canvasMeta.width * t.widthRatio));
    const height = Math.max(1, Math.round(meta.height * width / meta.width));
    dimensions(width, height); // Before resize, including extremely thin sources.
    const degrees = ((t.rotationDeg % 360) + 360) % 360;
    const quarter = degrees % 90 === 0;
    const radians = degrees * Math.PI / 180;
    const rotatedWidth = quarter ? (degrees % 180 === 0 ? width : height) : Math.ceil(Math.abs(width * Math.cos(radians)) + Math.abs(height * Math.sin(radians))) + 2;
    const rotatedHeight = quarter ? (degrees % 180 === 0 ? height : width) : Math.ceil(Math.abs(width * Math.sin(radians)) + Math.abs(height * Math.cos(radians))) + 2;
    dimensions(rotatedWidth, rotatedHeight); // Conservative libvips rounding budget.
    let rendered = await render(bytes, signal, image => image.rotate().resize({ width, height, fit: "fill" }));
    const leftCrop = cropPixels(t.crop.left, width, width - 1);
    const topCrop = cropPixels(t.crop.top, height, height - 1);
    const rightCrop = cropPixels(t.crop.right, width, width - leftCrop - 1);
    const bottomCrop = cropPixels(t.crop.bottom, height, height - topCrop - 1);
    if (leftCrop || topCrop || rightCrop || bottomCrop) {
      // Extract+transparent padding is the old dest-in crop mask without an SVG
      // decoder or a change to the full source's center/scale.
      rendered = await render(rendered, signal, image => image.ensureAlpha().extract({ left: leftCrop, top: topCrop, width: width - leftCrop - rightCrop, height: height - topCrop - bottomCrop })
        .extend({ left: leftCrop, top: topCrop, right: rightCrop, bottom: bottomCrop, background: transparent }));
    }
    if (t.flipX) rendered = await render(rendered, signal, image => image.flop());
    if (degrees) rendered = await render(rendered, signal, image => image.rotate(degrees, { background: transparent }));
    const renderedMeta = await inspectArtifactImage(rendered, signal);
    dimensions(renderedMeta.width, renderedMeta.height);
    const rawLeft = Math.round(canvasMeta.width * t.xRatio - renderedMeta.width / 2);
    const rawTop = Math.round(canvasMeta.height * t.yRatio - renderedMeta.height / 2);
    const sourceLeft = Math.max(0, -rawLeft), sourceTop = Math.max(0, -rawTop);
    const left = Math.max(0, rawLeft), top = Math.max(0, rawTop);
    const visibleWidth = Math.min(renderedMeta.width - sourceLeft, canvasMeta.width - left);
    const visibleHeight = Math.min(renderedMeta.height - sourceTop, canvasMeta.height - top);
    if (visibleWidth <= 0 || visibleHeight <= 0) throw failure("严格保留素材完全位于输出区域之外，未发布图片。");
    if (sourceLeft || sourceTop || visibleWidth !== renderedMeta.width || visibleHeight !== renderedMeta.height) {
      rendered = await render(rendered, signal, image => image.extract({ left: sourceLeft, top: sourceTop, width: visibleWidth, height: visibleHeight }));
    }
    // Composite sequentially to avoid retaining 32 full-size decoded layers.
    canvas = await render(canvas, signal, image => image.composite([{ input: rendered, left, top }]));
    appliedAssetIds.push(layer.assetId);
  }
  return { body: canvas, ...await inspectArtifactImage(canvas, signal), appliedAssetIds };
}
