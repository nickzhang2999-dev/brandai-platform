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

/**
 * 可安全内联渲染的图片类型:光栅图。**排除 SVG**——SVG 是活动内容,直接打开会在
 * app 同源执行脚本(存储型 XSS),必须走附件下载。
 */
function inlineSafeImage(contentType: string): boolean {
  const t = (contentType || "").toLowerCase();
  return t.startsWith("image/") && !t.includes("svg");
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
      const upstreamType =
        upstream.headers.get("content-type") ??
        (asset.mimeType && asset.mimeType !== "image/*"
          ? asset.mimeType
          : "application/octet-stream");
      // 资产代理只应回放图片。WEBSITE 资产的 upstream content-type 不可信:显式
      // text/html 即使带 nosniff 也会在同源被当页面执行(存储型 XSS)。非图片一律
      // 降级为 octet-stream + attachment,绝不在 app 源下内联渲染。
      const isImg = inlineSafeImage(upstreamType);
      const headers: Record<string, string> = {
        "content-type": isImg ? upstreamType : "application/octet-stream",
        "cache-control": cacheControl,
        "x-content-type-options": "nosniff",
      };
      if (!isImg) headers["content-disposition"] = "attachment";
      return new Response(upstream.body, { headers });
    }

    const { body, contentType, contentLength } = await getObjectStream(
      asset.storageKey,
    );
    // 上传端接受任意 File 并原样存 mimeType:上传 text/html 经此 /raw 会在 app 源
    // 内联执行(存储型 XSS)。与 WEBSITE 分支同策:非图片降级 octet-stream + 附件。
    const resolvedType =
      asset.mimeType && asset.mimeType !== "image/*" ? asset.mimeType : contentType;
    const isImg = inlineSafeImage(resolvedType || "");
    const headers: Record<string, string> = {
      "content-type": isImg ? resolvedType : "application/octet-stream",
      ...(contentLength ? { "content-length": String(contentLength) } : {}),
      "cache-control": cacheControl,
      "x-content-type-options": "nosniff",
    };
    if (!isImg) headers["content-disposition"] = "attachment";
    return new Response(Readable.toWeb(body) as ReadableStream, { headers });
  } catch (err) {
    return handleError(err);
  }
}
