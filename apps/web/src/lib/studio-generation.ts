import { randomUUID } from "node:crypto";
import { prisma, Prisma } from "@brandai/db";
import { StudioGenerationInput, StudioGenerationQuery, StudioGenerationView, STUDIO_GENERATION_TTL_MS } from "@brandai/contracts";
import { ApiException } from "./api";
import { requireWorkspaceRole } from "./workspace";
import { requireStudioMaterialProject } from "./studio-materials";
import { prepareStudioGeneration, requireStudioGenerationServices, hashStudioPayload, assertStudioGenerationCapacity } from "./studio-generation-policy";
import { reserveGenerationQuotaInTransaction } from "./quota";
import { enqueueStudioGeneration } from "./studio-generation-queue";
import { readStudioGenerationResults } from "./studio-generation-artifacts";
import type { GenerateJobData } from "./workers/generate.worker";
type Receipt = Prisma.StudioGenerationRequestGetPayload<Record<string, never>>;

async function receipt(row: Receipt, canWrite = true) {
  const results = await readStudioGenerationResults(row);
  return StudioGenerationView.parse({ mode: (row.jobData as {studioEdit?: unknown})?.studioEdit ? "modify" : "generate", requestId: row.id, mutationId: row.mutationId, projectId: row.projectId, generationId: row.generationId,
    status: row.status, progress: null, expiresAt: row.expiresAt.toISOString(), displayText: row.prompt, error: row.error,
    ...results, canRetryArchive: canWrite && results.canRetryArchive });
}

export async function expireStudioGenerations() {
  return prisma.$transaction(async tx => {
    const rows = await tx.studioGenerationRequest.findMany({ where: { status: { in: ["PENDING", "RUNNING"] }, expiresAt: { lte: new Date() } }, take: 100 });
    for (const row of rows) {
      const error = row.providerStartedAt ? "生成任务超时，结果未确认；系统不会自动再次调用生成服务。" : "生成任务排队超时，请重新提交。";
      const changed = await tx.studioGenerationRequest.updateMany({ where: { id: row.id, status: { in: ["PENDING", "RUNNING"] }, expiresAt: { lte: new Date() } }, data: { status: "FAILED", error } });
      if (changed.count) {
        await tx.generation.updateMany({ where: { id: row.generationId }, data: { status: "FAILED", error, finishedAt: new Date() } });
        await tx.studioGenerationOutput.updateMany({ where: { requestId: row.id }, data: { imageUrl: null } });
      }
    }
  });
}

export async function submitStudioGeneration(workspaceId: string, userId: string, raw: unknown) {
  await requireWorkspaceRole(workspaceId, userId, "EDITOR");
  const input = StudioGenerationInput.parse(raw);
  await requireStudioMaterialProject(workspaceId, userId, input.projectId, true);
  const identity = { workspaceId, userId, projectId: input.projectId, mutationId: input.mutationId };
  const payloadHash = hashStudioPayload(input);
  const replay = await prisma.studioGenerationRequest.findUnique({ where: { workspaceId_userId_projectId_mutationId: identity } });
  if (replay) {
    if (replay.payloadHash !== payloadHash) throw new ApiException(409, "同一次生成请求不能改成其他内容，请重新提交。");
    return readStudioGeneration(workspaceId, userId, { projectId: input.projectId, requestId: replay.id });
  }
  await requireStudioGenerationServices();
  await expireStudioGenerations();
  let row: Receipt | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      row = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(20261009, 2)`;
        const duplicate = await tx.studioGenerationRequest.findUnique({ where: { workspaceId_userId_projectId_mutationId: identity } });
        if (duplicate) {
          if (duplicate.payloadHash !== payloadHash) throw new ApiException(409, "生成请求标识已用于其他内容。");
          return duplicate;
        }
        const unfinished: Prisma.StudioGenerationRequestWhereInput = { OR: [{ status: { in: ["PENDING", "RUNNING"] } }, { outputs: { some: { imageUrl: { not: null } } } }] };
        const [local, global] = await Promise.all([tx.studioGenerationRequest.count({ where: { ...unfinished, workspaceId } }), tx.studioGenerationRequest.count({ where: unfinished })]);
        assertStudioGenerationCapacity(local, global);
        const prepared = await prepareStudioGeneration(tx, workspaceId, userId, input);
        const generation = await reserveGenerationQuotaInTransaction(tx, { workspaceId, make: () => prepared.generationData });
        const id = "sgr_" + randomUUID().replace(/-/g, "");
        return tx.studioGenerationRequest.create({ data: { id, ...identity, payloadHash, prompt: input.prompt,
          sizeSelection: input.sizeSelection as Prisma.InputJsonValue, workflowRevision: input.workflowRevision, documentRevision: input.documentRevision,
          generationId: generation.id, contextHash: prepared.contextHash,
          jobData: { ...prepared.jobData, generationId: generation.id } as unknown as Prisma.InputJsonValue,
          expiresAt: new Date(Date.now() + STUDIO_GENERATION_TTL_MS) } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000 });
      break;
    } catch (error) {
      if (attempt < 2 && error instanceof Prisma.PrismaClientKnownRequestError && ["P2034", "P2002"].includes(error.code)) continue;
      throw error;
    }
  }
  if (!row) throw new ApiException(503, "生成请求未完成受理，请稍后重试。");
  if (row.status === "PENDING") await enqueueStudioGeneration(row.id, row.jobData as unknown as GenerateJobData);
  return receipt(row);
}

export async function readStudioGeneration(workspaceId: string, userId: string, raw: unknown) {
  const { projectId, requestId } = StudioGenerationQuery.parse(raw);
  const { role } = await requireWorkspaceRole(workspaceId, userId, "VIEWER");
  if (!await prisma.project.findFirst({ where: { id: projectId, workspaceId }, select: { id: true } })) throw new ApiException(404, "项目不存在。");
  await expireStudioGenerations();
  const rows = await prisma.studioGenerationRequest.findMany({ where: { workspaceId, userId, projectId, ...(requestId ? { id: requestId } : {}) }, orderBy: { createdAt: "desc" }, take: requestId ? 1 : 50 });
  const canWrite = role === "OWNER" || role === "EDITOR";
  if (requestId) { if (!rows[0]) throw new ApiException(404, "生成请求不存在。"); return receipt(rows[0], canWrite); }
  return { requests: await Promise.all(rows.map(row => receipt(row, canWrite))) };
}

/** Durable DB outbox recovery: jobs have stable IDs and a single provider claim. */
export async function dispatchStudioGenerations() {
  await expireStudioGenerations();
  const pending = await prisma.studioGenerationRequest.findMany({ where: { status: "PENDING", providerStartedAt: null, expiresAt: { gt: new Date() } }, take: 32, orderBy: { createdAt: "asc" } });
  await Promise.all(pending.map(row => enqueueStudioGeneration(row.id, row.jobData as unknown as GenerateJobData)));
}
