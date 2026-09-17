import sharp from "sharp";
import type { Readable } from "node:stream";

export const IMAGE_PREVIEW_MAX_SOURCE_BYTES = 32 * 1024 * 1024;
export const IMAGE_PREVIEW_CACHE_CONTROL = "private, max-age=86400, immutable";

const ALLOWED_WIDTHS = [320, 512, 768, 1024] as const;

/**
 * Keep the resize surface deliberately small so arbitrary query strings cannot
 * create an unbounded transform cache or force huge libvips allocations.
 */
export function parseImagePreviewWidth(req: Request): number | null {
  const raw = new URL(req.url).searchParams.get("w");
  if (!raw) return null;
  const requested = Number(raw);
  if (!Number.isFinite(requested) || requested <= 0) return null;
  return (
    ALLOWED_WIDTHS.find((width) => requested <= width) ??
    ALLOWED_WIDTHS[ALLOWED_WIDTHS.length - 1] ??
    1024
  );
}

export function imagePreviewEtag(
  identity: string,
  width: number,
  revision = "v1",
): string {
  return `"preview-${revision}-${identity}-${width}"`;
}

export function imagePreviewHeaders(
  etag: string,
  contentLength?: number,
): Record<string, string> {
  return {
    "cache-control": IMAGE_PREVIEW_CACHE_CONTROL,
    etag,
    vary: "Cookie",
    ...(contentLength ? { "content-length": String(contentLength) } : {}),
  };
}

export async function webStreamToBuffer(
  stream: ReadableStream<Uint8Array>,
  maxBytes = IMAGE_PREVIEW_MAX_SOURCE_BYTES,
): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes)
        throw new Error("image source exceeds preview limit");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  );
}

export async function nodeStreamToBuffer(
  stream: Readable,
  maxBytes = IMAGE_PREVIEW_MAX_SOURCE_BYTES,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maxBytes) {
      stream.destroy();
      throw new Error("image source exceeds preview limit");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

/** Rasterise every supported source (including SVG) to a safe, compact WebP. */
export async function renderImagePreview(
  source: Buffer,
  width: number,
): Promise<Buffer> {
  return sharp(source, { failOn: "error", limitInputPixels: 64_000_000 })
    .rotate()
    .resize({ width, withoutEnlargement: true, fit: "inside" })
    .webp({ quality: 78, alphaQuality: 92, effort: 4 })
    .toBuffer();
}
