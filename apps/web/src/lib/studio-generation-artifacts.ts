import { prisma, type Prisma } from "@brandai/db";
import { StudioGenerationRetryInput } from "@brandai/contracts";
import { ApiException } from "./api";
import { requireWorkspaceRole } from "./workspace";
import { enqueueStudioArtifact } from "./studio-generation-artifacts-queue";
import { projectStudioGenerationResults, studioArtifactViewSelect, STUDIO_ARTIFACT_EXPIRED } from "./studio-generation-result-view";
export { STUDIO_ARTIFACT_ERROR, STUDIO_ARTIFACT_EXPIRED } from "./studio-generation-result-view";

export const STUDIO_ARTIFACT_ATTEMPT_TTL_MS = 5 * 60_000;
export const STUDIO_ARTIFACT_RUN_MS = 60_000;
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
      select: studioArtifactViewSelect, orderBy: { createdAt: "asc" } }),
    db.project.findFirst({ where: { id: request.projectId, workspaceId: request.workspaceId }, select: { archivedAt: true } }),
  ]);
  return projectStudioGenerationResults(request, { outputs, recoverableOutputs, artifacts, project });
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
