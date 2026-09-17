import sharp from "sharp";
import type { Readable } from "node:stream";

export const IMAGE_PREVIEW_MAX_SOURCE_BYTES = 32 * 1024 * 1024;
export const IMAGE_PREVIEW_CACHE_CONTROL = "private, max-age=86400, immutable";
export const IMAGE_PREVIEW_WIDTH = 768;

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
  signal?: AbortSignal,
): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const onAbort = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    signal?.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        const error = new Error("image source exceeds preview limit");
        // Releasing the reader lock does not stop the underlying HTTP body.
        // Cancel it now so every retry cannot leave another oversized socket
        // downloading after this job has already failed.
        await reader.cancel(error).catch(() => {});
        throw error;
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
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
  signal?: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const onAbort = () => {
    const reason =
      signal?.reason instanceof Error
        ? signal.reason
        : new Error("image source read aborted");
    stream.destroy(reason);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    signal?.throwIfAborted();
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > maxBytes) {
        stream.destroy();
        throw new Error("image source exceeds preview limit");
      }
      chunks.push(bytes);
    }
    signal?.throwIfAborted();
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  return Buffer.concat(chunks, total);
}

/** Rasterise every supported source (including SVG) to a safe, compact WebP. */
export async function renderImagePreview(
  source: Buffer,
  width: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted();
  const pipeline = sharp(source, {
    failOn: "error",
    limitInputPixels: 64_000_000,
  })
    .rotate()
    .resize({ width, withoutEnlargement: true, fit: "inside" })
    .webp({ quality: 78, alphaQuality: 92, effort: 4 });
  const onAbort = () => pipeline.destroy();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const output = await pipeline.toBuffer();
    signal?.throwIfAborted();
    return output;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
