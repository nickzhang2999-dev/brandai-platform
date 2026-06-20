import { prisma } from "@brandai/db";

/**
 * BrandAI 一期「当前品牌」解析。
 *
 * BrandAI 的 5 个产品页是扁平 URL（/、/campaigns…），不带 wsId；但后端是
 * workspace 作用域的（一个 Brand = 一个 BrandWorkspace）。一期为 1-2 家品牌的
 * 专属定制场景，这里把"当前品牌"解析为该用户拥有的第一个 workspace；没有就
 * 自动建一个默认品牌（含 owner 的 Membership，与 POST /api/workspaces 一致）。
 * 后续多品牌时换成品牌切换器即可，页面只依赖返回的 { id, name }。
 */
export async function getOrCreateActiveBrand(userId: string): Promise<{
  id: string;
  name: string;
}> {
  const existing = await prisma.brandWorkspace.findFirst({
    where: { ownerId: userId },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true },
  });
  if (existing) return existing;

  const created = await prisma.brandWorkspace.create({
    data: { ownerId: userId, name: "我的品牌" },
    select: { id: true, name: true },
  });
  await prisma.membership.create({
    data: { userId, workspaceId: created.id, role: "OWNER" },
  });
  return created;
}
