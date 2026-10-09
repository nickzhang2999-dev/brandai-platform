import { prisma, Prisma } from "@brandai/db";
import { STUDIO_GENERATION_OUTPUT_TTL_MS } from "@brandai/contracts";
import { ApiException } from "./api";
import { studioGenerationContextHash, requireStudioGenerationServices, validateStudioOutputSource } from "./studio-generation-policy";
import { requireArtifactWrite } from "./studio-generation-artifacts";
export type StudioRequest = Prisma.StudioGenerationRequestGetPayload<Record<string, never>>;
const genericFailure = "生成未完成，系统不会自动再次调用生成服务。请确认需求后再发起新请求。";

export async function claimStudioGeneration(request: StudioRequest): Promise<StudioRequest | null> {
  try {
    await requireStudioGenerationServices();
    return await prisma.$transaction(async tx => {
      const current = await tx.studioGenerationRequest.findUnique({ where: { id: request.id } });
      if (!current || current.status !== "PENDING" || current.providerStartedAt || current.expiresAt <= new Date()) return null;
      await requireArtifactWrite(tx, current.workspaceId, current.projectId, current.userId);
      const contextHash = await studioGenerationContextHash(tx, current.workspaceId, current.projectId,
        current.jobData as { assetUsages?: {assetId: string}[]; generationId?: string });
      if (contextHash !== current.contextHash) throw new ApiException(409, "Accepted brand rules or image sources changed; confirm them before a new request.");
      const now = new Date();
      const claimed = await tx.studioGenerationRequest.updateMany({ where: { id: current.id, status: "PENDING", providerStartedAt: null, expiresAt: { gt: now } }, data: { status: "RUNNING", providerStartedAt: now } });
      if (!claimed.count) return null;
      await tx.generation.update({ where: { id: current.generationId }, data: { status: "RUNNING", startedAt: now, error: null } });
      return { ...current, status: "RUNNING" as const, providerStartedAt: now };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000 });
  } catch (error) {
    // A transaction conflict before claim has not invoked a provider. Keep it
    // PENDING for the DB outbox rather than converting contention to failure.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") throw error;
    const message = error instanceof ApiException ? error.message : genericFailure;
    await prisma.$transaction(async tx => {
      const changed = await tx.studioGenerationRequest.updateMany({ where: { id: request.id, status: "PENDING", providerStartedAt: null }, data: { status: "FAILED", error: message } });
      if (changed.count) await tx.generation.updateMany({ where: { id: request.generationId }, data: { status: "FAILED", error: message, finishedAt: new Date() } });
    });
    return null;
  }
}

export async function finishStudioGeneration(request: StudioRequest, status: "FAILED" | "SUCCEEDED", error?: unknown): Promise<boolean> {
  return prisma.$transaction(async tx => {
    const now = new Date();
    const current = await tx.studioGenerationRequest.findUnique({ where: { id: request.id } });
    if (current?.status === "SUCCEEDED" && current.providerStartedAt?.getTime() === request.providerStartedAt?.getTime()) return status === "SUCCEEDED";
    // Success can only be committed with a private result in stage(), never by
    // a worker that got no output. A late or duplicate worker cannot resurrect.
    if (status === "SUCCEEDED") return false;
    const message = error instanceof ApiException ? error.message : genericFailure;
    const changed = await tx.studioGenerationRequest.updateMany({ where: { id: request.id, status: "RUNNING", providerStartedAt: request.providerStartedAt }, data: { status: "FAILED", error: message } });
    if (!changed.count) return false;
    await tx.generation.updateMany({ where: { id: request.generationId }, data: { status: "FAILED", error: message, finishedAt: now, durationMs: now.getTime() - (request.providerStartedAt?.getTime() ?? now.getTime()) } });
    await tx.studioGenerationOutput.updateMany({ where: { requestId: request.id }, data: { imageUrl: null } });
    return true;
  });
}

/** Commit paid output and its terminal receipt atomically. A crash immediately
 * after this commit is recovered by archive discovery without paying again. */
export async function stageStudioGenerationOutput(request: StudioRequest, output: { imageUrl: string; width: number; height: number; params: Record<string, unknown> }, index: number) {
  if (index !== 0) throw new Error("产品生成只接受一个输出。");
  const retention = validateStudioOutputSource(output.imageUrl);
  const id = `${request.id}-0`;
  return prisma.$transaction(async tx => {
    await requireArtifactWrite(tx, request.workspaceId, request.projectId, request.userId);
    const now = new Date();
    const updated = await tx.studioGenerationRequest.updateMany({ where: { id: request.id, status: "RUNNING", providerStartedAt: request.providerStartedAt, expiresAt: { gt: now } },
      data: { status: "SUCCEEDED", error: null } });
    if (!updated.count) throw new Error("生成任务已结束或超时，未接收迟到结果。");
    await tx.studioGenerationOutput.create({ data: { id, requestId: request.id, workspaceId: request.workspaceId, projectId: request.projectId,
      imageUrl: output.imageUrl, widthHint: output.width, heightHint: output.height, index,
      params: { ...output.params, studioSourceRetention: retention } as Prisma.InputJsonValue,
      expiresAt: new Date(now.getTime() + STUDIO_GENERATION_OUTPUT_TTL_MS) } });
    await tx.generation.update({ where: { id: request.generationId }, data: { status: "SUCCEEDED", error: null, finishedAt: now, durationMs: now.getTime() - request.providerStartedAt!.getTime() } });
    return id;
  }, { timeout: 15_000 });
}
