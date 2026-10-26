import { createHash } from "node:crypto";
import { prisma, Prisma } from "@brandai/db";
import { StudioCopywritingInput, StudioCopywritingResult, StudioCopywritingTask } from "@brandai/contracts";
import { ApiException } from "./api";
import { requireStudioMaterialProject } from "./studio-materials";
import { copywritingEnabled } from "./studio-copywriting-provider";
import { enqueueStudioCopywriting } from "./studio-copywriting-queue";

export const COPYWRITING_KIND = "STUDIO_COPYWRITING";
export const COPYWRITING_TTL = 6 * 60_000;
export const COPYWRITING_EXPIRED = "文案任务等待或执行超时，请确认后重新生成；系统不会自动重复调用模型。";
export const copyTaskId = (workspaceId: string, projectId: string, userId: string, mutationId: string) => "copy_" + createHash("sha256").update(JSON.stringify([workspaceId, projectId, userId, mutationId])).digest("hex");
export const copyScope = (workspaceId: string, projectId: string, userId: string) => ({ workspaceId, refId: projectId, kind: COPYWRITING_KIND, inputJson: { path: ["userId"], equals: userId } });
export function copyTaskView(row: { id: string; inputJson: unknown; resultJson: unknown; status: string; createdAt: Date; error: string | null }) {
  const input = row.inputJson as { request: StudioCopywritingInput };
  return StudioCopywritingTask.parse({ id: row.id, mutationId: input.request.mutationId, prompt: input.request.prompt, status: row.status,
    createdAt: row.createdAt.toISOString(), error: row.error, result: row.status === "SUCCEEDED" ? StudioCopywritingResult.parse(row.resultJson) : null });
}
export async function expireCopywriting(workspaceId?: string) {
  await prisma.asyncTask.updateMany({ where: { kind: COPYWRITING_KIND, ...(workspaceId ? { workspaceId } : {}), status: { in: ["PENDING", "RUNNING"] }, expiresAt: { lte: new Date() } }, data: { status: "FAILED", error: COPYWRITING_EXPIRED } });
}
export async function listCopywriting(workspaceId: string, projectId: string, userId: string) {
  await requireStudioMaterialProject(workspaceId, userId, projectId);
  await expireCopywriting(workspaceId);
  const rows = await prisma.asyncTask.findMany({ where: copyScope(workspaceId, projectId, userId), orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 20 });
  return { enabled: copywritingEnabled(), tasks: rows.map(copyTaskView) };
}
export async function submitCopywriting(workspaceId: string, projectId: string, userId: string, raw: unknown) {
  const request = StudioCopywritingInput.parse(raw);
  await requireStudioMaterialProject(workspaceId, userId, projectId, true);
  if (!copywritingEnabled()) throw new ApiException(503, "文案模型尚未配置，请管理员完成接入。");
  const input = { userId, request };
  const id = copyTaskId(workspaceId, projectId, userId, request.mutationId);
  const row = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`copy:${workspaceId}:${userId}`}))`;
    const previous = await tx.asyncTask.findUnique({ where: { id } });
    if (previous) {
      // Parse first so JSONB key ordering cannot make an unchanged retry conflict.
      const saved = StudioCopywritingInput.parse((previous.inputJson as { request: unknown }).request);
      if (JSON.stringify(saved) !== JSON.stringify(request)) throw new ApiException(409, "这次提交内容已变化，请重新生成。");
      return previous;
    }
    const pending = await tx.asyncTask.count({ where: { workspaceId, kind: COPYWRITING_KIND, inputJson: { path: ["userId"], equals: userId }, status: { in: ["PENDING", "RUNNING"] }, expiresAt: { gt: new Date() } } });
    if (pending) throw new ApiException(409, "已有文案正在生成，请先查看任务结果。");
    const recent = await tx.asyncTask.count({ where: { workspaceId, kind: COPYWRITING_KIND, createdAt: { gt: new Date(Date.now() - 60_000) } } });
    if (recent >= 5) throw new ApiException(429, "文案请求较多，请稍等一分钟再试。");
    if (request.image) { const asset = await tx.asset.findFirst({ where: { id: request.image.assetId, workspaceId, deprecatedAt: null, availableForGeneration: true,
      projectLinks: { some: { projectId, project: { workspaceId } } } }, select: { id: true } }); if (!asset) throw new ApiException(422, "参考图片不属于当前项目或已失效，请重新选择。"); }
    return tx.asyncTask.create({ data: { id, workspaceId, kind: COPYWRITING_KIND, refId: projectId, jobId: id,
      inputJson: input as Prisma.InputJsonValue, expiresAt: new Date(Date.now() + COPYWRITING_TTL) } });
  }, { maxWait: 1000, timeout: 1500 });
  // The periodic worker dispatch is the durable outbox; the route never waits on Redis or a model.
  return copyTaskView(row);
}
export async function dispatchCopywriting() {
  await expireCopywriting();
  const rows = await prisma.asyncTask.findMany({ where: { kind: COPYWRITING_KIND, status: "PENDING", expiresAt: { gt: new Date() } }, take: 30, orderBy: { createdAt: "asc" }, select: { id: true } });
  await Promise.all(rows.map(row => enqueueStudioCopywriting(row.id)));
}
