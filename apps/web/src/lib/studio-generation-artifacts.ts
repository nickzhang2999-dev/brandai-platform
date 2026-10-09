import { prisma, type Prisma } from "@brandai/db";
import { StudioGenerationRetryInput } from "@brandai/contracts";
import { ApiException } from "./api";
import { requireWorkspaceRole } from "./workspace";
import { enqueueStudioArtifact } from "./studio-generation-artifacts-queue";

export const STUDIO_ARTIFACT_ATTEMPT_TTL_MS = 5 * 60_000;
export const STUDIO_ARTIFACT_RUN_MS = 60_000;
export const STUDIO_ARTIFACT_ERROR = "图片已生成，但归档未完成。请重试归档；这不会重新调用图片生成服务。";
export const STUDIO_ARTIFACT_EXPIRED = "原始生成结果已超过恢复期限，无法继续归档。";
type Db = Prisma.TransactionClient;
export type StudioArtifactRequest = { id: string; workspaceId: string; projectId: string; userId: string; generationId: string; status: string };

export function generatedMaterialWhere(workspaceId: string, projectId: string) {
  return { workspaceId, projectId, status: "SUCCEEDED" as const,
    request: { workspaceId, projectId }, output: { workspaceId, projectId },
    version: { generation: { workspaceId, projectId } },
    asset: { workspaceId, deprecatedAt: null, availableForGeneration: true, projectLinks: { some: { projectId, project: { workspaceId } } } } };
}

/** Internal receipt projection: caller must already authorize the request row. */
export async function readStudioGenerationResults(request: StudioArtifactRequest, db: Db = prisma) {
  const [outputs, recoverableOutputs, artifacts, project] = await Promise.all([
    db.studioGenerationOutput.findMany({ where: { requestId: request.id, workspaceId: request.workspaceId, projectId: request.projectId },
      select: { id: true, expiresAt: true }, orderBy: { index: "asc" } }),
    db.studioGenerationOutput.findMany({ where: { requestId: request.id, workspaceId: request.workspaceId, projectId: request.projectId, imageUrl: { not: null }, expiresAt: { gt: new Date() } }, select: { id: true } }),
    db.studioGeneratedMaterial.findMany({ where: { requestId: request.id, workspaceId: request.workspaceId, projectId: request.projectId },
      include: { asset: { select: { id: true, workspaceId: true, deprecatedAt: true, availableForGeneration: true, generationVersionId: true, projectLinks: { where: { projectId: request.projectId }, select: { id: true } } } },
        version: { select: { generationId: true } } }, orderBy: { createdAt: "asc" } }),
    db.project.findFirst({ where: { id: request.projectId, workspaceId: request.workspaceId }, select: { archivedAt: true } }),
  ]);
  const results = artifacts.flatMap(row => {
    if (!project || row.status !== "SUCCEEDED" || !row.versionId || !row.assetId || !row.asset || row.asset.deprecatedAt || !row.asset.availableForGeneration || row.asset.workspaceId !== request.workspaceId || !row.asset.projectLinks.length || row.asset.generationVersionId !== row.versionId || row.version?.generationId !== request.generationId || !row.sha256 || !/^[a-f0-9]{64}$/.test(row.sha256) || !row.width || !row.height || !row.mimeType || !["image/png", "image/jpeg", "image/webp"].includes(row.mimeType)) return [];
    return [{ versionId: row.versionId, assetId: row.assetId, assetSha256: row.sha256, width: row.width, height: row.height, mimeType: row.mimeType,
      url: `/api/workspaces/${request.workspaceId}/assets/${row.assetId}/raw` }];
  });
  const now = Date.now();
  const expired = outputs.some(o => o.expiresAt.getTime() <= now && !artifacts.some(a => a.outputId === o.id && a.status === "SUCCEEDED"));
  const broken = artifacts.some(a => a.status === "FAILED" || (["PENDING", "RUNNING"].includes(a.status) && a.expiresAt.getTime() <= now) || (a.status === "SUCCEEDED" && !results.some(r => r.versionId === a.versionId)));
  const resultState = results.length > 0 && results.length === outputs.length ? "READY"
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

/** Recheck writer membership inside the same transaction as publication. */
export async function requireArtifactWrite(db: Db, workspaceId: string, projectId: string, userId: string) {
  const project = await db.$queryRaw<Array<{ archivedAt: Date | null }>>`SELECT "archivedAt" FROM "Project" WHERE "id" = ${projectId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
  if (!project[0] || project[0].archivedAt) throw new ApiException(409, "项目已归档或删除，生成图片尚未添加到项目。");
  const workspace = await db.brandWorkspace.findUnique({ where: { id: workspaceId }, select: { ownerId: true } });
  const membership = workspace?.ownerId === userId ? null : await db.membership.findUnique({ where: { userId_workspaceId: { userId, workspaceId } }, select: { role: true } });
  if (!workspace || (workspace.ownerId !== userId && !["OWNER", "EDITOR"].includes(membership?.role ?? ""))) throw new ApiException(403, "生成任务的编辑权限已变更，未添加图片。");
}

/** Persist outbox rows first. Only private provider output is consumed here. */
export async function ensureStudioGenerationArtifacts(requestId: string) {
  const rows = await prisma.$transaction(async tx => {
    const request = await tx.studioGenerationRequest.findUnique({ where: { id: requestId }, include: { generation: { select: { workspaceId: true, projectId: true } } } });
    if (!request || request.status !== "SUCCEEDED" || request.generation.workspaceId !== request.workspaceId || request.generation.projectId !== request.projectId) return [];
    await requireArtifactWrite(tx, request.workspaceId, request.projectId, request.userId);
    const outputs = await tx.studioGenerationOutput.findMany({ where: { requestId, workspaceId: request.workspaceId, projectId: request.projectId, imageUrl: { not: null }, expiresAt: { gt: new Date() } }, select: { id: true, expiresAt: true } });
    const pending = [];
    for (const output of outputs) {
      const row = await tx.studioGeneratedMaterial.upsert({ where: { outputId: output.id }, update: {}, create: {
        outputId: output.id, requestId, workspaceId: request.workspaceId, projectId: request.projectId, userId: request.userId,
        objectKey: `${request.workspaceId}/studio-generated/${request.projectId}/${output.id}`,
        expiresAt: new Date(Math.min(Date.now() + STUDIO_ARTIFACT_ATTEMPT_TTL_MS, output.expiresAt.getTime())),
      } });
      if (row.status === "PENDING" && row.expiresAt.getTime() > Date.now()) pending.push(row);
    }
    return pending;
  }, { timeout: 10_000 });
  await Promise.all(rows.map(row => enqueueStudioArtifact(row.outputId, row.expiresAt)));
}

/** Explicit retry never changes Generation, quota, or the provider request. */
export async function retryStudioGenerationArtifacts(workspaceId: string, userId: string, raw: unknown) {
  const input = StudioGenerationRetryInput.parse(raw);
  await requireWorkspaceRole(workspaceId, userId, "EDITOR");
  const request = await prisma.$transaction(async tx => {
    await requireArtifactWrite(tx, workspaceId, input.projectId, userId);
    const row = await tx.studioGenerationRequest.findFirst({ where: { id: input.requestId, workspaceId, projectId: input.projectId, userId },
      include: { outputs: { where: { imageUrl: { not: null }, expiresAt: { gt: new Date() } }, select: { id: true, expiresAt: true } } } });
    if (!row) throw new ApiException(404, "生成任务不存在。");
    if (row.status !== "SUCCEEDED") throw new ApiException(409, "生成尚未成功，暂时没有可归档的结果。");
    const recoverable = row.outputs;
    if (!recoverable.length) throw new ApiException(409, STUDIO_ARTIFACT_EXPIRED);
    for (const output of recoverable) {
      await tx.studioGeneratedMaterial.updateMany({ where: { outputId: output.id, requestId: row.id,
        OR: [{ status: "FAILED" }, { status: { in: ["PENDING", "RUNNING"] }, expiresAt: { lte: new Date() } }] },
        data: { status: "PENDING", error: null, attemptToken: null, startedAt: null,
          expiresAt: new Date(Math.min(Date.now() + STUDIO_ARTIFACT_ATTEMPT_TTL_MS, output.expiresAt.getTime())) } });
    }
    return row;
  }, { timeout: 10_000 });
  await ensureStudioGenerationArtifacts(request.id);
  return readStudioGenerationResults(request);
}
