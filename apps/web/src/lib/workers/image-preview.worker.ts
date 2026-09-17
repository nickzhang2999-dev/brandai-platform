import { Worker, type Job } from "bullmq";
import { prisma } from "@brandai/db";
import { connection, queuePrefix } from "@/lib/queue";
import {
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
): Promise<{ assetId: string; storageKey: string }> {
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
          url: true,
          mimeType: true,
          previewStorageKey: true,
        },
      })
    : null;

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
            url: true,
            mimeType: true,
            previewStorageKey: true,
          },
        },
      },
    });
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
      asset = await prisma.asset.findFirst({
        where: { workspaceId, generationVersionId: versionId },
        select: {
          id: true,
          storageKey: true,
          url: true,
          mimeType: true,
          previewStorageKey: true,
        },
      });
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
    return { assetId: asset.id, storageKey: asset.previewStorageKey };
  }

  // Match the canonical raw route: legacy WEBSITE rows can keep the remote
  // source in `url` while `storageKey` is only a placeholder.
  const sourceLocation = /^https?:\/\//i.test(asset.url)
    ? asset.url
    : asset.storageKey;
  let source: Buffer;
  if (/^https?:\/\//i.test(sourceLocation)) {
    const upstream = await safeFetch(sourceLocation);
    if (!upstream.ok || !upstream.body)
      throw new Error(`asset source fetch failed: ${upstream.status}`);
    const type = upstream.headers.get("content-type") || asset.mimeType;
    if (!type.toLowerCase().startsWith("image/") || /svg/i.test(type)) {
      throw new Error(`asset source is not a safe raster image: ${type}`);
    }
    source = await webStreamToBuffer(upstream.body);
  } else {
    const object = await getObjectStream(asset.storageKey);
    const type = asset.mimeType || object.contentType;
    if (!type.toLowerCase().startsWith("image/") || /svg/i.test(type)) {
      throw new Error(`asset source is not a safe raster image: ${type}`);
    }
    source = await nodeStreamToBuffer(object.body);
  }
  const preview = await renderImagePreview(source, IMAGE_PREVIEW_WIDTH);
  const stored = await uploadBuffer(
    preview,
    "image/webp",
    `previews/${workspaceId}/canvas`,
  );

  // Do not let a late duplicate job replace the first immutable preview and
  // strand its object. updateMany makes the claim conditional and idempotent.
  const claimed = await prisma.asset.updateMany({
    where: { id: asset.id, workspaceId, previewStorageKey: null },
    data: { previewStorageKey: stored.key },
  });
  if (claimed.count === 0) {
    const winner = await prisma.asset.findUnique({
      where: { id: asset.id },
      select: { previewStorageKey: true },
    });
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
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      buildImagePreview(job),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("canvas preview generation timed out")),
          JOB_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createImagePreviewWorker() {
  return new Worker<
    ImagePreviewJobData,
    { assetId: string; storageKey: string }
  >("image-preview", runImagePreviewJob, {
    connection,
    prefix: queuePrefix,
    concurrency: 2,
  });
}
