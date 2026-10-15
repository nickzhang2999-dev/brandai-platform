import { StudioConversationPixels, validateGptImage2Size } from "@brandai/contracts";

/** Model pixels and delivered pixels are separate. Keep the accepted job target
 * unchanged: the artifact worker resamples before validating/compositing it. */
export function studioConversationProviderSize(requested: { width: number; height: number }) {
  const size = StudioConversationPixels.parse({ width: requested.width, height: requested.height });
  if (!validateGptImage2Size(size.width, size.height)) return size;
  const ratio = size.width / size.height;
  const area = size.width * size.height;
  let best: { width: number; height: number; ratioError: number; areaError: number } | undefined;
  for (let width = 16; width <= 3840; width += 16) {
    const ideal = width / ratio / 16;
    for (const height of new Set([Math.floor(ideal) * 16, Math.ceil(ideal) * 16])) {
      if (validateGptImage2Size(width, height)) continue;
      const ratioError = Math.abs(Math.log(width / height / ratio));
      const areaError = Math.abs(Math.log(width * height / area));
      if (!best || ratioError < best.ratioError - 1e-10 ||
        (Math.abs(ratioError - best.ratioError) <= 1e-10 && areaError < best.areaError)) {
        best = { width, height, ratioError, areaError };
      }
    }
  }
  if (!best) throw new Error("无法为该输出尺寸匹配受支持的模型尺寸。");
  return { width: best.width, height: best.height };
}
