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
import { deleteObject, getObjectStream, uploadBuffer } from "@/lib/s3";
import { mirrorGenerationVersionToAsset } from "@/lib/asset-mirror";
import { safeFetch } from "@/lib/ssrf";

export interface ImagePreviewJobData {
  workspaceId: string;
  versionId?: string;
  assetId?: string;
}

const JOB_TIMEOUT_MS = 60_000;
const CLEANUP_TIMEOUT_MS = 5_000;

const deleteUploadedPreview = (key: string) =>
  deleteObject(key, AbortSignal.timeout(CLEANUP_TIMEOUT_MS));

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
    if (!upstream.ok || !upstream.body) {
      await upstream.body?.cancel().catch(() => undefined);
      throw new Error(`asset source fetch failed: ${upstream.status}`);
    }
    const type = upstream.headers.get("content-type") || asset.mimeType;
    if (!type.toLowerCase().startsWith("image/")) {
      await upstream.body.cancel().catch(() => undefined);
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
    if (!type.toLowerCase().startsWith("image/")) {
      object.body.destroy();
      throw new Error(`asset source is not a safe raster image: ${type}`);
    }
    source = await nodeStreamToBuffer(
      object.body,
      IMAGE_PREVIEW_MAX_SOURCE_BYTES,
      signal,
    );
  }
  const preview = await renderImagePreview(source, IMAGE_PREVIEW_WIDTH, signal);
  const stored = await uploadBuffer(
    preview,
    "image/webp",
    `previews/${workspaceId}/canvas`,
    signal,
  );

  try {
    signal.throwIfAborted();
  } catch (err) {
    await deleteUploadedPreview(stored.key).catch((cleanupErr) =>
      console.error(
        `[image-preview] failed to clean aborted upload ${stored.key}:`,
        cleanupErr,
      ),
    );
    throw err;
  }

  // Do not let a late duplicate job replace the first immutable preview and
  // strand its object. updateMany makes the claim conditional and idempotent;
  // the losing upload is removed below.
  let claimed: { count: number };
  try {
    claimed = await prisma.asset.updateMany({
      where: { id: asset.id, workspaceId, previewStorageKey: null },
      data: { previewStorageKey: stored.key },
    });
  } catch (err) {
    await deleteUploadedPreview(stored.key).catch((cleanupErr) =>
      console.error(
        `[image-preview] failed to clean unclaimed upload ${stored.key}:`,
        cleanupErr,
      ),
    );
    throw err;
  }
  if (claimed.count === 0) {
    await deleteUploadedPreview(stored.key);
    const winner = await prisma.asset.findUnique({
      where: { id: asset.id },
      select: { previewStorageKey: true },
    });
    signal.throwIfAborted();
    if (!winner?.previewStorageKey) {
      throw new Error(
        `preview claim for asset ${asset.id} lost without winner`,
      );
    }
    return {
      assetId: asset.id,
      storageKey: winner.previewStorageKey,
    };
  }
  // The DB claim itself is not AbortSignal-aware. If it completed after the
  // outer watchdog won, retain the now-authoritative object but report this
  // attempt as timed out; the retry will immediately observe the stored key.
  signal.throwIfAborted();
  return { assetId: asset.id, storageKey: stored.key };
}

export async function runImagePreviewJob(
  job: Job<ImagePreviewJobData>,
): Promise<{ assetId: string; storageKey: string }> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeoutError = new Error("canvas preview generation timed out");
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(timeoutError);
        reject(timeoutError);
      }, JOB_TIMEOUT_MS);
    });
    // Abort-aware fetch/S3/Sharp operations stop themselves. Promise.race is
    // still required for Prisma waits (for example a locked preview claim), so
    // an unabortable dependency can never occupy a worker slot indefinitely.
    return await Promise.race([
      buildImagePreview(job, controller.signal),
      timeout,
    ]);
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(timeoutError.message, { cause: err });
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
