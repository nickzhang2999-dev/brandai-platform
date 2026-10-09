import { createHash, randomUUID } from "node:crypto";
import { Worker, type Job } from "bullmq";
import { prisma, Prisma } from "@brandai/db";
import { connection, queuePrefix } from "@/lib/queue";
import { uploadBuffer } from "@/lib/s3";
import { getEffectiveStorage } from "@/lib/settings";
import { ApiException } from "@/lib/api";
import { assetCategoryForScene } from "@/lib/asset-mirror";
import { artifactDeadline, artifactOwnObjectKey, inspectArtifactImage, postprocessArtifactImage, readArtifactImageBytes } from "@/lib/studio-generation-artifacts-image";
import { enqueueStudioArtifact } from "@/lib/studio-generation-artifacts-queue";
import { ensureStudioGenerationArtifacts, requireArtifactWrite, STUDIO_ARTIFACT_ERROR, STUDIO_ARTIFACT_EXPIRED, STUDIO_ARTIFACT_RUN_MS } from "@/lib/studio-generation-artifacts";
import { registerStudioGenerationCompliance } from "@/lib/studio-generation-compliance";
import { enqueueStudioCompliance } from "@/lib/studio-generation-compliance-queue";
import { StudioExactSnapshot, loadStudioExactAsset, lockStudioExactPublicationSources } from "@/lib/studio-generation-exact";
import { compositeStudioExactImage } from "@/lib/studio-exact-image";
import { storeStudioCleanBase } from "@/lib/studio-generation-base";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** A provider is never called here. Retrying consumes the same private result. */
export async function runStudioGenerationArtifactJob(job: Job<{ outputId: string; epoch: number }>) {
  const { outputId, epoch } = job.data;
  const token = randomUUID();
  const row = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "outputId" FROM "StudioGeneratedMaterial" WHERE "outputId" = ${outputId} FOR UPDATE`;
    const found = await tx.studioGeneratedMaterial.findUnique({ where: { outputId }, include: { output: true, request: { include: { generation: true } } } });
    if (!found || found.expiresAt.getTime() !== epoch || !["PENDING", "RUNNING"].includes(found.status)) return null;
    if (found.status === "RUNNING" && found.startedAt && found.startedAt.getTime() > Date.now() - STUDIO_ARTIFACT_RUN_MS - 30_000) return null;
    if (found.expiresAt.getTime() <= Date.now() || found.output.expiresAt.getTime() <= Date.now() || !found.output.imageUrl) {
      await tx.studioGeneratedMaterial.update({ where: { outputId }, data: { status: "FAILED", attemptToken: null, error: STUDIO_ARTIFACT_EXPIRED } }); return null;
    }
    if (found.request.status !== "SUCCEEDED" || found.request.workspaceId !== found.workspaceId || found.request.projectId !== found.projectId || found.request.generation.workspaceId !== found.workspaceId || found.request.generation.projectId !== found.projectId || found.output.workspaceId !== found.workspaceId || found.output.projectId !== found.projectId || found.output.requestId !== found.requestId || found.request.userId !== found.userId) {
      await tx.studioGeneratedMaterial.update({ where: { outputId }, data: { status: "FAILED", attemptToken: null, error: STUDIO_ARTIFACT_ERROR } }); return null;
    }
    await tx.studioGeneratedMaterial.update({ where: { outputId }, data: { status: "RUNNING", startedAt: new Date(), attemptToken: token, attempts: { increment: 1 }, error: null } });
    return found;
  });
  if (!row) return;
  const signal = AbortSignal.timeout(Math.max(1, Math.min(STUDIO_ARTIFACT_RUN_MS, row.expiresAt.getTime() - Date.now(), row.output.expiresAt.getTime() - Date.now())));
  try {
    await prisma.$transaction(tx => requireArtifactWrite(tx, row.workspaceId, row.projectId, row.userId));
    const storage = await artifactDeadline(getEffectiveStorage(), signal);
    const params = object(row.output.params);
    const processing = object(params.studioPostprocess);
    if (!Array.isArray(processing.watermarkOverlays)) throw new ApiException(422, "生成结果缺少品牌后处理快照，未发布未完成的图片。");
    const exact = processing.exactLayout === undefined ? null : StudioExactSnapshot.parse(processing.exactLayout);
    // A retained EXACT marker without its private recipe must fail closed.
    if (Array.isArray(params.assetUsages) && params.assetUsages.some(value => object(value).mode === "EXACT") && !exact) throw new ApiException(422, "严格保留素材缺少生成时的布局记录，未发布图片。");
    const prior = row.versionId ? await prisma.asset.findUnique({ where: { generationVersionId: row.versionId }, select: { workspaceId: true, storageKey: true, url: true } }) : null;
    const raw = await readArtifactImageBytes({ imageUrl: row.output.imageUrl!,
      objectKey: prior?.workspaceId === row.workspaceId && prior.url === row.output.imageUrl ? prior.storageKey : artifactOwnObjectKey(row.output.imageUrl!, storage.publicUrl, row.workspaceId) }, signal);
    if (!row.output.imageUrl!.startsWith("data:")) {
      const rawMeta = await inspectArtifactImage(raw, signal);
      // A URL is not durable image retention. As soon as safe decoding succeeds,
      // preserve the bounded bytes before any brand composition or S3 upload.
      await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "outputId" FROM "StudioGeneratedMaterial" WHERE "outputId" = ${outputId} FOR UPDATE`;
        const current = await tx.studioGeneratedMaterial.findUnique({ where: { outputId } });
        if (!current || current.status !== "RUNNING" || current.attemptToken !== token || current.expiresAt.getTime() <= Date.now() || row.output.expiresAt.getTime() <= Date.now()) throw new ApiException(409, "归档任务已结束，迟到源文件未保存。");
        signal.throwIfAborted();
        await tx.studioGenerationOutput.update({ where: { id: outputId }, data: {
          imageUrl: `data:${rawMeta.mimeType};base64,${raw.toString("base64")}`,
          params: { ...params, studioSourceRetention: "bytes" } as Prisma.InputJsonValue,
        } });
        signal.throwIfAborted();
      }, { timeout: 10_000 });
    }
    if (!storage.configured) throw new ApiException(503, "对象存储未配置，生成结果已保留，可配置后重试归档。");
    let composed = raw;
    let appliedExactAssetIds: string[] = [];
    if (exact) {
      const actual = await inspectArtifactImage(raw, signal);
      if (actual.width !== exact.target.width || actual.height !== exact.target.height) throw new ApiException(422, "生成服务返回的实际尺寸与输出画框不一致，未错位合成素材。");
      const result = await compositeStudioExactImage(raw, exact.layers, assetId => loadStudioExactAsset(row.workspaceId, row.projectId, assetId), signal);
      composed = result.body; appliedExactAssetIds = result.appliedAssetIds;
    }
    const final = await postprocessArtifactImage(composed, processing.watermarkOverlays, async assetId => {
      const asset = await prisma.asset.findFirst({ where: { id: assetId, workspaceId: row.workspaceId, deprecatedAt: null, availableForGeneration: true, mimeType: { in: ["image/png", "image/jpeg", "image/webp"] } },
        select: { storageKey: true, url: true } });
      if (!asset) throw new ApiException(422, "品牌图片素材已不可用，原始生成结果仍保留，尚未发布。");
      return { imageUrl: asset.url, objectKey: asset.storageKey || artifactOwnObjectKey(asset.url, storage.publicUrl, row.workspaceId) };
    }, signal, processing.assetSha256);
    const logoId = typeof processing.automaticBrandLogoAssetId === "string" ? processing.automaticBrandLogoAssetId : null;
    if (logoId && !final.appliedAssetIds.includes(logoId)) throw new ApiException(422, "品牌标志合成未完成，未发布图片。");
    signal.throwIfAborted();
    // Content-addressed per-output keys make a stalled older upload harmless:
    // identical bytes share a key; changed bytes can never overwrite a winner.
    const prefix = `${row.workspaceId}/studio-generated/${row.projectId}`;
    const objectKey = `${prefix}/${outputId}/${final.sha256}`;
    const stored = await artifactDeadline(uploadBuffer(final.body, final.mimeType, prefix, signal, objectKey), signal);
    const cleanBase = exact ? await storeStudioCleanBase(raw, { workspaceId: row.workspaceId, projectId: row.projectId, outputId }, signal) : null;
    signal.throwIfAborted();
    const check = await prisma.$transaction(async tx => {
      await requireArtifactWrite(tx, row.workspaceId, row.projectId, row.userId);
      if (exact) await lockStudioExactPublicationSources(tx, row.workspaceId, row.projectId, exact);
      await tx.$queryRaw`SELECT "outputId" FROM "StudioGeneratedMaterial" WHERE "outputId" = ${outputId} FOR UPDATE`;
      const current = await tx.studioGeneratedMaterial.findUnique({ where: { outputId }, include: { output: { select: { expiresAt: true } } } });
      if (!current || current.status !== "RUNNING" || current.attemptToken !== token || current.expiresAt.getTime() <= Date.now() || current.output.expiresAt.getTime() <= Date.now()) throw new ApiException(409, "归档任务已结束或超时，迟到结果未发布。");
      signal.throwIfAborted();
      const { studioPostprocess: _privateSnapshot, studioSourceRetention: _privateRetention, ...publicParams } = params;
      const finalParams = { ...publicParams, actualSize: { actualWidth: final.width, actualHeight: final.height },
        ...(exact ? { appliedExactAssetIds, exactComposition: "deterministic-source-overlay" } : {}),
        appliedWatermarkAssetIds: final.appliedAssetIds,
        ...(logoId ? { appliedBrandLogoAssetId: logoId, brandLogoComposition: "deterministic-source-overlay" } : {}) } as Prisma.InputJsonValue;
      const versionId = row.versionId ?? `sgv_${createHash("sha256").update(outputId).digest("hex").slice(0, 40)}`;
      const existing = await tx.generationVersion.findUnique({ where: { id: versionId }, select: { generationId: true } });
      if (existing && existing.generationId !== row.request.generationId) throw new ApiException(409, "生成版本归属异常，未添加图片。");
      await tx.generationVersion.upsert({ where: { id: versionId },
        create: { id: versionId, generationId: row.request.generationId, index: row.output.index, imageUrl: stored.url, width: final.width, height: final.height, params: finalParams },
        update: { imageUrl: stored.url, width: final.width, height: final.height, params: finalParams } });
      const mirrored = await tx.asset.findUnique({ where: { generationVersionId: versionId }, select: { id: true, workspaceId: true, deprecatedAt: true, availableForGeneration: true } });
      if (mirrored && (mirrored.workspaceId !== row.workspaceId || mirrored.deprecatedAt || !mirrored.availableForGeneration)) throw new ApiException(409, "已生成素材已停用或归属异常，未重新启用。");
      const metadata = { storageKey: stored.key, url: stored.url, mimeType: final.mimeType, sizeBytes: final.sizeBytes, resolution: `${final.width} × ${final.height}`, libraryKind: "GENERATED" };
      const asset = await tx.asset.upsert({ where: { generationVersionId: versionId },
        create: { workspaceId: row.workspaceId, generationVersionId: versionId, category: assetCategoryForScene(row.request.generation.sceneType),
          fileName: `generation-${row.output.index + 1}.${final.mimeType === "image/jpeg" ? "jpg" : final.mimeType.split("/")[1]}`, source: "UPLOAD", ...metadata },
        update: metadata });
      await tx.projectAsset.upsert({ where: { projectId_assetId_kind: { projectId: row.projectId, assetId: asset.id, kind: "MEMBER" } },
        create: { projectId: row.projectId, assetId: asset.id, kind: "MEMBER", usageMode: "REFERENCE" }, update: {} });
      await tx.studioGeneratedMaterial.update({ where: { outputId }, data: { status: "SUCCEEDED", versionId, assetId: asset.id, objectKey: stored.key,
        sha256: final.sha256, mimeType: final.mimeType, sizeBytes: final.sizeBytes, width: final.width, height: final.height, attemptToken: null, error: null } });
      // Only now can generic GenerationVersion APIs see the finished image.
      await tx.studioGenerationOutput.update({ where: { id: outputId }, data: { imageUrl: null,
        ...(cleanBase ? { params: { ...params, studioPostprocess: { ...processing, cleanBase } } as Prisma.InputJsonValue } : {}) } });
      const check = await registerStudioGenerationCompliance(tx, row.workspaceId, versionId);
      signal.throwIfAborted();
      return check;
    }, { timeout: 10_000 });
    // The committed task is the outbox. A queue outage cannot roll back a
    // published picture or cause the image provider to be called again.
    if (check.status === "PENDING" && check.jobId) await enqueueStudioCompliance(check.id, check.jobId).catch(() => false);
  } catch (error) {
    const terminal = error instanceof ApiException || row.expiresAt.getTime() <= Date.now() || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    const updated = await prisma.studioGeneratedMaterial.updateMany({ where: { outputId, status: "RUNNING", attemptToken: token },
      data: { status: terminal ? "FAILED" : "PENDING", attemptToken: null, error: terminal ? STUDIO_ARTIFACT_ERROR : null } });
    // Never delete a deterministic object on an uncertain commit response. A
    // winner may already reference it; provider output remains for retry.
    if (updated.count && !terminal) throw new Error("Generated result archive temporarily unavailable");
  }
}

let sweeping = false;
export async function sweepStudioGenerationArtifacts() {
  if (sweeping) return;
  sweeping = true;
  try {
    await prisma.studioGeneratedMaterial.updateMany({ where: { status: { in: ["PENDING", "RUNNING"] }, expiresAt: { lte: new Date() } },
      data: { status: "FAILED", attemptToken: null, error: STUDIO_ARTIFACT_ERROR } });
    // Private base64/provider URLs have a bounded recovery lifetime, even if no
    // user opens the page again. Successful outputs are cleared on commit.
    await prisma.studioGenerationOutput.updateMany({ where: { imageUrl: { not: null }, expiresAt: { lte: new Date() } }, data: { imageUrl: null } });
    // A dead worker loses its DB claim. A late writer still must match token.
    await prisma.studioGeneratedMaterial.updateMany({ where: { status: "RUNNING", startedAt: { lt: new Date(Date.now() - STUDIO_ARTIFACT_RUN_MS - 30_000) }, expiresAt: { gt: new Date() } },
      data: { status: "PENDING", attemptToken: null } });
    const pending = await prisma.studioGeneratedMaterial.findMany({ where: { status: "PENDING", expiresAt: { gt: new Date() } }, select: { outputId: true, expiresAt: true }, take: 100 });
    await Promise.all(pending.map(row => enqueueStudioArtifact(row.outputId, row.expiresAt)));
    const missing = await prisma.studioGenerationRequest.findMany({ where: { status: "SUCCEEDED", outputs: { some: { imageUrl: { not: null }, expiresAt: { gt: new Date() }, artifact: null } } }, select: { id: true }, take: 10 });
    // A bounded batch also keeps permission failures/Redis outages from making
    // a serial recovery sweep take longer than the attempt's entire lifetime.
    await Promise.allSettled(missing.map(request => ensureStudioGenerationArtifacts(request.id)));
  } finally { sweeping = false; }
}

export function createStudioGenerationArtifactWorker() {
  const worker = new Worker("studio-generation-artifact", runStudioGenerationArtifactJob, { connection, prefix: queuePrefix, concurrency: 1 });
  const sweep = () => { void sweepStudioGenerationArtifacts().catch(() => console.error("[studio-artifact] recovery sweep unavailable")); };
  sweep(); const interval = setInterval(sweep, 15_000); interval.unref();
  worker.on("closed", () => clearInterval(interval));
  worker.on("failed", job => console.warn(`[studio-artifact] task ${job?.id} retry or failure recorded`));
  return worker;
}
