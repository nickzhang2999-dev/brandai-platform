import sharp from "sharp";
import { StudioConversationPixels } from "@brandai/contracts";
import { artifactDeadline, inspectArtifactImage } from "./studio-generation-artifacts-image";

/** Exact dimensions are an output guarantee. This is deterministic resampling
 * and padding, never an AI detail-enhancement claim or a second paid call. */
export async function sizeStudioConversationImage(body: Buffer, requested: unknown, signal: AbortSignal) {
  const size = StudioConversationPixels.parse(requested);
  const provider = await inspectArtifactImage(body, signal);
  if (provider.width === size.width && provider.height === size.height) return { body, providerSize: { width: provider.width, height: provider.height }, requestedSize: size, resized: false };
  const image = sharp(body, { limitInputPixels: 40_000_000, failOn: "warning" }).rotate()
    .resize(size.width, size.height, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 0 }, kernel: "lanczos3" }).png();
  const abort = () => image.destroy(); signal.addEventListener("abort", abort, { once: true });
  try {
    const resized = await artifactDeadline(image.toBuffer(), signal);
    const actual = await inspectArtifactImage(resized, signal);
    if (actual.width !== size.width || actual.height !== size.height) throw new Error("Output dimensions do not match accepted request");
    return { body: resized, providerSize: { width: provider.width, height: provider.height }, requestedSize: size, resized: true };
  } finally { signal.removeEventListener("abort", abort); image.destroy(); }
}
