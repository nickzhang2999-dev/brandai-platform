import { randomUUID, createHash } from "node:crypto";
import { Worker, type Job } from "bullmq";
import { prisma } from "@brandai/db";
import { connection, queuePrefix } from "@/lib/queue";
import { uploadBuffer, deleteObject } from "@/lib/s3";
import { ApiException } from "@/lib/api";
import { inspectStudioMaterialImage } from "@/lib/studio-materials-image";
import { expireStudioMaterials, requireStudioMaterialProject } from "@/lib/studio-materials";
import { enqueueStudioMaterial } from "@/lib/studio-materials-queue";

export async function runStudioMaterialJob(job: Job<{ taskId: string }>) {
  const taskId = job.data.taskId;
  const token = randomUUID();
  const row = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "AsyncTask" WHERE "id" = ${taskId} FOR UPDATE`;
    const found = await tx.studioMaterialUpload.findUnique({ where: { taskId }, include: { task: true } });
    if (!found || !["PENDING", "RUNNING"].includes(found.task.status)) return null;
    if (found.expiresAt.getTime() <= Date.now() || !found.body) {
      await tx.asyncTask.update({ where: { id: taskId }, data: { status: "FAILED", error: "图片上传超时，请重新选择图片上传。" } });
      await tx.studioMaterialUpload.update({ where: { taskId }, data: { body: null, attemptToken: null } });
      return null;
    }
    await tx.studioMaterialUpload.update({ where: { taskId }, data: { attemptToken: token } });
    await tx.asyncTask.update({ where: { id: taskId }, data: { status: "RUNNING", progress: 10, error: null } });
    return found;
  });
  if (!row) return;
  const signal = AbortSignal.timeout(Math.max(1, Math.min(60_000, row.expiresAt.getTime() - Date.now())));
  try {
    await requireStudioMaterialProject(row.workspaceId, row.userId, row.projectId, true);
    const body = Buffer.from(row.body!);
    if (createHash("sha256").update(body).digest("hex") !== row.sha256) throw new ApiException(422, "上传内容校验失败，请重新选择图片。");
    const dimensions = await inspectStudioMaterialImage(body, row.mimeType);
    signal.throwIfAborted();
    const stored = await uploadBuffer(body, row.mimeType, `${row.workspaceId}/studio/${row.projectId}`, signal, row.objectKey);
    signal.throwIfAborted();
    await prisma.$transaction(async tx => {
      const project = await tx.$queryRaw<Array<{ archivedAt: Date | null }>>`SELECT "archivedAt" FROM "Project" WHERE "id" = ${row.projectId} AND "workspaceId" = ${row.workspaceId} FOR UPDATE`;
      if (!project[0] || project[0].archivedAt) throw new ApiException(409, "项目已归档或删除，未添加图片。");
      const workspace = await tx.brandWorkspace.findUnique({ where: { id: row.workspaceId }, select: { ownerId: true } });
      const member = workspace?.ownerId === row.userId ? null : await tx.membership.findUnique({ where: { userId_workspaceId: { userId: row.userId, workspaceId: row.workspaceId } }, select: { role: true } });
      if (!workspace || (workspace.ownerId !== row.userId && !["OWNER", "EDITOR"].includes(member?.role ?? ""))) throw new ApiException(403, "上传权限已变更，未添加图片。");
      await tx.$queryRaw`SELECT "id" FROM "AsyncTask" WHERE "id" = ${taskId} FOR UPDATE`;
      const current = await tx.studioMaterialUpload.findUnique({ where: { taskId }, include: { task: true } });
      if (current?.task.status === "SUCCEEDED") return;
      if (!current || current.attemptToken !== token || current.task.status !== "RUNNING" || current.expiresAt.getTime() <= Date.now()) throw new ApiException(409, "上传已结束或超时，请重新选择图片。");
      const asset = await tx.asset.create({ data: { workspaceId: row.workspaceId, category: "OTHER", libraryKind: "MATERIAL", fileName: row.fileName,
        storageKey: stored.key, url: stored.url, mimeType: row.mimeType, sizeBytes: row.sizeBytes, source: "UPLOAD", resolution: `${dimensions.width} × ${dimensions.height}` } });
      await tx.projectAsset.create({ data: { projectId: row.projectId, assetId: asset.id, kind: "MEMBER", usageMode: "EXACT" } });
      await tx.studioMaterialUpload.update({ where: { taskId }, data: { assetId: asset.id, ...dimensions, body: null, attemptToken: null } });
      await tx.asyncTask.update({ where: { id: taskId }, data: { status: "SUCCEEDED", progress: 100, refId: asset.id, refCount: 1, error: null } });
    });
  } catch (error) {
    const terminal = error instanceof ApiException || row.expiresAt.getTime() <= Date.now() || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "AsyncTask" WHERE "id" = ${taskId} FOR UPDATE`;
      const current = await tx.studioMaterialUpload.findUnique({ where: { taskId }, include: { task: true } });
      // A lost DB reply after commit, or an older stalled worker, must never
      // delete or overwrite a completed asset / newer worker's claim.
      if (!current || current.task.status === "SUCCEEDED" || current.attemptToken !== token) return;
      await tx.asyncTask.update({ where: { id: taskId }, data: { status: terminal ? "FAILED" : "PENDING", progress: 0,
        error: terminal ? (error instanceof ApiException ? error.message : "图片存储失败，请重新选择图片上传；若持续失败请联系管理员。") : null } });
      await tx.studioMaterialUpload.update({ where: { taskId }, data: { attemptToken: null, ...(terminal ? { body: null } : {}) } });
    });
    if (!terminal) throw new Error("Studio image storage temporarily unavailable");
  }
}

let sweeping = false;
export async function sweepStudioMaterialUploads() {
  if (sweeping) return;
  sweeping = true;
  try {
    await expireStudioMaterials();
    const waiting = await prisma.studioMaterialUpload.findMany({ where: { task: { status: "PENDING" }, expiresAt: { gt: new Date() } }, select: { taskId: true }, take: 100 });
    for (const row of waiting) await enqueueStudioMaterial(row.taskId);
    // Wait beyond the maximal worker S3 deadline before removing orphan keys.
    // FAILED is irreversible; SUCCEEDED objects can never enter this cleanup.
    const abandoned = await prisma.studioMaterialUpload.findMany({ where: { task: { status: "FAILED" }, objectCleanedAt: null, expiresAt: { lt: new Date(Date.now() - 90_000) } }, select: { taskId: true, objectKey: true }, take: 20 });
    for (const row of abandoned) {
      try { await deleteObject(row.objectKey, AbortSignal.timeout(5000)); await prisma.studioMaterialUpload.update({ where: { taskId: row.taskId }, data: { objectCleanedAt: new Date() } }); }
      catch { /* Retain the durable cleanup marker for the next sweep. */ }
    }
  } finally { sweeping = false; }
}

export function createStudioMaterialWorker() {
  const worker = new Worker("studio-material-upload", runStudioMaterialJob, { connection, prefix: queuePrefix, concurrency: 1 });
  const sweep = () => { void sweepStudioMaterialUploads().catch(() => console.error("[studio-upload] outbox sweep unavailable")); };
  sweep();
  const interval = setInterval(sweep, 15_000); interval.unref();
  worker.on("closed", () => clearInterval(interval));
  worker.on("failed", job => console.warn(`[studio-upload] task ${job?.id} retry or failure recorded`));
  return worker;
}
