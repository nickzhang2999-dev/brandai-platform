import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { legacyStudioLocation } from "./lib/studio-navigation";

/**
 * 边缘门禁(binding · 防止公网烧 OpenAI key)。
 *
 * BrandAI 部署在公网(*.geole.me)。这层在 Auth.js 的 JWT 会话之上,把**整站**非
 * 公开路由都挡在会话之后——没有会话连页面/接口都到不了,自然碰不到出图/AI 路由,
 * 烧不了凭据。与 requireUser/布局守卫构成纵深防御(密钥+JWT 混合的 JWT 侧;OpenAI
 * key 另由 SETTINGS_ENC_KEY 加密存 DB、永不下发客户端)。
 *
 * 这里只校验会话 cookie 是否存在(Edge 运行时,不引 prisma);真实 JWT 校验仍在
 * 各 API 的 requireUser 与各布局的 auth() 守卫里。公开放行:登录页、Auth.js 端点、
 * 健康探针、Next 静态资源。
 */
const PUBLIC_PREFIXES = ["/login", "/api/auth", "/api/health"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // This narrow service boundary authenticates SHA256 bearer + active fixed
  // workspace editor in every route; it must not depend on browser cookies.
  if (/^\/api\/internal\/inspiration-analysis\/(?:config|jobs(?:\/(?:by-request\/[0-9a-fA-F-]{16,64}|[A-Za-z0-9_-]{1,128}(?:\/workflow-evidence)?))?)$/.test(pathname)) {
    return NextResponse.next();
  }

  if (
    PUBLIC_PREFIXES.some(
      (p) => pathname === p || pathname.startsWith(p + "/"),
    )
  ) {
    return NextResponse.next();
  }

  // The product homepage is Studio. Redirect before the legacy homepage's
  // layout runs, and retain workspace/project query parameters for deep links.
  const legacyLocation = legacyStudioLocation(pathname, req.nextUrl.searchParams);
  if (legacyLocation) return NextResponse.redirect(new URL(legacyLocation, req.url));

  const hasSession = req.cookies
    .getAll()
    .some((c) => c.name.includes("session-token"));
  if (hasSession) {
    // Replace any caller-supplied value; the server layout validates this URL
    // scope against membership before loading a brand. A cookie is only fallback.
    const requestHeaders = new Headers(req.headers);
    requestHeaders.delete("x-brandai-workspace-id");
    const workspaceId = req.nextUrl.searchParams.get("workspaceId");
    if (workspaceId !== null) requestHeaders.set("x-brandai-workspace-id", encodeURIComponent(workspaceId));
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  if (pathname.startsWith("/api/") || /^\/(studio\/|compare\/api(?:\/|$)|workflow(?:\/|$))/.test(pathname)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  url.searchParams.set("callbackUrl", pathname + req.nextUrl.search);
  return NextResponse.redirect(url);
}

export const config = {
  // 跳过 Next 静态资源与带扩展名的文件;其余全部过门禁。
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.[\\w]+$).*)"],
};
