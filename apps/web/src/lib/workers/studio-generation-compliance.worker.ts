import { Worker, type Job } from "bullmq";
import { prisma, Prisma } from "@brandai/db";
import { ComplianceCheckRequest, ComplianceCheckResponse } from "@brandai/contracts";
import { connection, queuePrefix } from "@/lib/queue";
import { ApiException } from "@/lib/api";
import { ai } from "@/lib/ai";
import { loadTermLib } from "@/lib/compliance";
import { recordUsage } from "@/lib/usage";
import { requireArtifactWrite } from "@/lib/studio-generation-artifacts";
import { artifactDeadline, inspectArtifactImage, readArtifactImageBytes } from "@/lib/studio-generation-artifacts-image";
import { loadStudioComplianceReferences } from "@/lib/studio-generation-compliance-images";
import { complianceObject, dispatchStudioGenerationCompliance, loadStudioComplianceSource, requireStudioVlm,
  STUDIO_COMPLIANCE_ERROR, STUDIO_COMPLIANCE_EXPIRED, STUDIO_COMPLIANCE_KIND, studioComplianceTaskId } from "@/lib/studio-generation-compliance";

type CheckJob = Job<{ taskId: string; jobId: string }>;

/** A claimed VLM attempt is never automatically re-executed after a crash.
 * The durable deadline ends it; only an explicit user retry gets a new token. */
export async function runStudioGenerationComplianceJob(job: CheckJob) {
  const { taskId, jobId } = job.data;
  let claimed = false;
  let providerStarted = false;
  let owner: { workspaceId: string; userId: string; generationId: string } | undefined;
  const startedAt = Date.now();
  try {
    const claim = await prisma.$transaction(async tx => {
      const task = await tx.asyncTask.findUnique({ where: { id: taskId } });
      if (!task || task.kind !== STUDIO_COMPLIANCE_KIND || task.jobId !== jobId || task.status !== "PENDING") return null;
      if (!task.refId || task.id !== studioComplianceTaskId(task.refId) || !task.expiresAt || task.expiresAt.getTime() <= Date.now()) {
        await tx.asyncTask.updateMany({ where: { id: taskId, kind: STUDIO_COMPLIANCE_KIND, jobId, status: "PENDING" },
          data: { status: "FAILED", error: STUDIO_COMPLIANCE_EXPIRED, ...(!task.expiresAt ? { expiresAt: new Date() } : {}) } });
        return null;
      }
      const source = await loadStudioComplianceSource(tx, task.workspaceId, task.refId);
      await requireArtifactWrite(tx, source.row.workspaceId, source.row.projectId, source.row.userId);
      // The VLM has no progress feed: only completion changes 0 to 100.
      const updated = await tx.asyncTask.updateMany({ where: { id: taskId, kind: STUDIO_COMPLIANCE_KIND, jobId, status: "PENDING", expiresAt: { gt: new Date() } }, data: { status: "RUNNING", progress: 0, error: null } });
      return updated.count ? { task, source } : null;
    }, { timeout: 10_000 });
    if (!claim) return;
    claimed = true;
    const { task, source } = claim;
    const { row } = source;
    owner = { workspaceId: row.workspaceId, userId: row.userId, generationId: row.request.generationId };
    const signal = AbortSignal.timeout(Math.max(1, Math.min(5 * 60_000, task.expiresAt!.getTime() - Date.now())));
    await artifactDeadline(requireStudioVlm(), signal);
    // Version/Asset bindings were authorized above; read the private object,
    // never hand a browser-cookie URL or internal S3 URL to the VLM.
    const bytes = await readArtifactImageBytes({ imageUrl: row.asset!.url, objectKey: row.asset!.storageKey }, signal);
    const meta = await inspectArtifactImage(bytes, signal);
    if (meta.sha256 !== row.sha256 || meta.width !== row.width || meta.height !== row.height) throw new ApiException(422, "归档图片内容已发生变化，未执行视觉检查，请联系管理员检查素材。");
    const [termLib, references] = await artifactDeadline(Promise.all([loadTermLib(row.workspaceId), loadStudioComplianceReferences(row.workspaceId, signal, bytes.length)]), signal);
    const request = ComplianceCheckRequest.parse({ imageUrl: `data:${meta.mimeType};base64,${bytes.toString("base64")}`, brandRules: source.brandRules, termLib, referenceImages: references.referenceImages });
    await artifactDeadline(prisma.$transaction(async tx => {
      await requireArtifactWrite(tx, row.workspaceId, row.projectId, row.userId);
      const active = await tx.asyncTask.findUnique({ where: { id: taskId } });
      if (!active || active.kind !== STUDIO_COMPLIANCE_KIND || active.status !== "RUNNING" || active.jobId !== jobId || !active.expiresAt || active.expiresAt.getTime() <= Date.now()) throw new ApiException(409, "检查任务已结束，未重复调用视觉服务。");
    }, { timeout: 10_000 }), signal);
    signal.throwIfAborted();
    providerStarted = true;
    const { report, visualCheckPerformed } = ComplianceCheckResponse.parse(await ai.complianceCheck(request, { signal, maxResponseBytes: 4 * 1024 * 1024, requireRealVlmProvider: true }));
    // The company endpoint retains legacy fallback scores. Only explicit
    // real-model execution evidence may promote a product check to completed.
    if (visualCheckPerformed !== true) throw new ApiException(502, "视觉服务未完成有效检查，图片仍视为尚未检查，请重试检查。");
    signal.throwIfAborted();
    await prisma.$transaction(async tx => {
      await requireArtifactWrite(tx, row.workspaceId, row.projectId, row.userId);
      // This CAS locks the task until the version report commits atomically.
      const update = await tx.asyncTask.updateMany({ where: { id: taskId, kind: STUDIO_COMPLIANCE_KIND, jobId, status: "RUNNING", expiresAt: { gt: new Date() } }, data: { status: "SUCCEEDED", progress: 100, error: null, refCount: 1 } });
      if (!update.count) throw new ApiException(409, "检查任务已结束，迟到报告未覆盖当前结果。");
      const current = await loadStudioComplianceSource(tx, row.workspaceId, row.versionId!, row.projectId, row.userId);
      if (current.row.sha256 !== row.sha256 || current.row.objectKey !== row.objectKey || current.row.assetId !== row.assetId || current.rulesHash !== source.rulesHash) throw new ApiException(409, "检查期间图片或品牌快照发生变化，报告未发布，请重试检查。");
      signal.throwIfAborted();
      await tx.generationVersion.update({ where: { id: row.versionId! }, data: {
        complianceReport: report as Prisma.InputJsonValue,
        params: { ...complianceObject(current.row.version!.params), studioCompliance: { taskId, jobId, imageSha256: row.sha256, rulesHash: source.rulesHash,
          referenceAssets: references.audit } } as Prisma.InputJsonValue,
      } });
      signal.throwIfAborted();
    }, { timeout: 10_000 });
    void recordUsage({ ...owner, kind: "COMPLIANCE", status: "SUCCEEDED", imageCount: 1, latencyMs: Date.now() - startedAt });
  } catch (error) {
    // Raw provider/transport errors can contain signed URLs or credentials.
    // Only our controlled ApiException messages may enter the public receipt.
    const message = error instanceof ApiException ? error.message : STUDIO_COMPLIANCE_ERROR;
    await prisma.asyncTask.updateMany({ where: { id: taskId, kind: STUDIO_COMPLIANCE_KIND, jobId, status: claimed ? "RUNNING" : "PENDING" }, data: { status: "FAILED", error: message } });
    if (providerStarted && owner) void recordUsage({ ...owner, kind: "COMPLIANCE", status: "FAILED", imageCount: 1, latencyMs: Date.now() - startedAt });
  }
}

export function createStudioGenerationComplianceWorker() {
  const worker = new Worker("studio-generation-compliance", runStudioGenerationComplianceJob, { connection, prefix: queuePrefix, concurrency: 1 });
  let sweeping = false;
  const sweep = () => {
    if (sweeping) return;
    sweeping = true;
    void dispatchStudioGenerationCompliance().catch(() => console.warn("[studio-compliance] recovery pending")).finally(() => { sweeping = false; });
  };
  sweep(); const interval = setInterval(sweep, 15_000); interval.unref();
  worker.on("closed", () => clearInterval(interval));
  worker.on("failed", job => console.warn(`[studio-compliance] task ${job?.id} awaits recovery or explicit retry`));
  return worker;
}
