import { prisma } from "@brandai/db";
import { ApiException, handleError, requireUser } from "@/lib/api";
import {
  imagePreviewEtag,
  imagePreviewHeaders,
  nodeStreamToBuffer,
  parseImagePreviewWidth,
  renderImagePreview,
  webStreamToBuffer,
} from "@/lib/image-preview";
import { getObjectStream } from "@/lib/s3";
import { safeFetch } from "@/lib/ssrf";
import { requireWorkspaceRole } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATA_URL_RE = /^data:([^;,]+)(;base64)?,([\s\S]*)$/;

function decodeDataUrl(url: string): Buffer | null {
  const match = DATA_URL_RE.exec(url);
  if (!match) return null;
  const payload = match[3] ?? "";
  return match[2]
    ? Buffer.from(payload, "base64")
    : Buffer.from(decodeURIComponent(payload), "utf8");
}

/**
 * Authenticated, bounded canvas preview. GenerationVersion.imageUrl remains
 * the full-quality source of truth for edits and exports; the browser receives
 * a small WebP here so a project with a long history does not download every
 * original before showing its canvas.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ wsId: string; versionId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId, versionId } = await params;
    await requireWorkspaceRole(wsId, user.id, "VIEWER");

    const [version, mirror] = await Promise.all([
      prisma.generationVersion.findFirst({
        where: { id: versionId, generation: { workspaceId: wsId } },
        select: { imageUrl: true },
      }),
      prisma.asset.findFirst({
        where: { workspaceId: wsId, generationVersionId: versionId },
        select: { storageKey: true },
      }),
    ]);
    if (!version) throw new ApiException(404, "Generation version not found");

    const width = parseImagePreviewWidth(req) ?? 768;
    const etag = imagePreviewEtag(`version-${versionId}`, width);
    if (req.headers.get("if-none-match") === etag) {
      return new Response(null, {
        status: 304,
        headers: imagePreviewHeaders(etag),
      });
    }

    // Generated versions are normally mirrored into Asset. Prefer its object
    // key so the BFF reads the configured store directly instead of making a
    // second public HTTP hop. Legacy rows fall back to their immutable URL.
    let source: Buffer;
    if (mirror?.storageKey) {
      const object = await getObjectStream(mirror.storageKey);
      source = await nodeStreamToBuffer(object.body);
    } else {
      const inline = decodeDataUrl(version.imageUrl);
      if (inline) {
        source = inline;
      } else {
        const upstream = await safeFetch(version.imageUrl);
        if (!upstream.ok || !upstream.body) {
          throw new ApiException(502, "Failed to fetch generation image");
        }
        const upstreamType = upstream.headers.get("content-type") ?? "";
        if (!upstreamType.toLowerCase().startsWith("image/")) {
          throw new ApiException(415, "Generation source is not an image");
        }
        source = await webStreamToBuffer(upstream.body);
      }
    }

    const preview = await renderImagePreview(source, width);
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
