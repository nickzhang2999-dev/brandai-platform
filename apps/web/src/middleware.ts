import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

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

  if (
    PUBLIC_PREFIXES.some(
      (p) => pathname === p || pathname.startsWith(p + "/"),
    )
  ) {
    return NextResponse.next();
  }

  const hasSession = req.cookies
    .getAll()
    .some((c) => c.name.includes("session-token"));
  if (hasSession) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("callbackUrl", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  // 跳过 Next 静态资源与带扩展名的文件;其余全部过门禁。
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.[\\w]+$).*)"],
};
