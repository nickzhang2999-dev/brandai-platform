import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma, Prisma } from "@brandai/db";
import { ApiException } from "./api";
import { requireWorkspaceRole } from "./workspace";
import { enqueueComplianceTask } from "./compliance-task-queue";

export const COMPLIANCE_TASK_KINDS = ["COMPLIANCE_PRECHECK", "GENERATION_PRECHECK", "COMPLIANCE_RECHECK"] as const;
export type ComplianceTaskKind = typeof COMPLIANCE_TASK_KINDS[number];
export const COMPLIANCE_TASK_TTL_MS = 6 * 60_000;
export const COMPLIANCE_TASK_EXPIRED = "检查任务超时，尚未确认结果；请重新发起检查。";
export const COMPLIANCE_TASK_ERROR = "检查未完成，请稍后重试；系统不会自动重复调用模型。";
export const ComplianceTaskInput = z.object({
  userId: z.string().min(1),
  text: z.string(),
  projectId: z.string().min(1).optional(),
  generationId: z.string().min(1).optional(),
  versionId: z.string().min(1).optional(),
  imageUrl: z.string().min(1).optional(),
});
export type ComplianceTaskInput = z.infer<typeof ComplianceTaskInput>;

export async function createComplianceTask(workspaceId: string, kind: ComplianceTaskKind, raw: ComplianceTaskInput) {
  const input = ComplianceTaskInput.parse(raw);
  // Callers resolve any project/version ownership before accepting the task.
  // The worker checks again because permission/source can change while queued.
  const task = await prisma.asyncTask.create({ data: {
    workspaceId, kind, inputJson: input as Prisma.InputJsonValue,
    jobId: `check_${randomUUID().replace(/-/g, "")}`, status: "PENDING", progress: 0,
    ...(input.versionId ? { refId: input.versionId } : {}),
    expiresAt: new Date(Date.now() + COMPLIANCE_TASK_TTL_MS),
  } });
  await enqueueComplianceTask(task.id, task.jobId!);
  return { taskId: task.id, status: "PENDING" as const };
}

export async function dispatchComplianceTasks() {
  await prisma.asyncTask.updateMany({ where: { kind: { in: [...COMPLIANCE_TASK_KINDS] }, status: { in: ["PENDING", "RUNNING"] },
    OR: [{ expiresAt: { lte: new Date() } }, { expiresAt: null }] },
  data: { status: "FAILED", error: COMPLIANCE_TASK_EXPIRED } });
  const tasks = await prisma.asyncTask.findMany({ where: { kind: { in: [...COMPLIANCE_TASK_KINDS] }, status: "PENDING", expiresAt: { gt: new Date() } },
    take: 50, orderBy: { createdAt: "asc" }, select: { id: true, jobId: true } });
  await Promise.all(tasks.filter(task => task.jobId).map(task => enqueueComplianceTask(task.id, task.jobId!)));
}

/** No image URL or project reference is accepted merely from a queued payload. */
export async function validateComplianceTaskSource(workspaceId: string, kind: string, input: ComplianceTaskInput) {
  const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { isActive: true } });
  if (!user?.isActive) throw new ApiException(403, "账号不可用，检查未执行。");
  await requireWorkspaceRole(workspaceId, input.userId, "EDITOR");
  if (kind !== "COMPLIANCE_PRECHECK" && !input.projectId) throw new ApiException(422, "检查任务项目来源不完整。");
  if (input.projectId) {
    const project = await prisma.project.findFirst({ where: { id: input.projectId, workspaceId }, select: { id: true } });
    if (!project) throw new ApiException(404, "项目不存在，检查未执行。");
  }
  if (kind !== "COMPLIANCE_RECHECK") return;
  if (!input.versionId || !input.generationId || !input.imageUrl) throw new ApiException(422, "复检任务来源不完整。");
  const generation = await prisma.generation.findUnique({ where: { id: input.generationId } });
  const version = await prisma.generationVersion.findUnique({ where: { id: input.versionId } });
  if (!generation || generation.workspaceId !== workspaceId || generation.projectId !== input.projectId || !version || version.generationId !== generation.id
    || version.imageUrl !== input.imageUrl || [generation.sellingPoint, generation.scene].filter(Boolean).join("。") !== input.text) {
    throw new ApiException(409, "图片或文案已变化，请重新发起检查。");
  }
  const studio = await prisma.studioGenerationRequest.findUnique({ where: { generationId: generation.id }, select: { id: true } });
  if (studio) throw new ApiException(409, "产品图片请在工作台使用重试检查。");
}
