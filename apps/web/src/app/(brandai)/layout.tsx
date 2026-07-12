import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@brandai/db";
import { auth } from "@/auth";
import { isAdminUser } from "@/lib/admin";
import { getOrCreateActiveBrand } from "@/lib/brandai";
import { ACTIVE_BRAND_COOKIE } from "@/lib/brand-cookie";
import { BrandProvider } from "./brand-context";
import { BrandSidebar } from "./brand-sidebar";

/**
 * BrandAI 产品页路由组布局：核心页面（首页 / 项目 / 品牌套件 /
 * 素材库 / AI 工作台）共用紫色侧栏壳。
 *
 * 服务端守卫：未登录 → /login；登录后解析"当前品牌"(workspace) 注入
 * BrandProvider，页面据此调真实 BFF 接口（不再用 mock）。
 */
export default async function BrandaiLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  // 与 (app) 壳和 API 网关一致：JWT 是无状态的，被管理员停用的账号在 token 过期前
  // 仍能带出有效会话。这里在渲染产品壳 / 自动建默认品牌之前先查 DB，停用即弹回登录，
  // 避免为停用用户创建 workspace。
  const dbUser = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { email: true, isActive: true, name: true },
  });
  if (!dbUser || dbUser.isActive === false) redirect("/login");

  // Server-authoritative active brand: the client switcher writes the chosen
  // workspace id into ACTIVE_BRAND_COOKIE; we re-validate membership before
  // honoring it (see getOrCreateActiveBrand), so SSR / refresh / deep links all
  // resolve the same brand the user picked.
  const preferredWsId = (await cookies()).get(ACTIVE_BRAND_COOKIE)?.value;
  const brand = await getOrCreateActiveBrand(session.user.id, preferredWsId);
  const email = dbUser.email ?? session.user.email ?? "";
  const name = dbUser.name ?? email.split("@")[0] ?? "用户";
  const initial = (name || email || "U").trim().slice(0, 1).toUpperCase();
  const user = { name, email, initial };

  // Only platform admins get the 管理后台 entry in the user menu; everyone else
  // sees personal 账号设置 only. The admin console + its APIs re-check this, so
  // this just hides an entry non-admins can't use.
  const isAdmin = await isAdminUser(session.user.id, session.user.email);

  return (
    <BrandProvider value={{ wsId: brand.id, brandName: brand.name, user }}>
      <BrandSidebar user={user} isAdmin={isAdmin}>
        {children}
      </BrandSidebar>
    </BrandProvider>
  );
}
