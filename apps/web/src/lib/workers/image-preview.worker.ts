import { Worker, type Job } from "bullmq";
import { prisma } from "@brandai/db";
import { connection, queuePrefix } from "@/lib/queue";
import {
  IMAGE_PREVIEW_MAX_SOURCE_BYTES,
  IMAGE_PREVIEW_WIDTH,
  nodeStreamToBuffer,
  renderImagePreview,
  webStreamToBuffer,
} from "@/lib/image-preview";
import { getObjectStream, uploadBuffer } from "@/lib/s3";
import { mirrorGenerationVersionToAsset } from "@/lib/asset-mirror";
import { safeFetch } from "@/lib/ssrf";

export interface ImagePreviewJobData {
  workspaceId: string;
  versionId?: string;
  assetId?: string;
}

const JOB_TIMEOUT_MS = 60_000;

async function buildImagePreview(
  job: Job<ImagePreviewJobData>,
  signal: AbortSignal,
): Promise<{ assetId: string; storageKey: string }> {
  signal.throwIfAborted();
  const { workspaceId, versionId, assetId } = job.data;
  if (!versionId && !assetId) {
    throw new Error("image preview job requires versionId or assetId");
  }

  let asset = assetId
    ? await prisma.asset.findFirst({
        where: { id: assetId, workspaceId },
        select: {
          id: true,
          storageKey: true,
          mimeType: true,
          previewStorageKey: true,
        },
      })
    : null;
  signal.throwIfAborted();

  if (!asset && versionId) {
    const version = await prisma.generationVersion.findFirst({
      where: { id: versionId, generation: { workspaceId } },
      select: {
        id: true,
        imageUrl: true,
        width: true,
        height: true,
        index: true,
        generation: {
          select: { workspaceId: true, scene: true, sceneType: true },
        },
        mirrorAsset: {
          select: {
            id: true,
            storageKey: true,
            mimeType: true,
            previewStorageKey: true,
          },
        },
      },
    });
    signal.throwIfAborted();
    if (!version)
      throw new Error(`version ${versionId} not found in workspace`);

    asset = version.mirrorAsset;
    if (!asset) {
      await mirrorGenerationVersionToAsset({
        workspaceId,
        generationVersionId: version.id,
        imageUrl: version.imageUrl,
        width: version.width,
        height: version.height,
        sceneType: version.generation.sceneType,
        fileLabel: `${(version.generation.scene || "AI 出图").slice(0, 40)} #${version.index + 1}`,
        aiDescription: version.generation.scene || undefined,
        enqueuePreview: false,
      });
      signal.throwIfAborted();
      asset = await prisma.asset.findFirst({
        where: { workspaceId, generationVersionId: versionId },
        select: {
          id: true,
          storageKey: true,
          mimeType: true,
          previewStorageKey: true,
        },
      });
      signal.throwIfAborted();
    }
  }
  if (!asset) {
    throw new Error(
      versionId
        ? `version ${versionId} has no local mirror for preview`
        : `asset ${assetId} not found in workspace`,
    );
  }
  if (asset.previewStorageKey) {
    signal.throwIfAborted();
    return { assetId: asset.id, storageKey: asset.previewStorageKey };
  }

  // `storageKey` is canonical for both shapes: an object key for uploaded /
  // generated assets, and the remote source URL for WEBSITE assets. `url` can
  // be an absolute private MinIO presentation URL even when storageKey is a
  // perfectly valid local object key, so choosing it would wrongly send local
  // objects through SSRF rejection instead of S3.
  const sourceLocation = asset.storageKey;
  let source: Buffer;
  if (/^https?:\/\//i.test(sourceLocation)) {
    const upstream = await safeFetch(sourceLocation, 4, signal);
    if (!upstream.ok || !upstream.body)
      throw new Error(`asset source fetch failed: ${upstream.status}`);
    const type = upstream.headers.get("content-type") || asset.mimeType;
    if (!type.toLowerCase().startsWith("image/") || /svg/i.test(type)) {
      throw new Error(`asset source is not a safe raster image: ${type}`);
    }
    source = await webStreamToBuffer(
      upstream.body,
      IMAGE_PREVIEW_MAX_SOURCE_BYTES,
      signal,
    );
  } else {
    const object = await getObjectStream(asset.storageKey, signal);
    const type = asset.mimeType || object.contentType;
    if (!type.toLowerCase().startsWith("image/") || /svg/i.test(type)) {
      throw new Error(`asset source is not a safe raster image: ${type}`);
    }
    source = await nodeStreamToBuffer(
      object.body,
      IMAGE_PREVIEW_MAX_SOURCE_BYTES,
      signal,
    );
  }
  const preview = await renderImagePreview(
    source,
    IMAGE_PREVIEW_WIDTH,
    signal,
  );
  const stored = await uploadBuffer(
    preview,
    "image/webp",
    `previews/${workspaceId}/canvas`,
    signal,
  );
  signal.throwIfAborted();

  // Do not let a late duplicate job replace the first immutable preview and
  // strand its object. updateMany makes the claim conditional and idempotent.
  const claimed = await prisma.asset.updateMany({
    where: { id: asset.id, workspaceId, previewStorageKey: null },
    data: { previewStorageKey: stored.key },
  });
  signal.throwIfAborted();
  if (claimed.count === 0) {
    const winner = await prisma.asset.findUnique({
      where: { id: asset.id },
      select: { previewStorageKey: true },
    });
    signal.throwIfAborted();
    return {
      assetId: asset.id,
      storageKey: winner?.previewStorageKey ?? stored.key,
    };
  }
  return { assetId: asset.id, storageKey: stored.key };
}

export async function runImagePreviewJob(
  job: Job<ImagePreviewJobData>,
): Promise<{ assetId: string; storageKey: string }> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    timer = setTimeout(
      () =>
        controller.abort(new Error("canvas preview generation timed out")),
      JOB_TIMEOUT_MS,
    );
    return await buildImagePreview(job, controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error("canvas preview generation timed out", { cause: err });
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createImagePreviewWorker() {
  const worker = new Worker<
    ImagePreviewJobData,
    { assetId: string; storageKey: string }
  >("image-preview", runImagePreviewJob, {
    connection,
    prefix: queuePrefix,
    concurrency: 2,
  });
  worker.on("failed", (job, err) => {
    console.error(`[image-preview] job ${job?.id} failed:`, err);
  });
  return worker;
}
