import { prisma } from "@brandai/db";
import type { ReferenceImage } from "@brandai/contracts";
import { ApiException } from "./api";
import { artifactDeadline, inspectArtifactImage, readArtifactImageBytes, STUDIO_ARTIFACT_MAX_BYTES } from "./studio-generation-artifacts-image";

/** Same ACTIVE/affectsValidation semantics as the company compliance helper,
 * but resolve by scoped Asset ID and fail closed instead of dropping examples. */
export async function loadStudioComplianceReferences(workspaceId: string, signal: AbortSignal, imageBytes: number) {
  const rules = await artifactDeadline(prisma.prohibitionRule.findMany({ where: { workspaceId, status: "ACTIVE", affectsValidation: true }, orderBy: { createdAt: "asc" } }), signal);
  const examples = rules.flatMap(rule => [
    ...(rule.positiveExampleAssetId ? [{ rule, assetId: rule.positiveExampleAssetId, polarity: "positive" as const }] : []),
    ...(rule.negativeExampleAssetId ? [{ rule, assetId: rule.negativeExampleAssetId, polarity: "negative" as const }] : []),
  ]);
  // The company VLM consumes at most eight references. Never claim that an
  // unchecked ninth prohibition example participated in the check.
  if (examples.length > 8) throw new ApiException(422, "视觉检查参考图超过8张，请调整启用的禁用规范后重试检查。");
  const assets = examples.length ? await artifactDeadline(prisma.asset.findMany({ where: { workspaceId, id: { in: examples.map(example => example.assetId) }, deprecatedAt: null }, select: { id: true, url: true, storageKey: true } }), signal) : [];
  const referenceImages: ReferenceImage[] = [];
  const audit: Array<{ assetId: string; sha256: string; source: string; polarity: string }> = [];
  let totalBytes = imageBytes;
  for (const example of examples) {
    signal.throwIfAborted();
    const asset = assets.find(item => item.id === example.assetId);
    if (!asset) throw new ApiException(422, "视觉检查参考素材已失效或不属于当前品牌空间，请修复后重试检查。");
    const body = await readArtifactImageBytes({ imageUrl: asset.url, objectKey: asset.storageKey && !/^https?:\/\//i.test(asset.storageKey) ? asset.storageKey : null }, signal);
    totalBytes += body.length;
    if (totalBytes > STUDIO_ARTIFACT_MAX_BYTES) throw new ApiException(422, "视觉检查图片合计超过32MB，请减少参考图后重试检查。");
    const meta = await inspectArtifactImage(body, signal);
    const source = `prohibition:${example.rule.id}`;
    referenceImages.push({ url: `data:${meta.mimeType};base64,${body.toString("base64")}`, source, polarity: example.polarity,
      sourceHint: "UPLOAD", ...(example.rule.description.trim() ? { note: example.rule.description.trim() } : {}) });
    audit.push({ assetId: asset.id, sha256: meta.sha256, source, polarity: example.polarity });
  }
  return { referenceImages, audit };
}
