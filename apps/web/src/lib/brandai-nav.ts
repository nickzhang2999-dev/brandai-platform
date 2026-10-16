/** Live product navigation and plan display constants. No fixture entities. */

export type NavKey =
  | "home"
  | "campaigns"
  | "brand-knowledge"
  | "assets"
  | "workspace"
  | "generated"
  | "templates"
  | "members";

export const navItems: {
  key: NavKey;
  label: string;
  href: string;
  icon: string;
  hidden?: boolean;
}[] = [
  { key: "home", label: "首页", href: "/studio", icon: "✦" },
  { key: "campaigns", label: "项目", href: "/campaigns", icon: "◳" },
  { key: "brand-knowledge", label: "品牌套件", href: "/brand-knowledge", icon: "◎" },
  { key: "workspace", label: "AI 工作台", href: "/studio#/projects", icon: "✸" },
  { key: "generated", label: "生成图", href: "/generated", icon: "▧" },
  { key: "templates", label: "模板库", href: "/templates", icon: "▱" },
  { key: "assets", label: "素材库", href: "/assets", icon: "▦" },
  // G6 · 成员/协作管理 — 团队成员邀请 + 角色管理（接真实 /members BFF）。
  { key: "members", label: "成员协作", href: "/members", icon: "◍", hidden: true },
];

export const quickActions = [
  { title: "创建新项目", desc: "用一句话描述需求，AI 帮你拆解立项", href: "/campaigns", icon: "✚" },
  { title: "导入品牌套件", desc: "上传 logo、字体、颜色与品牌指南，沉淀品牌规范", href: "/brand-knowledge", icon: "◎" },
  { title: "生成广告视觉", desc: "进入工作台，按品牌规范受控出图", href: "/studio#/projects", icon: "✸" },
  { title: "优化已有设计", desc: "对现有素材做改写、扩展与再创作", href: "/studio#/projects", icon: "✎" },
];

export interface PlanTier {
  planKey: string;
  name: string;
  priceLabel: string;
  highlight?: boolean;
  features: string[];
}

export const planTiers: PlanTier[] = [
  {
    planKey: "FREE",
    name: "体验版",
    priceLabel: "免费",
    features: ["每日少量出图额度", "品牌套件与项目管理", "基础模板库"],
  },
  {
    planKey: "PRO",
    name: "专业版",
    priceLabel: "联系销售",
    highlight: true,
    features: [
      "大幅提升每日 / 每周期出图额度",
      "多尺寸渠道批量出图",
      "完整改图与交付导出",
      "优先 AI provider 通道",
    ],
  },
  {
    planKey: "ENTERPRISE",
    name: "企业版",
    priceLabel: "定制",
    features: [
      "不限量出图额度",
      "多品牌 / 多团队协作",
      "专属合规与品牌约束",
      "专属支持与 SLA",
    ],
  },
];

/** H12 — 升级联系方式（产品常量，无真实计费时的诚实出口）。 */
export function configuredUpgradeContact(value: string | undefined): string | null {
  const candidate = value?.trim();
  return candidate && /^[^\s@?&#]+@[^\s@?&#]+\.[^\s@?&#]+$/.test(candidate) ? candidate : null;
}
export const upgradeContactEmail = configuredUpgradeContact(process.env.NEXT_PUBLIC_UPGRADE_CONTACT);

export type CampaignStatusKey = "DRAFT" | "IN_PROGRESS" | "COMPLETED";

export const statusMeta: Record<CampaignStatusKey, { label: string; tone: string }> = {
  DRAFT: { label: "草稿", tone: "warning" },
  IN_PROGRESS: { label: "进行中", tone: "primary" },
  COMPLETED: { label: "已完成", tone: "success" },
};
