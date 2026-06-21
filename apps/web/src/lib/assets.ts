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
  };
}
