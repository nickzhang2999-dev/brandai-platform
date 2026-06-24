import type { Asset as PrismaAsset } from "@brandai/db";
import type { Asset } from "@brandai/contracts";

/**
 * Serialize a Prisma Asset row into the frozen `Asset` wire shape.
 *
 * Prisma columns like `deprecatedAt` / `replacementAssetId` / `aiDescription`
 * are nullable; the Zod `Asset` schema uses `.optional()` (rejects `null`).
 * So every nullable column is OMITTED rather than emitted as `null`, keeping
 * the no-null wire invariant the L1 boundary tests guard.
 */
export function serializeAsset(a: PrismaAsset): Asset {
  return {
    id: a.id,
    workspaceId: a.workspaceId,
    category: a.category,
    fileName: a.fileName,
    url: a.url,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    source: a.source,
    createdAt: a.createdAt.toISOString(),
    aiTags: a.aiTags ?? [],
    ...(a.aiDescription ? { aiDescription: a.aiDescription } : {}),
    isFavorite: a.isFavorite,
    ...(a.resolution ? { resolution: a.resolution } : {}),
    // P1.3 lifecycle — always expose availableForGeneration (a real boolean),
    // omit the nullable deprecatedAt / replacementAssetId when absent.
    availableForGeneration: a.availableForGeneration,
    ...(a.deprecatedAt
      ? { deprecatedAt: a.deprecatedAt.toISOString() }
      : {}),
    ...(a.replacementAssetId
      ? { replacementAssetId: a.replacementAssetId }
      : {}),
    // E3 — folder organization (nullable column omitted when un-filed).
    ...(a.folderId ? { folderId: a.folderId } : {}),
    // F18 — AI 出图回流来源指针（nullable column omitted for uploads/website).
    ...(a.generationVersionId
      ? { generationVersionId: a.generationVersionId }
      : {}),
  };
}

// E? — zero-dependency pixel-size probe for an uploaded image Buffer. Reads the
// PNG IHDR or the JPEG SOF marker directly (mirrors generate.worker's
// decodeImageSize, which works off a base64 data: URL). Returns a display
// string like "1024 × 1024" (matches the detail-panel 尺寸 convention), or null
// for anything it can't parse — so a miss never blocks the upload.
export function decodeImageResolution(buf: Buffer): string | null {
  // PNG: 8-byte signature, then IHDR with width/height as big-endian uint32.
  if (
    buf.length >= 24 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    if (width > 0 && height > 0) return `${width} × ${height}`;
  }
  // JPEG: scan for an SOF marker (0xFFC0–0xFFCF, excluding DHT/JPG/DAC).
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length && buf[off] === 0xff) {
      const marker = buf[off + 1];
      if (marker === undefined) break;
      const len = buf.readUInt16BE(off + 2);
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        const height = buf.readUInt16BE(off + 5);
        const width = buf.readUInt16BE(off + 7);
        if (width > 0 && height > 0) return `${width} × ${height}`;
        break;
      }
      off += 2 + len;
    }
  }
  return null;
}
