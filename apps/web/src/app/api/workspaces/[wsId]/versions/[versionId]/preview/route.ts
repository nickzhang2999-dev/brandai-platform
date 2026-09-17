import { prisma } from "@brandai/db";
import { ApiException, handleError, requireUser } from "@/lib/api";
import {
  IMAGE_PREVIEW_WIDTH,
  imagePreviewEtag,
  imagePreviewHeaders,
  nodeStreamToBuffer,
} from "@/lib/image-preview";
import { getObjectStream } from "@/lib/s3";
import { enqueueImagePreview } from "@/lib/queue";
import { getEffectiveStorage } from "@/lib/settings";
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
        imageUrl: true,
        mirrorAsset: {
          select: { id: true, previewStorageKey: true },
        },
      },
    });
    if (!version) throw new ApiException(404, "Generation version not found");

    const mirror = version.mirrorAsset;
    if (!mirror?.previewStorageKey) {
      // Hosted provider URLs and objects on a retired storage domain cannot be
      // mirrored into the currently configured bucket. Redirect immediately
      // to the already-supported original source instead of polling a preview
      // job that can never persist a previewStorageKey.
      if (/^https?:\/\//i.test(version.imageUrl)) {
        const storage = await getEffectiveStorage();
        const publicBase = storage.publicUrl.replace(/\/+$/, "");
        const belongsToCurrentStorage =
          storage.configured &&
          Boolean(publicBase) &&
          version.imageUrl.startsWith(`${publicBase}/`);
        if (!belongsToCurrentStorage) {
          return new Response(null, {
            status: 307,
            headers: {
              location: version.imageUrl,
              "cache-control": "private, max-age=3600",
              "referrer-policy": "no-referrer",
              vary: "Cookie",
            },
          });
        }
      }
      await enqueueImagePreview({ workspaceId: wsId, versionId });
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

    const readSignal = AbortSignal.timeout(10_000);
    const object = await getObjectStream(mirror.previewStorageKey, readSignal);
    // Worker output is normally a few dozen KiB. Keep a defensive 4 MiB cap so
    // corrupt object metadata cannot turn this read path into an unbounded one.
    const preview = await nodeStreamToBuffer(
      object.body,
      4 * 1024 * 1024,
      readSignal,
    );
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
