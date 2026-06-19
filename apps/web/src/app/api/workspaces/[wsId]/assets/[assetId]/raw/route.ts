import { Readable } from "node:stream";
import { prisma } from "@brandai/db";
import { ApiException, handleError, requireUser } from "@/lib/api";
import { requireOwnedWorkspace } from "@/lib/workspace";
import { safeFetch } from "@/lib/ssrf";
import { getObjectStream } from "@/lib/s3";

/**
 * M-A · 资产公网代理 — streams an asset's bytes back over the canonical public
 * domain. The stored origin (MinIO for uploads, the source site for ingested
 * WEBSITE assets) is not reachable from a public browser; this same-origin
 * route lets the BFF fetch the object server-side and relay it. Ownership is
 * enforced per request (the session cookie travels with same-origin <img>
 * loads), so no storage bucket is ever exposed publicly. DoD D1.
 *
 * Two storage shapes are served:
 * - UPLOAD assets: `storageKey` is an S3 object key → read via the S3 client.
 * - WEBSITE assets: `storageKey`/`url` is an absolute URL → fetch server-side.
 */
function isAbsoluteUrl(s: string): boolean {
  return /^https?:\/\//i.test(s) || s.startsWith("data:");
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ wsId: string; assetId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId, assetId } = await params;
    await requireOwnedWorkspace(wsId, user.id);

    const asset = await prisma.asset.findUnique({ where: { id: assetId } });
    if (!asset || asset.workspaceId !== wsId) {
      throw new ApiException(404, "Asset not found");
    }

    const cacheControl = "private, max-age=3600";

    if (isAbsoluteUrl(asset.storageKey) || isAbsoluteUrl(asset.url)) {
      const src = isAbsoluteUrl(asset.url) ? asset.url : asset.storageKey;
      // SSRF 纵深防御:手动跟随重定向并逐跳校验(含历史数据里的内网地址 +
      // 公网 URL 302 跳内网的重定向型 SSRF)。
      const upstream = await safeFetch(src);
      if (!upstream.ok || !upstream.body) {
        throw new ApiException(502, "Failed to fetch source asset");
      }
      const contentType =
        upstream.headers.get("content-type") ??
        (asset.mimeType && asset.mimeType !== "image/*"
          ? asset.mimeType
          : "application/octet-stream");
      return new Response(upstream.body, {
        headers: {
          "content-type": contentType,
          "cache-control": cacheControl,
          // 防嗅探:即便 content-type 被伪造成 HTML 也不会被浏览器当页面执行。
          "x-content-type-options": "nosniff",
        },
      });
    }

    const { body, contentType, contentLength } = await getObjectStream(
      asset.storageKey,
    );
    return new Response(Readable.toWeb(body) as ReadableStream, {
      headers: {
        "content-type":
          asset.mimeType && asset.mimeType !== "image/*"
            ? asset.mimeType
            : contentType,
        ...(contentLength ? { "content-length": String(contentLength) } : {}),
        "cache-control": cacheControl,
        "x-content-type-options": "nosniff",
      },
    });
  } catch (err) {
    return handleError(err);
  }
}
