import { prisma, Prisma } from "@brandai/db";
import type { VisualFidelitySourceImage } from "@brandai/contracts";
import { ApiException } from "./api";
import { artifactDeadline, inspectArtifactImage, readArtifactImageBytes, STUDIO_ARTIFACT_MAX_BYTES } from "./studio-generation-artifacts-image";
import type { StudioVisualFidelitySnapshot } from "./studio-visual-fidelity";

type Reference = StudioVisualFidelitySnapshot["referenceImages"][number];
export type FidelityReferenceBinding = { id: string; url: string; storageKey: string | null };
const unavailable = () => new ApiException(422, "本次参考图片已失效、归属变化或内容已更新，主体保真待核验。");
const select = { id: true, url: true, storageKey: true } as const;
const where = (workspaceId: string, references: Reference[]) => ({ workspaceId,
  id: { in: [...new Set(references.map(reference => reference.assetId))] }, availableForGeneration: true, deprecatedAt: null });

function match(references: Reference[], assets: FidelityReferenceBinding[], bindings?: FidelityReferenceBinding[]) {
  for (const reference of references) {
    const matches = assets.filter(asset => asset.id === reference.assetId);
    if (matches.length !== 1) throw unavailable();
    if (bindings) {
      const before = bindings.find(asset => asset.id === reference.assetId);
      if (!before || before.url !== matches[0]!.url || before.storageKey !== matches[0]!.storageKey) throw unavailable();
    }
  }
}

/** Caller holds the generation/project authorization. Lock only scoped source
 * assets while publishing the report so a concurrent withdrawal cannot race it. */
export async function assertStudioFidelityReferenceBindings(db: Prisma.TransactionClient, workspaceId: string,
  references: Reference[], bindings?: FidelityReferenceBinding[]) {
  if (!references.length) return;
  const ids = [...new Set(references.map(reference => reference.assetId))];
  await db.$queryRaw(Prisma.sql`SELECT "id" FROM "Asset" WHERE "workspaceId" = ${workspaceId} AND "id" IN (${Prisma.join(ids)}) FOR SHARE`);
  const assets = await db.asset.findMany({ where: where(workspaceId, references), select });
  match(references, assets, bindings);
}

/** Re-read the actual generation references, never model URLs or a new brand
 * reference selection. Roles are context, not an automatic identity lock. */
export async function loadStudioFidelityReferences(workspaceId: string, references: Reference[], signal: AbortSignal, initialBytes: number) {
  if (references.length > 8 || !Number.isSafeInteger(initialBytes) || initialBytes < 0 || initialBytes > STUDIO_ARTIFACT_MAX_BYTES)
    throw new ApiException(422, "视觉检查图片数量或合计大小超过限制，主体保真待核验。");
  const assets = references.length ? await artifactDeadline(prisma.asset.findMany({ where: where(workspaceId, references), select }), signal) : [];
  match(references, assets);
  let totalBytes = initialBytes;
  const images: VisualFidelitySourceImage[] = [];
  for (const [index, reference] of references.entries()) {
    signal.throwIfAborted();
    const asset = assets.find(item => item.id === reference.assetId)!;
    const bytes = await readArtifactImageBytes({ imageUrl: asset.url,
      objectKey: asset.storageKey && !/^https?:\/\//i.test(asset.storageKey) ? asset.storageKey : null }, signal);
    totalBytes += bytes.length;
    if (totalBytes > STUDIO_ARTIFACT_MAX_BYTES) throw new ApiException(422, "视觉检查图片合计超过32MB，主体保真待核验。");
    const meta = await inspectArtifactImage(bytes, signal);
    if (meta.sha256 !== reference.sha256) throw unavailable();
    const note = `来源：${reference.source}；极性：${reference.polarity}；参考方式：${reference.mode || "未指定"}。${reference.note || ""}`;
    if (note.length > 4000) throw new ApiException(422, "参考角色说明超过可核验范围，主体保真待核验。");
    images.push({ id: `reference-${index + 1}`, role: "reference-context", note,
      url: `data:${meta.mimeType};base64,${bytes.toString("base64")}`, sha256: meta.sha256, sourceHint: "UPLOAD" });
  }
  return { images, totalBytes, bindings: assets };
}
