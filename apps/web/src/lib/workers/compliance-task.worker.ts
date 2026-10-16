import { Worker, type Job } from "bullmq";
import { prisma, Prisma } from "@brandai/db";
import { parseAsyncTaskResult } from "@brandai/contracts";
import { connection, queuePrefix } from "@/lib/queue";
import { ApiException } from "../api";
import { withinAiDeadline } from "../ai-response";
import { runPrecheck } from "../precheck";
import { runComplianceCheck } from "../compliance";
import { serializeVersion } from "../generations";
import { ComplianceTaskInput, COMPLIANCE_TASK_KINDS, COMPLIANCE_TASK_ERROR, COMPLIANCE_TASK_EXPIRED,
  dispatchComplianceTasks, validateComplianceTaskSource } from "../compliance-tasks";

type CheckJob = Job<{ taskId: string; jobId: string }>;

/** A RUNNING receipt is never reclaimed for a second paid model call. */
export async function runComplianceTaskJob(job: CheckJob) {
  const { taskId, jobId } = job.data;
  let claimed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const signal = controller.signal;
  try {
    const task = await prisma.asyncTask.findUnique({ where: { id: taskId } });
    if (!task || !(COMPLIANCE_TASK_KINDS as readonly string[]).includes(task.kind) || task.jobId !== jobId || task.status !== "PENDING") return;
    if (!task.expiresAt || task.expiresAt.getTime() <= Date.now()) throw new ApiException(408, COMPLIANCE_TASK_EXPIRED);
    const input = ComplianceTaskInput.parse(task.inputJson);
    const claim = await prisma.asyncTask.updateMany({ where: { id: taskId, jobId, status: "PENDING", expiresAt: { gt: new Date() } },
      data: { status: "RUNNING", progress: 5, error: null } });
    if (!claim.count) return;
    claimed = true;
    timer = setTimeout(() => controller.abort(new ApiException(408, COMPLIANCE_TASK_EXPIRED)), Math.max(1, Math.min(5 * 60_000, task.expiresAt.getTime() - Date.now())));
    await withinAiDeadline(validateComplianceTaskSource(task.workspaceId, task.kind, input), signal);
    signal.throwIfAborted();
    const response = task.kind === "GENERATION_PRECHECK"
      ? await withinAiDeadline(runPrecheck({ workspaceId: task.workspaceId, text: input.text }, { signal }), signal)
      : await withinAiDeadline(runComplianceCheck({ workspaceId: task.workspaceId, text: input.text,
        ...(task.kind === "COMPLIANCE_RECHECK" ? { imageUrl: input.imageUrl } : {}) }, { signal }), signal);
    signal.throwIfAborted();
    await withinAiDeadline(validateComplianceTaskSource(task.workspaceId, task.kind, input), signal);
    await prisma.$transaction(async tx => {
      // Lock the live task before writing either result. A sweeper or timeout
      // cannot be overwritten by an AI response that arrived late.
      const accepted = await tx.asyncTask.updateMany({ where: { id: taskId, workspaceId: task.workspaceId, kind: task.kind, jobId,
        status: "RUNNING", expiresAt: { gt: new Date() } }, data: { progress: 95 } });
      if (!accepted.count) throw new ApiException(409, "检查任务已经结束，迟到结果未发布。");
      signal.throwIfAborted();
      let result: unknown = response;
      if (task.kind === "COMPLIANCE_RECHECK") {
        // A newer request supersedes an older one even if completion order flips.
        const latest = await tx.asyncTask.findFirst({ where: { workspaceId: task.workspaceId, kind: task.kind, refId: input.versionId },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } });
        if (latest?.id !== taskId) throw new ApiException(409, "已有更新的复检任务，旧结果未覆盖当前版本。");
        const saved = await tx.generationVersion.updateMany({ where: { id: input.versionId!, generationId: input.generationId!, imageUrl: input.imageUrl!,
          generation: { workspaceId: task.workspaceId, projectId: input.projectId!, project: { workspaceId: task.workspaceId }, studioRequest: { is: null } } },
          data: { complianceReport: response.report as Prisma.InputJsonValue } });
        if (!saved.count) throw new ApiException(409, "图片已变化，复检结果未发布。");
        const version = await tx.generationVersion.findUniqueOrThrow({ where: { id: input.versionId! } });
        result = serializeVersion(version);
      }
      const validated = parseAsyncTaskResult(task.kind, result);
      if (!validated) throw new ApiException(502, "检查结果格式不完整，未标记成功。");
      signal.throwIfAborted();
      await tx.asyncTask.update({ where: { id: taskId }, data: { status: "SUCCEEDED", progress: 100, error: null,
        resultJson: validated as Prisma.InputJsonValue, refCount: task.kind === "COMPLIANCE_RECHECK" ? 1 : 0 } });
      signal.throwIfAborted();
    }, { timeout: 10_000 });
  } catch (error) {
    const message = error instanceof ApiException ? error.message : COMPLIANCE_TASK_ERROR;
    await prisma.asyncTask.updateMany({ where: { id: taskId, jobId, kind: { in: [...COMPLIANCE_TASK_KINDS] }, status: claimed ? "RUNNING" : "PENDING" },
      data: { status: "FAILED", error: message } });
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}

export function createComplianceTaskWorker() {
  const worker = new Worker("compliance-task", runComplianceTaskJob, { connection, prefix: queuePrefix, concurrency: 2 });
  let dispatching = false;
  const dispatch = () => {
    if (dispatching) return;
    dispatching = true;
    void dispatchComplianceTasks().catch(() => console.warn("[compliance-task] dispatch pending")).finally(() => { dispatching = false; });
  };
  dispatch();
  const interval = setInterval(dispatch, 15_000); interval.unref();
  worker.on("closed", () => clearInterval(interval));
  worker.on("failed", () => console.warn("[compliance-task] terminal failure; no automatic model retry"));
  return worker;
}
