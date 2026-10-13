import { prisma, Prisma } from "@brandai/db";
import { StudioGeneratedPsdQuery, StudioGeneratedPsdView, STUDIO_GENERATION_OUTPUT_TTL_MS } from "@brandai/contracts";
import { ApiException } from "./api";
import { requireWorkspaceRole } from "./workspace";
import { submitGeneratedStudioDecomposition, readStudioDecompositions } from "./studio-decomposition";
import { generatedPsdLayerCount, generatedPsdMutationId, generatedPsdOutbox, type GeneratedPsdOutbox } from "./studio-generated-psd-state";
import { z } from "zod";
import { assertStudioPsdBudget, StudioPsdEncodingError } from "./studio-psd-codec";

type Generation = Prisma.StudioGenerationRequestGetPayload<object>;
type Outbox = z.infer<typeof GeneratedPsdOutbox>;

/** Keep the selected layer count/accepted source snapshot immutable. Only the
 * terminal continuation journal changes after the image request has ended. */
async function storeOutbox(requestId: string, next: Outbox) {
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "StudioGenerationRequest" WHERE "id"=${requestId} FOR UPDATE`;
    const row = await tx.studioGenerationRequest.findUnique({ where: { id: requestId } });
    if (!row || generatedPsdLayerCount(row.jobData) === null) return;
    const before = generatedPsdOutbox(row.jobData);
    if (!before.success || before.data.status !== "PENDING") return;
    await tx.studioGenerationRequest.update({ where: { id: row.id },
      data: { jobData: { ...(row.jobData as Prisma.JsonObject), studioGeneratedPsd: next } as Prisma.InputJsonValue } });
  }, { timeout: 10_000 });
}

/** Worker-only continuation. Merely reading the receipt never enqueues work. */
export async function registerStudioGeneratedPsd(requestId: string) {
  const row = await prisma.studioGenerationRequest.findUnique({ where: { id: requestId } });
  if (!row || generatedPsdLayerCount(row.jobData) === null) return;
  const outbox = generatedPsdOutbox(row.jobData);
  if (!outbox.success || outbox.data.status !== "PENDING") return;
  // A crash can occur between committing the decomposition and linking the
  // receipt. Recover the existing identity before checking a later permission,
  // source retirement, storage failure or deadline; never pay a second time.
  const registered = await prisma.studioDecompositionRequest.findUnique({ where: { workspaceId_userId_projectId_mutationId: {
    workspaceId: row.workspaceId, userId: row.userId, projectId: row.projectId, mutationId: generatedPsdMutationId(row.id, row.mutationId),
  } }, select: { id: true, layerCount: true } });
  if (registered && registered.layerCount === generatedPsdLayerCount(row.jobData)) {
    await storeOutbox(row.id, { status: "REGISTERED", decompositionRequestId: registered.id, error: null }); return;
  }
  if (row.status === "FAILED") {
    await storeOutbox(row.id, { status: "FAILED", decompositionRequestId: null, error: "原图片生成未完成，未调用分层模型。" }); return;
  }
  if (row.status !== "SUCCEEDED") return;
  if (row.createdAt.getTime() + STUDIO_GENERATION_OUTPUT_TTL_MS <= Date.now()) {
    await storeOutbox(row.id, { status: "FAILED", decompositionRequestId: null, error: "自动 PSD 准备超过受理期限。原图片保留，系统不会自动重新调用模型。" }); return;
  }
  const material = await prisma.studioGeneratedMaterial.findFirst({ where: { requestId: row.id, workspaceId: row.workspaceId, projectId: row.projectId, userId: row.userId }, orderBy: { createdAt: "asc" } });
  if (!material || ["PENDING", "RUNNING"].includes(material.status)) return;
  if (material.status !== "SUCCEEDED") {
    await storeOutbox(row.id, { status: "FAILED", decompositionRequestId: null, error: "原图片尚未保存成功，未调用分层模型。图片归档成功后可手动分层。" }); return;
  }
  try {
    const decomposition = await submitGeneratedStudioDecomposition(row.id);
    await storeOutbox(row.id, { status: "REGISTERED", decompositionRequestId: decomposition.requestId, error: null });
  } catch (error) {
    // Queue capacity is transient. Preserve the same intent/UUID until its
    // bound expires. Unknown DB errors also leave the outbox recoverable.
    if (!(error instanceof ApiException) || error.status === 429) return;
    await storeOutbox(row.id, { status: "FAILED", decompositionRequestId: null,
      error: error.status === 403 ? "品牌编辑权限已变化，自动 PSD 已停止，原图片保留。"
        : error.status === 404 ? "原图片或项目已不可用，自动 PSD 已停止。"
        : error.status === 422 && error.message.includes("PSD") ? "图片尺寸与层数超过 PSD 导出预算，未调用分层模型。请选择更少图层或更小尺寸，原图片保留。"
        : "原图片未满足安全分层要求，自动 PSD 已停止。严格保留素材不会被分层模型重画，原图片保持不变。" });
  }
}

export async function dispatchStudioGeneratedPsds() {
  // A bounded DB outbox lives with the accepted generation, even if no user
  // reopens the page. Registered jobs recover via the existing layer sweeper.
  const rows = await prisma.studioGenerationRequest.findMany({ where: {
    status: { in: ["SUCCEEDED", "FAILED"] }, jobData: { path: ["studioGeneratedPsd", "status"], equals: "PENDING" },
  }, select: { id: true }, take: 32, orderBy: { createdAt: "asc" } });
  await Promise.allSettled(rows.map(row => registerStudioGeneratedPsd(row.id)));
}

export async function readStudioGeneratedPsd(workspaceId: string, userId: string, raw: unknown) {
  const input = StudioGeneratedPsdQuery.parse(raw);
  await requireWorkspaceRole(workspaceId, userId, "VIEWER");
  if (!await prisma.project.findFirst({ where: { id: input.projectId, workspaceId }, select: { id: true } })) throw new ApiException(404, "项目不存在。");
  const row: Generation | null = await prisma.studioGenerationRequest.findFirst({ where: { id: input.requestId, workspaceId, userId, projectId: input.projectId } });
  if (!row) throw new ApiException(404, "生成请求不存在。");
  const base = { projectId: input.projectId, requestId: input.requestId, requested: generatedPsdLayerCount(row.jobData) !== null, error: null, decomposition: null, downloadUrl: null };
  if (!base.requested) return StudioGeneratedPsdView.parse({ ...base, status: "NOT_REQUESTED" });
  const outbox = generatedPsdOutbox(row.jobData);
  if (!outbox.success) return StudioGeneratedPsdView.parse({ ...base, status: "FAILED", error: "自动 PSD 受理记录不完整，请联系管理员核对。原图片保留。" });
  if (outbox.data.status === "FAILED") return StudioGeneratedPsdView.parse({ ...base, status: "FAILED", error: outbox.data.error });
  if (outbox.data.status === "REGISTERED" && outbox.data.decompositionRequestId) {
    const decomposition = await readStudioDecompositions(workspaceId, userId, { projectId: input.projectId, requestId: outbox.data.decompositionRequestId });
    if ("requests" in decomposition) throw new ApiException(503, "自动 PSD 状态暂时不可读取。");
    const ready = decomposition.status === "SUCCEEDED";
    if (ready) {
      try { assertStudioPsdBudget(decomposition.sourceWidth, decomposition.sourceHeight, decomposition.layers.length); }
      catch (error) {
        if (!(error instanceof StudioPsdEncodingError)) throw error;
        return StudioGeneratedPsdView.parse({ ...base, decomposition, status: "FAILED", error: "图层已保存，但尺寸与层数超过当前 PSD 导出内存预算。原图片和独立图层保留。" });
      }
    }
    return StudioGeneratedPsdView.parse({ ...base, decomposition, error: decomposition.error,
      status: ready ? "READY" : decomposition.status,
      downloadUrl: ready ? `/api/workspaces/${workspaceId}/studio/decomposition/${decomposition.requestId}/export?projectId=${input.projectId}&format=psd` : null });
  }
  if (row.status === "FAILED") return StudioGeneratedPsdView.parse({ ...base, status: "FAILED", error: "原图片生成未完成，未调用分层模型。" });
  return StudioGeneratedPsdView.parse({ ...base, status: row.status === "RUNNING" ? "RUNNING" : "PENDING" });
}
