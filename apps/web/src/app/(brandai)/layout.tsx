import { BrandSidebar } from "./brand-sidebar";

/**
 * BrandAI 产品页路由组布局：5 个核心页面（首页 / Campaign / 品牌知识库 /
 * 素材库 / AI 工作台）共用紫色侧栏壳。一期用 mock 数据驱动（见
 * src/lib/brandai-mock.ts），未接 auth；后续按需接 (app) 同款会话守卫。
 */
export default function BrandaiLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <BrandSidebar>{children}</BrandSidebar>;
}
