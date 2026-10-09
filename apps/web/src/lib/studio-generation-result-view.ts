import type { Prisma } from "@brandai/db";

export const STUDIO_ARTIFACT_ERROR = "图片已生成，但归档未完成。请重试归档；这不会重新调用图片生成服务。";
export const STUDIO_ARTIFACT_EXPIRED = "原始生成结果已超过恢复期限，无法继续归档。";

/** Shared, metadata-only projection. Never select the private provider body. */
export const studioArtifactViewSelect = {
  outputId: true, workspaceId: true, projectId: true, status: true, versionId: true, assetId: true, sha256: true,
  width: true, height: true, mimeType: true, expiresAt: true, updatedAt: true,
  asset: { select: { id: true, workspaceId: true, deprecatedAt: true, availableForGeneration: true,
    generationVersionId: true, projectLinks: { select: { id: true, projectId: true } } } },
  version: { select: { generationId: true } },
} satisfies Prisma.StudioGeneratedMaterialSelect;
type Artifact = Prisma.StudioGeneratedMaterialGetPayload<{ select: typeof studioArtifactViewSelect }>;

export function projectStudioGenerationResults(
  request: { workspaceId: string; projectId: string; generationId: string; status: string },
  state: {
    outputs: Array<{ id: string; expiresAt: Date }>;
    artifacts: Artifact[];
    project: { archivedAt: Date | null } | null;
    recoverableOutputs?: Array<{ id: string }>;
  },
  now = Date.now(),
) {
  const { outputs, artifacts, project, recoverableOutputs = [] } = state;
  const outputIds = new Set(outputs.map(output => output.id));
  const publishedOutputIds = new Set<string>();
  const results = artifacts.flatMap(row => {
    if (!project || !outputIds.has(row.outputId) || row.workspaceId !== request.workspaceId || row.projectId !== request.projectId || row.status !== "SUCCEEDED" || !row.versionId || !row.assetId || !row.asset || row.asset.deprecatedAt || !row.asset.availableForGeneration || row.asset.workspaceId !== request.workspaceId || !row.asset.projectLinks.some(link => link.projectId === request.projectId) || row.asset.generationVersionId !== row.versionId || row.version?.generationId !== request.generationId || !row.sha256 || !/^[a-f0-9]{64}$/.test(row.sha256) || !Number.isSafeInteger(row.width) || (row.width ?? 0) <= 0 || !Number.isSafeInteger(row.height) || (row.height ?? 0) <= 0 || !row.mimeType || !["image/png", "image/jpeg", "image/webp"].includes(row.mimeType)) return [];
    publishedOutputIds.add(row.outputId);
    return [{ versionId: row.versionId, assetId: row.assetId, assetSha256: row.sha256, width: row.width, height: row.height, mimeType: row.mimeType,
      url: `/api/workspaces/${request.workspaceId}/assets/${row.assetId}/raw` }];
  });
  const expired = outputs.some(o => o.expiresAt.getTime() <= now && !artifacts.some(a => a.outputId === o.id && a.status === "SUCCEEDED"));
  const broken = artifacts.some(a => a.status === "FAILED" || (["PENDING", "RUNNING"].includes(a.status) && a.expiresAt.getTime() <= now) || (a.status === "SUCCEEDED" && !results.some(r => r.versionId === a.versionId)));
  const resultState = results.length > 0 && results.length === outputs.length && outputs.every(output => publishedOutputIds.has(output.id)) ? "READY"
    : expired || broken || (outputs.length > 0 && (!project || project.archivedAt)) || (request.status === "SUCCEEDED" && !outputs.length) ? "FAILED"
    : artifacts.some(a => a.status === "RUNNING") ? "RUNNING"
    : outputs.length ? "PENDING" : "NOT_REQUESTED";
  const retryable = recoverableOutputs.some(o => !artifacts.some(a => a.outputId === o.id && a.status === "SUCCEEDED"));
  const active = artifacts.filter(a => ["PENDING", "RUNNING"].includes(a.status) && a.expiresAt.getTime() > now);
  return { resultState, results, archiveError: resultState === "FAILED" ? (expired ? STUDIO_ARTIFACT_EXPIRED : STUDIO_ARTIFACT_ERROR) : null,
    canRetryArchive: resultState === "FAILED" && !!project && !project.archivedAt && retryable,
    archiveExpiresAt: outputs.length ? new Date(Math.min(...outputs.map(o => o.expiresAt.getTime()))).toISOString() : null,
    archiveProcessingExpiresAt: active.length ? new Date(Math.min(...active.map(a => a.expiresAt.getTime()))).toISOString() : null };
}
