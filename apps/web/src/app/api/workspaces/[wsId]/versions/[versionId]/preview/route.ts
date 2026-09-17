import { prisma } from "@brandai/db";
import { ApiException, handleError, requireUser } from "@/lib/api";
import {
  IMAGE_PREVIEW_WIDTH,
  imagePreviewEtag,
  imagePreviewHeaders,
  nodeStreamToBuffer,
} from "@/lib/image-preview";
import { getObjectStream } from "@/lib/s3";
import { imagePreviewQueue } from "@/lib/queue";
import { requireWorkspaceRole } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Authenticated canvas preview. The expensive source fetch + Sharp conversion
 * happens only in image-preview.worker; this handler authorizes and serves the
 * already-bounded WebP. A cache miss is enqueued and answered immediately so a
 * slow object origin can never hold a Next request open indefinitely.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ wsId: string; versionId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId, versionId } = await params;
    await requireWorkspaceRole(wsId, user.id, "VIEWER");

    const version = await prisma.generationVersion.findFirst({
      where: { id: versionId, generation: { workspaceId: wsId } },
      select: {
        mirrorAsset: {
          select: { id: true, previewStorageKey: true },
        },
      },
    });
    if (!version) throw new ApiException(404, "Generation version not found");

    const mirror = version.mirrorAsset;
    if (!mirror?.previewStorageKey) {
      await imagePreviewQueue.add(
        "build",
        { workspaceId: wsId, versionId },
        {
          jobId: `version-${versionId}`,
          attempts: 3,
          backoff: { type: "exponential", delay: 2_000 },
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
      return Response.json(
        { status: "PENDING", message: "Canvas preview is being prepared" },
        { status: 202, headers: { "retry-after": "2" } },
      );
    }

    const etag = imagePreviewEtag(
      `version-${versionId}-${mirror.id}`,
      IMAGE_PREVIEW_WIDTH,
      "v2",
    );
    if (req.headers.get("if-none-match") === etag) {
      return new Response(null, {
        status: 304,
        headers: imagePreviewHeaders(etag),
      });
    }

    const object = await getObjectStream(mirror.previewStorageKey);
    // Worker output is normally a few dozen KiB. Keep a defensive 4 MiB cap so
    // corrupt object metadata cannot turn this read path into an unbounded one.
    const preview = await nodeStreamToBuffer(object.body, 4 * 1024 * 1024);
    return new Response(new Uint8Array(preview), {
      headers: {
        "content-type": "image/webp",
        ...imagePreviewHeaders(etag, preview.byteLength),
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return handleError(error);
  }
}
