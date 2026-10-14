import { createHash } from "node:crypto";
import { StudioMaterial } from "@brandai/contracts";

/** Bind a receipt to immutable source identity. Availability is checked anew. */
export function studioBrandMaterialSourceDigest(asset: { id: string; workspaceId: string;
  storageKey: string; url: string; mimeType: string; sizeBytes: number;
  generationVersionId?: string | null }) {
  return createHash("sha256").update(JSON.stringify([asset.id, asset.workspaceId,
    asset.storageKey, asset.url, asset.mimeType, asset.sizeBytes, asset.generationVersionId ?? null])).digest("hex");
}
export function studioBrandObjectKey(key: string, workspaceId: string) {
  return !!key && (key.startsWith(`${workspaceId}/`) || key.startsWith(`generations/${workspaceId}/`))
    && !/[\\?#%]/.test(key) && key.split("/").every(part => part && part !== "." && part !== "..");
}
export function studioTrustedMaterial(asset: { id: string; workspaceId: string; fileName: string;
  mimeType: string; sizeBytes: number; availableForGeneration: boolean; deprecatedAt: Date | null;
  generationVersionId?: string | null },
  proof: { sha256: string | null; mimeType: string | null; width: number | null; height: number | null } | null) {
  if (!asset.availableForGeneration || asset.deprecatedAt || !proof || proof.mimeType !== asset.mimeType) return null;
  const parsed = StudioMaterial.safeParse({ id: asset.id, assetId: asset.id, assetSha256: proof.sha256,
    ...(asset.generationVersionId ? { versionId: asset.generationVersionId } : {}),
    fileName: asset.fileName, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes,
    width: proof.width, height: proof.height,
    url: `/api/workspaces/${asset.workspaceId}/assets/${asset.id}/raw`, kind: "image" });
  return parsed.success ? parsed.data : null;
}
