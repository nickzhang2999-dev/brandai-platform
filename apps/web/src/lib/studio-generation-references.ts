import { prisma } from "@brandai/db";
import type { ReferenceImage } from "@brandai/contracts";
import { ApiException } from "./api";
import { inspectArtifactImage, readArtifactImageBytes } from "./studio-generation-artifacts-image";

/** The AI service cannot read browser cookies or private object URLs. Every
 * product reference is resolved through an authorized Asset before transport. */
export async function inlineStudioGenerationReferences(workspaceId: string, references: ReferenceImage[], signal: AbortSignal, expectedAssetSha256: Record<string, string> = {}) {
  const expected = new Map(Object.entries(expectedAssetSha256));
  const explicitIds = new Set(references.filter(ref => ref.source.startsWith("asset:")).map(ref => ref.source.slice(6)));
  // Both directions are deliberate: missing snapshots cannot downgrade this
  // check, and an accepted active input cannot silently disappear from payload.
  if ([...expected].some(([id, sha]) => !explicitIds.has(id) || typeof sha !== "string" || sha.length !== 64 || !/^[a-f0-9]{64}$/.test(sha))
    || [...explicitIds].some(id => !expected.has(id))) {
    throw new ApiException(422, "参与素材的受理快照不完整，请重新确认素材后提交。");
  }
  const assets = references.length ? await prisma.asset.findMany({ where: { workspaceId, url: { in: references.map(ref => ref.url) }, availableForGeneration: true, deprecatedAt: null },
    select: { id: true, url: true, storageKey: true } }) : [];
  const results: ReferenceImage[] = [];
  const audit: Array<Record<string, unknown>> = [];
  let total = 0;
  for (const reference of references) {
    signal.throwIfAborted();
    const candidates = assets.filter(asset => asset.url === reference.url && (!reference.source.startsWith("asset:") || asset.id === reference.source.slice(6)));
    if (candidates.length !== 1) throw new ApiException(422, "品牌或参与素材不属于当前工作区，或关联不明确，请检查素材后重试。");
    const asset = candidates[0]!;
    const body = await readArtifactImageBytes({ imageUrl: asset.url, objectKey: asset.storageKey && !/^https?:\/\//i.test(asset.storageKey) ? asset.storageKey : null }, signal);
    total += body.length;
    if (total > 32 * 1024 * 1024) throw new ApiException(422, "参与素材合计超过32MB，请减少素材后重试。");
    const meta = await inspectArtifactImage(body, signal);
    if (expected.has(asset.id) && meta.sha256 !== expected.get(asset.id)) {
      throw new ApiException(422, "参与素材的图片内容已变更，未调用生成服务；请重新选择素材后提交。");
    }
    results.push({ ...reference, url: `data:${meta.mimeType};base64,${body.toString("base64")}` });
    audit.push({ assetId: asset.id, sha256: meta.sha256, source: reference.source, polarity: reference.polarity,
      ...(reference.mode ? { mode: reference.mode } : {}), ...(reference.note ? { note: reference.note } : {}) });
  }
  return { references: results, audit };
}

/** Provider params are untrusted echo data. Publish only bounded size/model
 * provenance, never a serialized provider request or reference image bytes. */
export function studioProviderParams(value: unknown): Record<string, string | number | boolean> {
  if (!value || typeof value !== "object") return {};
  const allow = new Set(["model", "provider", "seed", "targetKey", "targetLabel", "ratioKey", "resolutionTier", "requestedRatio", "requestedWidth", "requestedHeight", "actualWidth", "actualHeight", "size", "quality"]);
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => allow.has(key) &&
    ((typeof item === "string" && item.length <= 200 && !/data:|https?:|base64/i.test(item)) || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))))) as Record<string, string | number | boolean>;
}
