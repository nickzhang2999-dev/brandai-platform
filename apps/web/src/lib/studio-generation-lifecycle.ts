import { prisma, Prisma } from "@brandai/db";
import { STUDIO_IMAGE_RECEIPT_RECOVERY_MS } from "@brandai/contracts";
import { STUDIO_GENERATION_OUTPUT_TTL_MS, STUDIO_GENERATION_TTL_MS, STUDIO_GENERATION_COMMIT_GRACE_MS } from "@brandai/contracts";
import { ApiException } from "./api";
import { AiServiceFailure, StudioImageReceiptUnavailable } from "./ai-failure";
import { studioGenerationContextHash, requireStudioGenerationServices, validateStudioOutputSource } from "./studio-generation-policy";
import { requireArtifactWrite } from "./studio-generation-artifacts";
import { studioEditSourceFailureReason } from "./studio-generation-edit";
export type StudioRequest = Prisma.StudioGenerationRequestGetPayload<Record<string, never>>;
function publicFailure(error: unknown): string {
  if (error instanceof StudioImageReceiptUnavailable) return new StudioImageReceiptUnavailable().message;
  if (error instanceof AiServiceFailure) return new AiServiceFailure(error.info).message;
  if (error instanceof ApiException) return error.message;
  // Only recognize our own guarded transport message. Never persist provider
  // response bodies, request URLs, tokens, stack traces, or arbitrary errors.
  const code = error instanceof Error ? /^图片服务请求失败（HTTP (\d{3})），请稍后重试或联系管理员。$/.exec(error.message)?.[1] : undefined;
  if (code && ["502", "503", "504"].includes(code)) return "生成服务暂时异常，本次请求未完成。系统不会自动重新生成；请稍后检查任务结果。";
  if (code === "429") return "生成服务暂时限制请求，本次请求未完成。系统不会自动重新生成；请稍后再试。";
  if (code === "401" || code === "403") return "生成服务授权异常，本次请求未完成。请联系管理员检查配置。";
  return "本次生成未完成，具体原因尚未确认。需求仍保留，系统不会自动重新生成。";
}
function recordEditSourceFailure(requestId: string, stage: "claim" | "preflight" | "finish", error: unknown) {
  const reasonCode = studioEditSourceFailureReason(error);
  if (reasonCode) console.warn("[studio-generation] edit source validation rejected", {
    requestId: /^sgr_[a-f0-9]{32}$/.test(requestId) ? requestId : "unavailable", stage, reasonCode,
  });
  return reasonCode;
}

async function claimOnce(request: StudioRequest) {
  return prisma.$transaction(async tx => {
    const current = await tx.studioGenerationRequest.findUnique({ where: { id: request.id } });
    if (!current || current.status !== "PENDING" || current.providerStartedAt || current.expiresAt <= new Date()) return null;
    await requireArtifactWrite(tx, current.workspaceId, current.projectId, current.userId);
    const contextHash = await studioGenerationContextHash(tx, current.workspaceId, current.projectId,
      current.jobData as { assetUsages?: {assetId: string}[]; generationId?: string });
    if (contextHash !== current.contextHash) throw new ApiException(409, "Accepted brand rules or image sources changed; confirm them before a new request.");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + STUDIO_GENERATION_TTL_MS);
    const claimed = await tx.studioGenerationRequest.updateMany({ where: { id: current.id, status: "PENDING", providerStartedAt: null, expiresAt: { gt: now } }, data: { status: "RUNNING", providerStartedAt: now, expiresAt } });
    if (!claimed.count) return null;
    await tx.generation.update({ where: { id: current.generationId }, data: { status: "RUNNING", startedAt: now, error: null } });
    return { ...current, status: "RUNNING" as const, providerStartedAt: now, expiresAt };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000 });
}

export async function claimStudioGeneration(request: StudioRequest): Promise<StudioRequest | null> {
  try {
    await requireStudioGenerationServices();
    for (let attempt = 0; ; attempt++) {
      try {
        return await claimOnce(request);
      } catch (error) {
        // PostgreSQL has rolled the transaction back. This scope ends before any model call.
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2034" || attempt >= 3) throw error;
        const windowMs = 20 * 2 ** attempt;
        await new Promise(resolve => setTimeout(resolve, windowMs + Math.random() * windowMs));
      }
    }
  } catch (error) {
    // A transaction conflict before claim has not invoked a provider. Keep it
    // PENDING for the DB outbox rather than converting contention to failure.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") throw error;
    recordEditSourceFailure(request.id, "claim", error);
    const message = publicFailure(error);
    await prisma.$transaction(async tx => {
      const changed = await tx.studioGenerationRequest.updateMany({ where: { id: request.id, status: "PENDING", providerStartedAt: null }, data: { status: "FAILED", error: message } });
      if (changed.count) await tx.generation.updateMany({ where: { id: request.generationId }, data: { status: "FAILED", error: message, finishedAt: new Date() } });
    });
    return null;
  }
}

/** Source I/O and text precheck can outlive the initial claim check. Revalidate
 * immediately before external work without consulting later canvas revisions.
 * This is a fence, never a new claim and never permission to replay a provider. */
export async function assertStudioGenerationReady(request: StudioRequest, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await prisma.$transaction(async tx => {
    await requireArtifactWrite(tx, request.workspaceId, request.projectId, request.userId);
    await tx.$queryRaw`SELECT "id" FROM "StudioGenerationRequest" WHERE "id" = ${request.id} FOR UPDATE`;
    const current = await tx.studioGenerationRequest.findUnique({ where: { id: request.id } });
    if (!current || current.status !== "RUNNING" || !request.providerStartedAt ||
      current.providerStartedAt?.getTime() !== request.providerStartedAt.getTime() ||
      current.workspaceId !== request.workspaceId || current.projectId !== request.projectId ||
      current.userId !== request.userId || current.generationId !== request.generationId ||
      current.contextHash !== request.contextHash || current.expiresAt.getTime() <= Date.now()) {
      throw new ApiException(409, "生成任务已结束、过期或执行身份已变更，未调用生成服务。请确认后重新提交。");
    }
    if(current.jobData && typeof current.jobData==="object" && "solReference" in current.jobData){
      const {SolReferenceKey}=await import("@brandai/contracts");
      const key=SolReferenceKey.parse(current.jobData.solReference);
      const {liveSourceCards}=await import("./sol-poster-references");
      if(!(await liveSourceCards(tx,current.workspaceId,current.projectId,[key])).length)
        throw new ApiException(409,"参考来源已更新或撤回，请重新确认简报。");
    }
    let contextHash: string;
    try {
      contextHash = await studioGenerationContextHash(tx, current.workspaceId, current.projectId,
        current.jobData as { assetUsages?: {assetId: string}[]; generationId?: string });
    } catch (error) {
      const sourceReason = recordEditSourceFailure(current.id, "preflight", error);
      if (error instanceof ApiException && error.status === 422) {
        throw new ApiException(409, sourceReason
          ? "修改目标在准备期间无法通过来源校验，未调用生成服务。请重新选择图片后提交。"
          : "参与素材在准备期间已删除、停用或移出项目，未调用生成服务。请确认后重新提交。");
      }
      throw error;
    }
    if (contextHash !== request.contextHash) {
      throw new ApiException(409, "品牌规则或参与素材在准备期间发生变更，未调用生成服务。请确认后重新提交。");
    }
    if (current.expiresAt.getTime() <= Date.now()) throw new ApiException(409, "生成任务已过期，未调用生成服务。请重新提交。");
    signal?.throwIfAborted();
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000 });
  signal?.throwIfAborted();
}

export async function finishStudioGeneration(request: StudioRequest, status: "FAILED" | "SUCCEEDED", error?: unknown): Promise<boolean> {
  const finished = await prisma.$transaction(async tx => {
    const now = new Date();
    const current = await tx.studioGenerationRequest.findUnique({ where: { id: request.id } });
    if (current?.status === "SUCCEEDED" && current.providerStartedAt?.getTime() === request.providerStartedAt?.getTime()) return status === "SUCCEEDED";
    // Success can only be committed with a private result in stage(), never by
    // a worker that got no output. A late or duplicate worker cannot resurrect.
    if (status === "SUCCEEDED") return false;
    const message = publicFailure(error);
    const changed = await tx.studioGenerationRequest.updateMany({ where: { id: request.id, status: "RUNNING", providerStartedAt: request.providerStartedAt }, data: { status: "FAILED", receiptCheckpoint: null, error: message } });
    if (!changed.count) return false;
    await tx.generation.updateMany({ where: { id: request.generationId }, data: { status: "FAILED", error: message, finishedAt: now, durationMs: now.getTime() - (request.providerStartedAt?.getTime() ?? now.getTime()) } });
    await tx.studioGenerationOutput.updateMany({ where: { requestId: request.id }, data: { imageUrl: null } });
    return true;
  });
  if (finished && status === "FAILED") {
    recordEditSourceFailure(request.id, "finish", error);
    if (error instanceof AiServiceFailure) console.warn("[studio-generation] AI request failed", {
      requestId: /^sgr_[a-f0-9]{32}$/.test(request.id) ? request.id : "unavailable",
      code: error.info.code, stage: error.info.stage, upstreamStatus: error.info.upstreamStatus,
    });
  }
  return finished;
}

/** Commit paid output and its terminal receipt atomically. A crash immediately
 * after this commit is recovered by archive discovery without paying again. */
export async function stageStudioGenerationOutput(request: StudioRequest, output: { imageUrl: string; width: number; height: number; params: Record<string, unknown> }, index: number, recoveryCheckpoint?: string) {
  if (index !== 0) throw new Error("产品生成只接受一个输出。");
  const receivedAt = new Date();
  const deadline = new Date(request.expiresAt.getTime() + (recoveryCheckpoint ? STUDIO_IMAGE_RECEIPT_RECOVERY_MS : 0));
  if (!request.providerStartedAt || receivedAt >= deadline) throw new Error("生成结果超过本次执行期限。");
  const retention = validateStudioOutputSource(output.imageUrl);
  const id = `${request.id}-0`;
  return prisma.$transaction(async tx => {
    await requireArtifactWrite(tx, request.workspaceId, request.projectId, request.userId);
    const now = new Date();
    if (now.getTime() >= deadline.getTime() + STUDIO_GENERATION_COMMIT_GRACE_MS) throw new Error("生成结果写入期限已过。");
    const updated = await tx.studioGenerationRequest.updateMany({ where: { id: request.id, workspaceId: request.workspaceId,
      userId: request.userId, projectId: request.projectId, generationId: request.generationId, contextHash: request.contextHash,
      status: "RUNNING", providerStartedAt: request.providerStartedAt,
      ...(recoveryCheckpoint ? { receiptCheckpoint: recoveryCheckpoint, expiresAt: request.expiresAt } : { expiresAt: { gt: receivedAt } }) },
      data: { status: "SUCCEEDED", receiptCheckpoint: null, error: null } });
    if (!updated.count) throw new Error("生成任务已结束或超时，未接收迟到结果。");
    await tx.studioGenerationOutput.create({ data: { id, requestId: request.id, workspaceId: request.workspaceId, projectId: request.projectId,
      imageUrl: output.imageUrl, widthHint: output.width, heightHint: output.height, index,
      params: { ...output.params, studioSourceRetention: retention } as Prisma.InputJsonValue,
      expiresAt: new Date(now.getTime() + STUDIO_GENERATION_OUTPUT_TTL_MS) } });
    await tx.generation.update({ where: { id: request.generationId }, data: { status: "SUCCEEDED", error: null, finishedAt: now, durationMs: now.getTime() - request.providerStartedAt!.getTime() } });
    return id;
  }, { timeout: 15_000 });
}
