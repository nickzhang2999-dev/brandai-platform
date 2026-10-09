import { createHash } from "node:crypto";
import sharp from "sharp";
import { WatermarkOverlayInput } from "@brandai/contracts";
import { ApiException } from "./api";
import { getObjectStream } from "./s3";
import { safeFetch } from "./ssrf";
import { nodeStreamToBuffer, webStreamToBuffer } from "./image-preview";
import { applyWatermarksToImage, type ResolvedWatermarkOverlay } from "./watermark";

export const STUDIO_ARTIFACT_MAX_BYTES = 32 * 1024 * 1024;
export const STUDIO_ARTIFACT_MAX_PIXELS = 40_000_000;
const formats: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };
const invalid = () => new ApiException(422, "生成图片损坏、过大或格式不受支持；原始结果已保留，请检查后重试归档。");

/** Enforce the deadline even if an adapter/DNS implementation ignores signal. */
export async function artifactDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  // Arguments are evaluated before this function. Observe a started adapter
  // even when the caller was aborted already, so its late rejection is handled.
  void work.catch(() => undefined);
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason ?? new Error("Archive deadline exceeded"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([work, stopped]); }
  finally { if (abort) signal.removeEventListener("abort", abort); }
}

export function artifactDataBytes(input: string): Buffer {
  if (input.length > Math.ceil(STUDIO_ARTIFACT_MAX_BYTES / 3) * 4 + 64) throw invalid();
  const comma = input.indexOf(",");
  if (comma < 0 || !/^data:image\/(png|jpeg|webp);base64$/i.test(input.slice(0, comma))) throw invalid();
  const payload = input.slice(comma + 1);
  if (!payload || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) throw invalid();
  const body = Buffer.from(payload, "base64");
  if (!body.length || body.length > STUDIO_ARTIFACT_MAX_BYTES || body.toString("base64") !== payload) throw invalid();
  return body;
}

/** Only an exact configured object URL can become an S3 key; never guess from a basename. */
export function artifactOwnObjectKey(url: string, publicBase: string, workspaceId?: string): string | null {
  const prefix = publicBase.replace(/\/+$/, "") + "/";
  if (!publicBase || !/^https?:\/\//i.test(publicBase) || !url.startsWith(prefix)) return null;
  const key = url.slice(prefix.length);
  if (!key || /[\\?#%]/.test(key) || key.split("/").some(p => !p || p === "." || p === "..")) return null;
  if (workspaceId && !key.startsWith(`${workspaceId}/`) && !key.startsWith(`generations/${workspaceId}/`)) {
    throw new ApiException(422, "生成结果的存储对象不属于当前工作区。");
  }
  return key;
}

export async function readArtifactImageBytes(source: { imageUrl: string; objectKey?: string | null }, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  if (source.objectKey) {
    const object = await artifactDeadline(getObjectStream(source.objectKey, signal), signal);
    if (object.contentLength && object.contentLength > STUDIO_ARTIFACT_MAX_BYTES) { object.body.destroy(); throw invalid(); }
    return artifactDeadline(nodeStreamToBuffer(object.body, STUDIO_ARTIFACT_MAX_BYTES, signal), signal);
  }
  if (source.imageUrl.startsWith("data:")) return artifactDataBytes(source.imageUrl);
  if (source.imageUrl.length > 8192 || !/^https?:\/\//i.test(source.imageUrl)) throw invalid();
  const response = await artifactDeadline(safeFetch(source.imageUrl, 4, signal), signal);
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > STUDIO_ARTIFACT_MAX_BYTES) {
    void response.body?.cancel().catch(() => {}); throw invalid();
  }
  return artifactDeadline(webStreamToBuffer(response.body, STUDIO_ARTIFACT_MAX_BYTES, signal), signal);
}

export async function inspectArtifactImage(body: Buffer, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!body.length || body.length > STUDIO_ARTIFACT_MAX_BYTES) throw invalid();
  const image = sharp(body, { limitInputPixels: STUDIO_ARTIFACT_MAX_PIXELS, failOn: "warning" });
  const abort = () => image.destroy();
  signal.addEventListener("abort", abort, { once: true });
  try {
    const meta = await artifactDeadline(image.metadata(), signal);
    const mimeType = formats[meta.format ?? ""];
    if (!mimeType || !meta.width || !meta.height || (meta.pages ?? 1) !== 1 || meta.width > 16384 || meta.height > 16384 || meta.width * meta.height > STUDIO_ARTIFACT_MAX_PIXELS) throw invalid();
    await artifactDeadline(image.stats(), signal); // Metadata alone accepts truncated images.
    signal.throwIfAborted();
    const rotated = (meta.orientation ?? 0) >= 5;
    return { mimeType, width: rotated ? meta.height : meta.width, height: rotated ? meta.width : meta.height,
      sha256: createHash("sha256").update(body).digest("hex"), sizeBytes: body.length };
  } catch { signal.throwIfAborted(); throw invalid(); }
  finally { signal.removeEventListener("abort", abort); image.destroy(); }
}

/** All source bytes passed to the legacy compositor are bounded data URLs.
 * It cannot fetch a snapshot's expired or untrusted assetUrl on our behalf. */
export async function postprocessArtifactImage(body: Buffer, rawOverlays: unknown, loadAsset: (id: string) => Promise<{ imageUrl: string; objectKey?: string | null }>, signal: AbortSignal, expectedHashes?: unknown) {
  const initial = await inspectArtifactImage(body, signal);
  const parsed = WatermarkOverlayInput.array().max(32).safeParse(rawOverlays ?? []);
  if (!parsed.success) throw new ApiException(422, "生成结果的品牌合成配置无效，未发布未完成的图片。");
  const overlays: ResolvedWatermarkOverlay[] = [];
  let overlayBytes = 0;
  for (const overlay of parsed.data) {
    if (!overlay.enabled) continue;
    if (!overlay.assetId) { overlays.push(overlay); continue; }
    const expected = expectedHashes && typeof expectedHashes === "object" && !Array.isArray(expectedHashes)
      ? (expectedHashes as Record<string, unknown>)[overlay.assetId] : null;
    if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) throw new ApiException(422, "品牌图片缺少生成前的内容校验快照，未发布图片。");
    const bytes = await readArtifactImageBytes(await artifactDeadline(loadAsset(overlay.assetId), signal), signal);
    overlayBytes += bytes.length;
    if (overlayBytes > STUDIO_ARTIFACT_MAX_BYTES) throw new ApiException(422, "品牌合成素材总量超过处理上限，原始结果已保留。");
    const meta = await inspectArtifactImage(bytes, signal);
    if (meta.sha256 !== expected) throw new ApiException(422, "品牌图片内容在生成后发生变更，原始结果已保留，未替换为新的标志。");
    overlays.push({ ...overlay, assetUrl: `data:${meta.mimeType};base64,${bytes.toString("base64")}`, assetMimeType: meta.mimeType });
  }
  if (!overlays.length) return { body, ...initial, appliedAssetIds: [] as string[] };
  const result = await artifactDeadline(applyWatermarksToImage(`data:${initial.mimeType};base64,${body.toString("base64")}`, overlays), signal);
  const expected = overlays.flatMap(o => o.assetId ? [o.assetId] : []);
  if (expected.some(id => !result.appliedAssetIds.includes(id))) throw new ApiException(422, "品牌素材合成未完成，图片尚未发布，请检查后重试归档。");
  const finalBody = artifactDataBytes(result.imageUrl);
  return { body: finalBody, ...await inspectArtifactImage(finalBody, signal), appliedAssetIds: result.appliedAssetIds };
}
