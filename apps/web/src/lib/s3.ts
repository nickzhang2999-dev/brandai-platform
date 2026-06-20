import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { getEffectiveStorage } from "@/lib/settings";

// 2026-05-28 — module-level S3Client and S3_*-env-based helpers removed.
// Per docs/PRINCIPLES.md §1 + INFRA-AUDIT.md, the platform's storage truth
// lives in AppSetting (admin-configured at runtime via /admin/settings/
// storage) and every consumer must build a client per call from
// getEffectiveStorage(). The dropped exports were:
//   - `s3` (module-level S3Client) — only legacy callers, all removed.
//   - `s3PublicUrl(key)` — replaced by `${getEffectiveStorage().publicUrl}/${key}`
//     at the call site so the URL reflects current AppSetting (e.g. swapping
//     R2 buckets doesn't strand existing assets at stale URLs).

/**
 * M-A — server-side object fetch for the public asset proxy. The BFF can reach
 * the storage origin over the internal network even when the browser can't, so
 * the proxy route streams the object body back over the canonical public domain
 * instead of handing the browser an unreachable MinIO URL.
 */
const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
};

/**
 * Upload a base64 `data:<contentType>;base64,<b64>` image to the admin-configured
 * (or S3_*-env) object store and return its public URL. Non-data URLs pass
 * through unchanged (they're already hosted — don't re-upload).
 *
 * The S3Client is built per-call from the effective storage config because that
 * config is now admin-editable at runtime; this is fine for the worker's volume.
 * On any failure this THROWS so the caller can mark the generation FAILED rather
 * than persist a broken URL.
 */
export async function uploadDataUrlImage(
  dataUrl: string,
  keyPrefix: string,
): Promise<string> {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match || !match[2]) {
    // Not a base64 data: URL — already a hosted URL (or non-data scheme).
    return dataUrl;
  }
  // Keep self-contained SVG placeholders (mock provider) inline: they're tiny
  // and render anywhere, so uploading them to object storage just adds a
  // fragile network hop that breaks the demo when storage isn't browser-
  // reachable. Real raster output (png/jpeg from a live provider) still uploads.
  if ((match[1] || "").toLowerCase().includes("svg")) {
    return dataUrl;
  }
  const cfg = await getEffectiveStorage();
  if (!cfg.configured) {
    // No admin-configured storage. The S3_* env points at the internal MinIO
    // (host "minio" — not browser-reachable, nor resolvable from this app
    // container), so keep the inline data: URL rather than persist an unusable
    // link. Once COS/R2 is set on the admin page, uploads kick in.
    return dataUrl;
  }

  const contentType = match[1] || "image/png";
  const b64 = match[3] ?? "";
  const body = Buffer.from(b64, "base64");
  const ext = EXT_BY_TYPE[contentType.toLowerCase()] ?? "png";

  const client = new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    forcePathStyle: cfg.forcePathStyle,
    credentials: {
      accessKeyId: cfg.accessKey,
      secretAccessKey: cfg.secretKey,
    },
  });

  const key = `${keyPrefix}/${randomUUID()}.${ext}`;
  await client.send(
    new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );

  const base = cfg.publicUrl.replace(/\/+$/, "");
  return `${base}/${key}`;
}

/**
 * Upload a raw buffer to the admin-configured (R2) object store and return the
 * stored object key plus its public URL. Used by the server-side asset upload
 * route so the browser never PUTs directly to the (unreachable) MinIO origin.
 *
 * Mirrors {@link uploadDataUrlImage}'s per-call client construction. THROWS when
 * storage is not configured so the caller can surface a clear 5xx/4xx instead of
 * persisting a broken URL.
 */
export async function uploadBuffer(
  body: Buffer,
  contentType: string,
  keyPrefix: string,
): Promise<{ key: string; url: string }> {
  const cfg = await getEffectiveStorage();
  if (!cfg.configured) {
    throw new Error("object storage not configured");
  }

  const ext = EXT_BY_TYPE[contentType.toLowerCase()] ?? "bin";

  const client = new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    forcePathStyle: cfg.forcePathStyle,
    credentials: {
      accessKeyId: cfg.accessKey,
      secretAccessKey: cfg.secretKey,
    },
  });

  const key = `${keyPrefix}/${randomUUID()}.${ext}`;
  await client.send(
    new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );

  const base = cfg.publicUrl.replace(/\/+$/, "");
  return { key, url: `${base}/${key}` };
}

/**
 * Server-side object fetch for the public asset proxy. Builds its client from the
 * effective (admin-configured R2) storage so the `/raw` proxy streams from the
 * reachable origin rather than the internal MinIO that the web container can't
 * resolve.
 */
export async function getObjectStream(key: string): Promise<{
  body: Readable;
  contentType: string;
  contentLength?: number;
}> {
  const cfg = await getEffectiveStorage();
  const client = new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    forcePathStyle: cfg.forcePathStyle,
    credentials: {
      accessKeyId: cfg.accessKey,
      secretAccessKey: cfg.secretKey,
    },
  });
  const res = await client.send(
    new GetObjectCommand({ Bucket: cfg.bucket, Key: key }),
  );
  return {
    body: res.Body as Readable,
    contentType: res.ContentType ?? "application/octet-stream",
    contentLength: res.ContentLength,
  };
}
