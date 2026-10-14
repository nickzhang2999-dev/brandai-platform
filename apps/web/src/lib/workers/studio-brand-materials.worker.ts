import { randomUUID } from "node:crypto";
import { Worker, type Job } from "bullmq";
import { prisma } from "@brandai/db";
import { STUDIO_MATERIAL_MAX_BYTES } from "@brandai/contracts";
import { connection, queuePrefix } from "@/lib/queue";
import { ApiException } from "@/lib/api";
import { requireWorkspaceRole } from "@/lib/workspace";
import { studioBrandMaterialSourceDigest, studioBrandObjectKey } from "../studio-brand-materials-trust";
import { inspectArtifactImage, readArtifactImageBytes } from "@/lib/studio-generation-artifacts-image";
import { expireStudioBrandMaterialVerifications } from "@/lib/studio-brand-materials";
import { enqueueStudioBrandMaterial } from "@/lib/studio-brand-materials-queue";

/** Existing assets are inspected only in a worker, with bounded bytes/time.
 * A digest is a content check, never permission or a substitute for ownership. */
export async function runStudioBrandMaterialJob(job: Job<{ taskId: string }>) {
  const taskId = job.data.taskId, token = randomUUID();
  const row = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "AsyncTask" WHERE "id" = ${taskId} FOR UPDATE`;
    const row = await tx.studioBrandMaterialReceipt.findUnique({ where: { taskId }, include: { task: true, asset: true } });
    if (!row || !["PENDING", "RUNNING"].includes(row.task.status)) return null;
    if (row.expiresAt.getTime() <= Date.now()) {
      await tx.asyncTask.update({ where: { id: taskId }, data: { status: "FAILED", error: "素材校验超时，请重新验证。" } });
      return null;
    }
    await tx.studioBrandMaterialReceipt.update({ where: { assetId: row.assetId }, data: { attemptToken: token } });
    await tx.asyncTask.update({ where: { id: taskId }, data: { status: "RUNNING", progress: 10, error: null } });
    return row;
  });
  if (!row) return;
  const signal = AbortSignal.timeout(Math.max(1, Math.min(60_000, row.expiresAt.getTime() - Date.now())));
  try {
    const user = await prisma.user.findUnique({ where: { id: row.userId }, select: { isActive: true } });
    if (!user?.isActive) throw new ApiException(403, "账号已停用，未读取图片。");
    await requireWorkspaceRole(row.workspaceId, row.userId, "EDITOR");
    const asset = row.asset;
    if (asset.workspaceId !== row.workspaceId || !asset.availableForGeneration || asset.deprecatedAt
      || studioBrandMaterialSourceDigest(asset) !== row.sourceDigest) throw new ApiException(422, "素材已改变或不可用，请重新选择。");
    if (asset.storageKey && !studioBrandObjectKey(asset.storageKey, row.workspaceId)) throw new ApiException(422,
      /^https?:\/\//i.test(asset.storageKey) ? "外链素材请先上传或迁入品牌存储，再用于画布工具。" : "素材存储不属于当前品牌。");
    if (asset.sizeBytes > STUDIO_MATERIAL_MAX_BYTES) throw new ApiException(413, "这张图片超过 10 MiB，请压缩后重新上传。");
    const bytes = await readArtifactImageBytes({ imageUrl: asset.url, objectKey: asset.storageKey || null }, signal);
    if (bytes.length > STUDIO_MATERIAL_MAX_BYTES) throw new ApiException(413, "实际图片超过 10 MiB，未加入画布。");
    const inspected = await inspectArtifactImage(bytes, signal);
    if (inspected.mimeType !== asset.mimeType || asset.sizeBytes !== inspected.sizeBytes) throw new ApiException(422, "素材文件与记录不一致，未创建可信引用。");
    signal.throwIfAborted();
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "AsyncTask" WHERE "id" = ${taskId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "Asset" WHERE "id" = ${row.assetId} AND "workspaceId" = ${row.workspaceId} FOR SHARE`;
      const current = await tx.studioBrandMaterialReceipt.findUnique({ where: { taskId }, include: { task: true, asset: true } });
      if (!current || current.attemptToken !== token || current.task.status !== "RUNNING" || current.expiresAt.getTime() <= Date.now()) return;
      const ws = await tx.brandWorkspace.findUnique({ where: { id: row.workspaceId }, select: { ownerId: true } });
      const member = ws?.ownerId === row.userId ? null : await tx.membership.findUnique({ where: { userId_workspaceId: { userId: row.userId, workspaceId: row.workspaceId } }, select: { role: true } });
      const user = await tx.user.findUnique({ where: { id: row.userId }, select: { isActive: true } });
      if (!user?.isActive || !ws || ws.ownerId !== row.userId && !["OWNER", "EDITOR"].includes(member?.role ?? "")) throw new ApiException(403, "素材权限已变更，未创建引用。");
      if (current.asset.workspaceId !== row.workspaceId || current.asset.deprecatedAt || !current.asset.availableForGeneration
        || current.sourceDigest !== row.sourceDigest || studioBrandMaterialSourceDigest(current.asset) !== row.sourceDigest) throw new ApiException(422, "素材在校验期间发生变化，请重新验证。");
      await tx.studioBrandMaterialReceipt.update({ where: { assetId: row.assetId }, data: { ...inspected, attemptToken: null } });
      await tx.asyncTask.update({ where: { id: taskId }, data: { status: "SUCCEEDED", progress: 100, error: null, refId: row.assetId, refCount: 1 } });
    });
  } catch (error) {
    const terminal = error instanceof ApiException || signal.aborted || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    const changed = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "AsyncTask" WHERE "id" = ${taskId} FOR UPDATE`;
      const current = await tx.studioBrandMaterialReceipt.findUnique({ where: { taskId }, include: { task: true } });
      if (!current || current.attemptToken !== token || current.task.status === "SUCCEEDED" || current.task.status === "FAILED") return false;
      await tx.studioBrandMaterialReceipt.update({ where: { assetId: row.assetId }, data: { attemptToken: null } });
      await tx.asyncTask.update({ where: { id: taskId }, data: { status: terminal ? "FAILED" : "PENDING", progress: 0,
        error: terminal ? error instanceof ApiException ? error.message : "素材读取失败，请重试校验；原图片仍保留。" : null } });
      return true;
    });
    if (changed && !terminal) throw new Error("Brand material verification temporarily unavailable");
  }
}

let sweeping = false;
export async function sweepStudioBrandMaterialVerifications() {
  if (sweeping) return;
  sweeping = true;
  try {
    await expireStudioBrandMaterialVerifications();
    const waiting = await prisma.studioBrandMaterialReceipt.findMany({ where: { task: { status: "PENDING" }, expiresAt: { gt: new Date() } }, select: { taskId: true }, take: 100 });
    for (const row of waiting) await enqueueStudioBrandMaterial(row.taskId);
  } finally { sweeping = false; }
}
export function createStudioBrandMaterialWorker() {
  const worker = new Worker("studio-brand-material-verify", runStudioBrandMaterialJob, { connection, prefix: queuePrefix, concurrency: 1 });
  const sweep = () => { void sweepStudioBrandMaterialVerifications().catch(() => console.error("[studio-brand-material] verification recovery unavailable")); };
  sweep(); const interval = setInterval(sweep, 15_000); interval.unref();
  worker.on("closed", () => clearInterval(interval));
  worker.on("failed", () => console.warn("[studio-brand-material] verification retry or failure recorded"));
  return worker;
}
