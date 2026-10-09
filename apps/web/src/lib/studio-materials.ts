import { randomUUID } from "node:crypto";
import { prisma, type Prisma } from "@brandai/db";
import { STUDIO_MATERIAL_TTL_MS, StudioMaterial, StudioMaterialUploadQuery, StudioMaterialUploadView } from "@brandai/contracts";
import { ApiException } from "./api";
import { requireWorkspaceRole } from "./workspace";
import { getEffectiveStorage } from "./settings";
import { readStudioMaterialForm, assertStudioUploadCapacity } from "./studio-materials-policy";
import { enqueueStudioMaterial } from "./studio-materials-queue";
import { lockStudioIntake } from "./studio-intake-lock";

export const studioMaterialSelect = {
  taskId: true, workspaceId: true, projectId: true, userId: true, mutationId: true,
  sha256: true, fileName: true, mimeType: true, sizeBytes: true, width: true, height: true,
  assetId: true, expiresAt: true, task: true, asset: { select: { id: true, deprecatedAt: true } },
} satisfies Prisma.StudioMaterialUploadSelect;
type Upload = Prisma.StudioMaterialUploadGetPayload<{ select: typeof studioMaterialSelect }>;

export function studioMaterialView(row: Upload) {
  if (!row.assetId || !row.asset || row.asset.deprecatedAt || !row.width || !row.height) return null;
  return StudioMaterial.parse({ id: row.assetId, assetId: row.assetId, assetSha256: row.sha256,
    fileName: row.fileName, mimeType: row.mimeType, sizeBytes: row.sizeBytes, width: row.width, height: row.height,
    url: `/api/workspaces/${row.workspaceId}/assets/${row.assetId}/raw`, kind: "image" });
}
function receipt(row: Upload) {
  const material = row.task.status === "SUCCEEDED" ? studioMaterialView(row) : null;
  const unavailable = row.task.status === "SUCCEEDED" && !material;
  return StudioMaterialUploadView.parse({ taskId: row.taskId, projectId: row.projectId, mutationId: row.mutationId,
    status: unavailable ? "FAILED" : row.task.status, progress: row.task.progress, expiresAt: row.expiresAt.toISOString(),
    ...(material ? { material } : {}),
    ...(unavailable ? { error: "素材已删除或不可用，请重新上传。" } : row.task.error ? { error: row.task.error } : {}),
  });
}

export async function requireStudioMaterialProject(workspaceId: string, userId: string, projectId: string, write = false) {
  await requireWorkspaceRole(workspaceId, userId, write ? "EDITOR" : "VIEWER");
  const project = await prisma.project.findFirst({ where: { id: projectId, workspaceId }, select: { archivedAt: true } });
  if (!project) throw new ApiException(404, "项目不存在。");
  if (write && project.archivedAt) throw new ApiException(409, "项目已归档，无法上传图片。");
}

/** Expiry is authoritative even when no worker is alive. No external I/O here. */
export async function expireStudioMaterials(workspaceId?: string) {
  await prisma.$transaction(async tx => {
    const expired = await tx.studioMaterialUpload.findMany({ where: { ...(workspaceId ? { workspaceId } : {}), expiresAt: { lte: new Date() }, task: { status: { in: ["PENDING", "RUNNING"] } } }, select: { taskId: true }, take: 100 });
    for (const row of expired) {
      const changed = await tx.asyncTask.updateMany({ where: { id: row.taskId, status: { in: ["PENDING", "RUNNING"] } }, data: { status: "FAILED", error: "图片上传超时，请重新选择图片上传。" } });
      if (changed.count) await tx.studioMaterialUpload.update({ where: { taskId: row.taskId }, data: { body: null, attemptToken: null } });
    }
  });
}

export async function submitStudioMaterial(workspaceId: string, userId: string, req: Request) {
  await requireWorkspaceRole(workspaceId, userId, "EDITOR");
  const input = await readStudioMaterialForm(req);
  await requireStudioMaterialProject(workspaceId, userId, input.projectId, true);
  const identity = { workspaceId, userId, projectId: input.projectId, mutationId: input.mutationId };
  const replay = await prisma.studioMaterialUpload.findUnique({ where: { workspaceId_userId_projectId_mutationId: identity }, select: studioMaterialSelect });
  if (replay) {
    if (replay.sha256 !== input.sha256 || replay.mimeType !== input.mimeType || replay.fileName !== input.fileName) throw new ApiException(409, "同一次上传请求不能替换成其他图片，请重新选择上传。");
    await expireStudioMaterials(workspaceId);
    return readStudioMaterialUpload(workspaceId, userId, { projectId: input.projectId, taskId: replay.taskId });
  }
  if (!(await getEffectiveStorage()).configured) throw new ApiException(503, "对象存储尚未配置，暂时无法保存图片。请联系管理员配置后重试。");
  await expireStudioMaterials(workspaceId);
  const taskId = "smu_" + randomUUID().replace(/-/g, "");
  const row = await prisma.$transaction(async tx => {
    // Serialize quota checks + insert across all BFF instances. A small bounded
    // DB outbox is preferable to unbounded Redis/base64 or local-only files.
    await lockStudioIntake(tx, 1);
    const duplicate = await tx.studioMaterialUpload.findUnique({ where: { workspaceId_userId_projectId_mutationId: identity }, select: studioMaterialSelect });
    if (duplicate) {
      if (duplicate.sha256 !== input.sha256 || duplicate.mimeType !== input.mimeType || duplicate.fileName !== input.fileName) throw new ApiException(409, "上传请求标识已用于其他图片。");
      return duplicate;
    }
    const [local, global] = await Promise.all([
      tx.studioMaterialUpload.aggregate({ where: { workspaceId, body: { not: null } }, _sum: { sizeBytes: true }, _count: true }),
      tx.studioMaterialUpload.aggregate({ where: { body: { not: null } }, _sum: { sizeBytes: true }, _count: true }),
    ]);
    assertStudioUploadCapacity(local._sum.sizeBytes ?? 0, global._sum.sizeBytes ?? 0, input.body.length);
    if (local._count >= 100 || global._count >= 1000) throw new ApiException(429, "待处理图片较多，请稍后重试。");
    const locked = await tx.$queryRaw<Array<{ archivedAt: Date | null }>>`SELECT "archivedAt" FROM "Project" WHERE "id" = ${input.projectId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
    if (!locked[0] || locked[0].archivedAt) throw new ApiException(409, "项目不存在或已归档。");
    await tx.asyncTask.create({ data: { id: taskId, workspaceId, kind: "STUDIO_UPLOAD", jobId: taskId } });
    return tx.studioMaterialUpload.create({ data: { ...identity, taskId,
      sha256: input.sha256, fileName: input.fileName, mimeType: input.mimeType, sizeBytes: input.body.length, body: input.body,
      objectKey: `${workspaceId}/studio/${input.projectId}/${taskId}.${({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as Record<string, string>)[input.mimeType]}`,
      expiresAt: new Date(Date.now() + STUDIO_MATERIAL_TTL_MS),
    }, select: studioMaterialSelect });
  }, { timeout: 10_000 });
  await enqueueStudioMaterial(row.taskId);
  return receipt(row);
}

export async function readStudioMaterialUpload(workspaceId: string, userId: string, raw: unknown) {
  const { projectId, taskId } = StudioMaterialUploadQuery.parse(raw);
  await requireStudioMaterialProject(workspaceId, userId, projectId);
  await expireStudioMaterials(workspaceId);
  const rows = await prisma.studioMaterialUpload.findMany({ where: { workspaceId, projectId, userId, ...(taskId ? { taskId } : {}) }, select: studioMaterialSelect, orderBy: { createdAt: "desc" }, take: taskId ? 1 : 50 });
  if (taskId) { if (!rows[0]) throw new ApiException(404, "上传任务不存在。"); return receipt(rows[0]); }
  return { tasks: rows.map(receipt) };
}

/** Shared project assets are readable by all project members, regardless of uploader. */
export async function listStudioMaterials(workspaceId: string, userId: string, raw: unknown) {
  const { projectId } = StudioMaterialUploadQuery.pick({ projectId: true }).parse(raw);
  await requireStudioMaterialProject(workspaceId, userId, projectId);
  const rows = await prisma.studioMaterialUpload.findMany({ where: { workspaceId, projectId, task: { status: "SUCCEEDED" }, asset: { workspaceId, deprecatedAt: null, projectLinks: { some: { projectId, project: { workspaceId } } } } }, select: studioMaterialSelect, orderBy: { createdAt: "desc" }, take: 1000 });
  return rows.map(studioMaterialView).filter((row): row is StudioMaterial => row !== null);
}
