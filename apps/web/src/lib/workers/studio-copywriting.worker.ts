import { Worker, type Job } from "bullmq";
import { prisma, Prisma } from "@brandai/db";
import { StudioCopywritingInput } from "@brandai/contracts";
import sharp from "sharp";
import { ApiException } from "../api";
import { connection, queuePrefix } from "../queue";
import { COPYWRITING_KIND, COPYWRITING_EXPIRED, dispatchCopywriting } from "../studio-copywriting";
import { generateStudioCopywriting } from "../studio-copywriting-provider";
import { requireStudioMaterialProject } from "../studio-materials";
import { artifactDeadline, inspectArtifactImage, readArtifactImageBytes, STUDIO_ARTIFACT_MAX_PIXELS } from "../studio-generation-artifacts-image";
import { recordUsage } from "../usage";

export async function runStudioCopywriting(job: Job<{ taskId: string }>) {
  const id = job.data.taskId;
  const task = await prisma.asyncTask.findUnique({ where: { id } });
  if (!task || task.kind !== COPYWRITING_KIND || task.status !== "PENDING" || !task.refId) return;
  const claim = await prisma.asyncTask.updateMany({ where: { id, kind: COPYWRITING_KIND, status: "PENDING", expiresAt: { gt: new Date() } }, data: { status: "RUNNING", progress: 10 } });
  if (!claim.count) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(90_000, task.expiresAt!.getTime() - Date.now())));
  const { signal } = controller;
  try {
    const stored = task.inputJson as { userId: string; request: unknown };
    const input = StudioCopywritingInput.parse(stored.request);
    const validate = async () => {
      const user = await prisma.user.findUnique({ where: { id: stored.userId }, select: { isActive: true } });
      if (!user?.isActive) throw new ApiException(403, "账号不可用，文案任务已停止。");
      await requireStudioMaterialProject(task.workspaceId, stored.userId, task.refId!, true);
    };
    await artifactDeadline(validate(), signal);
    const project = await prisma.project.findFirstOrThrow({ where: { id: task.refId, workspaceId: task.workspaceId }, select: { name: true } });
    const brand = await prisma.brandWorkspace.findUniqueOrThrow({ where: { id: task.workspaceId }, select: { name: true } });
    let imageBase64: string | undefined;
    if (input.image) {
      const asset = await prisma.asset.findFirst({ where: { id: input.image.assetId, workspaceId: task.workspaceId, deprecatedAt: null, availableForGeneration: true,
        projectLinks: { some: { projectId: task.refId, project: { workspaceId: task.workspaceId } } } }, select: { url: true, storageKey: true } });
      if (!asset) throw new ApiException(422, "参考图片已失效，请重新选择图片。");
      const bytes = await readArtifactImageBytes({ imageUrl: asset.url, objectKey: asset.storageKey && !/^https?:/i.test(asset.storageKey) ? asset.storageKey : null }, signal);
      const meta = await inspectArtifactImage(bytes, signal);
      if (meta.sha256 !== input.image.assetSha256) throw new ApiException(409, "参考图片内容已变化，请重新选择。");
      const image = sharp(bytes, { limitInputPixels: STUDIO_ARTIFACT_MAX_PIXELS }).rotate().resize({ width: 768, height: 768, fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 75 });
      try { imageBase64 = (await artifactDeadline(image.toBuffer(), signal)).toString("base64"); } finally { image.destroy(); }
    }
    const result = await artifactDeadline(generateStudioCopywriting(input, { brandName: brand.name, projectName: project.name, imageBase64 }, signal), signal);
    await recordUsage({ workspaceId: task.workspaceId, userId: stored.userId, kind: COPYWRITING_KIND, status: "SUCCEEDED", provider: "qwen-anthropic", model: result.model,
      totalTokens: result.inputTokens + result.outputTokens, latencyMs: result.latencyMs });
    await artifactDeadline(validate(), signal);
    signal.throwIfAborted();
    await prisma.asyncTask.updateMany({ where: { id, status: "RUNNING", expiresAt: { gt: new Date() } }, data: { status: "SUCCEEDED", progress: 100, error: null,
      resultJson: result as Prisma.InputJsonValue, refCount: result.candidates.length } });
  } catch (error) {
    await prisma.asyncTask.updateMany({ where: { id, kind: COPYWRITING_KIND, status: "RUNNING" }, data: { status: "FAILED",
      error: signal.aborted ? COPYWRITING_EXPIRED : error instanceof ApiException ? error.message : "文案生成未完成，请稍后重试；系统不会自动重复调用模型。" } });
  } finally { clearTimeout(timer); controller.abort(); }
}
export function createStudioCopywritingWorker() {
  const worker = new Worker("studio-copywriting", runStudioCopywriting, { connection, prefix: queuePrefix, concurrency: 2 });
  let busy = false;
  const dispatch = () => { if (busy) return; busy = true; void dispatchCopywriting().catch(() => console.warn("[copywriting] outbox unavailable")).finally(() => { busy = false; }); };
  dispatch(); const timer = setInterval(dispatch, 3000); timer.unref();
  worker.on("closed", () => clearInterval(timer));
  worker.on("failed", () => console.warn("[copywriting] task interrupted; no automatic model retry"));
  return worker;
}
