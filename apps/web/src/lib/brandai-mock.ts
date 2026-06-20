/**
 * BrandAI 一期前端 Mock 数据。
 *
 * 字段形状对齐 docs/05_数据字段与Mock数据说明.md 与 packages/contracts 的
 * 实体扩展（Campaign/Brand/Asset 业务字段）。一期页面先用它驱动视觉与交互，
 * 后续接 BFF 路由 / Prisma 真实数据时按同名字段替换数据源即可。
 *
 * 注意（CLAUDE.md §0）：这是开发期 mock，仅供页面骨架/视觉，不得作为"真出图"
 * 取证材料。真实出图走 worker → apps/ai → 真 provider。
 */

export interface BrandUser {
  userId: string;
  name: string;
  role: string;
  workspaceName: string;
  initial: string;
}

export const currentUser: BrandUser = {
  userId: "U001",
  name: "张晓宁",
  role: "市场总监",
  workspaceName: "LUMINA 品牌中心",
  initial: "宁",
};

export type NavKey =
  | "home"
  | "campaigns"
  | "brand-knowledge"
  | "assets"
  | "workspace";

export const navItems: { key: NavKey; label: string; href: string; icon: string }[] = [
  { key: "home", label: "首页", href: "/", icon: "✦" },
  { key: "campaigns", label: "Campaign 项目", href: "/campaigns", icon: "◳" },
  { key: "brand-knowledge", label: "品牌知识库", href: "/brand-knowledge", icon: "◎" },
  { key: "assets", label: "素材库", href: "/assets", icon: "▦" },
  { key: "workspace", label: "AI 工作台", href: "/workspace", icon: "✸" },
];

export const quickActions = [
  { title: "创建新 Campaign", desc: "用一句话描述需求，AI 帮你拆解立项", href: "/campaigns", icon: "✚" },
  { title: "导入品牌知识库", desc: "上传 Logo、色彩、调性，沉淀品牌规范", href: "/brand-knowledge", icon: "◎" },
  { title: "生成广告视觉", desc: "进入工作台，按品牌规范受控出图", href: "/workspace", icon: "✸" },
  { title: "优化已有设计", desc: "对现有素材做改写、扩展与再创作", href: "/workspace", icon: "✎" },
];

export type CampaignStatusKey = "DRAFT" | "IN_PROGRESS" | "COMPLETED";

export const statusMeta: Record<CampaignStatusKey, { label: string; tone: string }> = {
  DRAFT: { label: "草稿", tone: "warning" },
  IN_PROGRESS: { label: "进行中", tone: "primary" },
  COMPLETED: { label: "已完成", tone: "success" },
};

export interface Campaign {
  campaignId: string;
  campaignName: string;
  brandName: string;
  status: CampaignStatusKey;
  progress: number;
  description: string;
  tags: string[];
  channels: string[];
  startDate: string;
  endDate: string;
  aiSummary: string;
  cover: string; // gradient token for the thumbnail
}

export const campaigns: Campaign[] = [
  {
    campaignId: "C001",
    campaignName: "夏季新品上市 Campaign",
    brandName: "LUMINA",
    status: "IN_PROGRESS",
    progress: 40,
    description: "围绕夏季新品精华水的上市传播，强调清透水光与自然光感。",
    tags: ["新品上市", "产品认知"],
    channels: ["小红书", "抖音", "天猫"],
    startDate: "2025.05.01",
    endDate: "2025.06.30",
    aiSummary:
      "当前处于传播策略细化阶段：主视觉方向已确认，建议补充 3 套社媒延展图，并对天猫主图做卖点强化。",
    cover: "linear-gradient(135deg,#8B6CFF,#C9B6FF)",
  },
  {
    campaignId: "C002",
    campaignName: "品牌焕新视觉系统",
    brandName: "LUMINA",
    status: "DRAFT",
    progress: 12,
    description: "梳理品牌视觉语言，建立可复用的 KV 与版式系统。",
    tags: ["品牌焕新", "VI 系统"],
    channels: ["官网", "线下"],
    startDate: "2025.06.10",
    endDate: "2025.08.01",
    aiSummary:
      "立项初期：已导入历史视觉，建议先完成色彩与字体系统的确认，再展开 KV 设计。",
    cover: "linear-gradient(135deg,#7C5CFF,#A88CFF)",
  },
  {
    campaignId: "C003",
    campaignName: "618 电商主图专题",
    brandName: "LUMINA",
    status: "COMPLETED",
    progress: 100,
    description: "面向 618 大促的电商主图与卖点图批量产出。",
    tags: ["大促", "电商"],
    channels: ["天猫", "京东"],
    startDate: "2025.04.20",
    endDate: "2025.06.18",
    aiSummary: "已交付 24 张主图与 12 张卖点图，全部通过品牌一致性校验，可归档复用。",
    cover: "linear-gradient(135deg,#5B3FE0,#8B6CFF)",
  },
];

export interface RecommendedBrand {
  brandId: string;
  brandName: string;
  subtitle: string;
  tags: string[];
  cover: string;
}

export const recommendedBrands: RecommendedBrand[] = [
  { brandId: "B001", brandName: "LUMINA", subtitle: "光感净护品牌", tags: ["护肤", "高端"], cover: "linear-gradient(135deg,#8B6CFF,#E8DFFF)" },
  { brandId: "B002", brandName: "AURA", subtitle: "极简香氛", tags: ["香氛", "极简"], cover: "linear-gradient(135deg,#7C5CFF,#FFC8D6)" },
  { brandId: "B003", brandName: "VERDE", subtitle: "天然植护", tags: ["植物", "自然"], cover: "linear-gradient(135deg,#5B3FE0,#B6F0D8)" },
  { brandId: "B004", brandName: "NOIR", subtitle: "高端彩妆", tags: ["彩妆", "时尚"], cover: "linear-gradient(135deg,#3A2A7A,#C9B6FF)" },
];

export const brandKnowledge = {
  brandName: "LUMINA",
  positioning: "聚焦科学护肤的高端品牌",
  aiSummary:
    "LUMINA 是一个聚焦科学护肤的高端品牌，主张高效安全、纯净配方与专业可信。视觉上以紫色为主色、清透水光质感为核心，传递温柔关怀与科学理性的双重气质。",
  keywords: ["科学护肤", "高效安全", "纯净配方", "专业可信", "清透水光"],
  uploadCards: [
    { title: "Logo", desc: "PNG / SVG / JPG", icon: "◐" },
    { title: "品牌介绍", desc: "文档 / 文字", icon: "✎" },
    { title: "色彩值", desc: "HEX / 色卡", icon: "◉" },
    { title: "参考图", desc: "视觉风格参考", icon: "▦" },
    { title: "设计元素", desc: "图标 / 纹理", icon: "✦" },
    { title: "内容文案", desc: "口吻 / 话术", icon: "❝" },
  ],
  modules: [
    {
      title: "Logo 使用规范",
      icon: "◐",
      body: "标准组合 + 安全空间；最小尺寸 48px；禁止拉伸、禁止改色、禁止描边。",
    },
    {
      title: "品牌色彩系统",
      icon: "◉",
      body: "主色紫 #7C5CFF，点缀粉 #FFC8D6，中性深灰 #1A1A1F。",
      swatches: ["#7C5CFF", "#FFC8D6", "#1A1A1F", "#F4F0FF"],
    },
    {
      title: "字体规范",
      icon: "Aa",
      body: "标题：宋体风格；正文：黑体。中英文混排保持统一字重与行距。",
    },
    {
      title: "品牌语气",
      icon: "❝",
      body: "专业可信、科学为本、温柔关怀、清晰优雅、追求品质。",
    },
    {
      title: "视觉参考",
      icon: "▦",
      body: "自然光、清透水光质感、留白构图、低饱和点缀色。",
    },
    {
      title: "设计规范",
      icon: "✦",
      body: "栅格化版式、统一圆角、克制的图标系统与一致的质感语言。",
    },
  ],
};

export interface BrandAsset {
  assetId: string;
  fileName: string;
  fileType: string;
  category: string;
  tags: string[];
  aiTags: string[];
  resolution: string;
  fileSize: string;
  uploadTime: string;
  uploader: string;
  aiDescription: string;
  cover: string;
}

export const assetStats = [
  { label: "素材总数", value: "2,486" },
  { label: "近期上传", value: "128" },
  { label: "已收藏", value: "326" },
  { label: "AI 已标注", value: "1,932" },
];

export const assetFilters = ["全部", "图片", "视频", "文档", "产品图", "参考图"];

export const assets: BrandAsset[] = [
  {
    assetId: "A001",
    fileName: "lumina_toner_hero.jpg",
    fileType: "JPG",
    category: "产品图",
    tags: ["产品图", "主视觉"],
    aiTags: ["产品", "护肤水", "主视觉", "水光"],
    resolution: "1920 × 1280",
    fileSize: "1.8 MB",
    uploadTime: "2025.05.12 14:32",
    uploader: "张晓宁",
    aiDescription:
      "LUMINA 光透焕亮精华水主视觉，紫色瓶身搭配春季花卉元素，自然光，清透水光质感。",
    cover: "linear-gradient(135deg,#8B6CFF,#E8DFFF)",
  },
  { assetId: "A002", fileName: "spring_flower_ref.png", fileType: "PNG", category: "参考图", tags: ["参考图"], aiTags: ["花卉", "自然光", "柔和"], resolution: "1600 × 1200", fileSize: "1.2 MB", uploadTime: "2025.05.11 09:10", uploader: "张晓宁", aiDescription: "春季花卉参考图，柔和自然光，低饱和粉紫调，用于氛围铺垫。", cover: "linear-gradient(135deg,#7C5CFF,#FFC8D6)" },
  { assetId: "A003", fileName: "packaging_set.jpg", fileType: "JPG", category: "产品图", tags: ["产品图", "包装"], aiTags: ["包装", "套装", "高端"], resolution: "2048 × 1365", fileSize: "2.4 MB", uploadTime: "2025.05.10 16:48", uploader: "李航", aiDescription: "LUMINA 礼盒套装包装图，高端质感，适合电商主图与礼遇场景。", cover: "linear-gradient(135deg,#5B3FE0,#C9B6FF)" },
  { assetId: "A004", fileName: "social_poster_05.png", fileType: "PNG", category: "图片", tags: ["社媒"], aiTags: ["海报", "社媒", "排版"], resolution: "1080 × 1350", fileSize: "0.9 MB", uploadTime: "2025.05.09 11:20", uploader: "张晓宁", aiDescription: "小红书竖版海报，清透水光主视觉 + 卖点排版。", cover: "linear-gradient(135deg,#8B6CFF,#B6E3FF)" },
  { assetId: "A005", fileName: "texture_water.jpg", fileType: "JPG", category: "参考图", tags: ["纹理"], aiTags: ["水", "纹理", "质感"], resolution: "1920 × 1080", fileSize: "1.5 MB", uploadTime: "2025.05.08 18:02", uploader: "李航", aiDescription: "水光质感纹理素材，用于背景叠加与质感强化。", cover: "linear-gradient(135deg,#5B3FE0,#9CE0FF)" },
  { assetId: "A006", fileName: "model_shot_03.jpg", fileType: "JPG", category: "产品图", tags: ["人像"], aiTags: ["模特", "使用场景", "自然光"], resolution: "2000 × 1333", fileSize: "2.1 MB", uploadTime: "2025.05.07 10:36", uploader: "张晓宁", aiDescription: "模特使用场景图，自然光下的护肤瞬间，传递温柔关怀气质。", cover: "linear-gradient(135deg,#7C5CFF,#FFD6E0)" },
];

export const workspace = {
  breadcrumb: "夏季新品上市 Campaign / 社交广告图",
  current: { title: "初夏焕亮", cover: "linear-gradient(160deg,#8B6CFF 0%,#C9B6FF 60%,#FFE0EC 100%)" },
  variants: [
    { id: "VAR001", title: "初夏焕亮", cover: "linear-gradient(160deg,#8B6CFF,#C9B6FF)" },
    { id: "VAR002", title: "清透水光", cover: "linear-gradient(160deg,#7C5CFF,#9CE0FF)" },
    { id: "VAR003", title: "紫色花卉", cover: "linear-gradient(160deg,#5B3FE0,#FFC8D6)" },
    { id: "VAR004", title: "自然光影", cover: "linear-gradient(160deg,#8B6CFF,#FFE0B6)" },
  ],
  prompt:
    "为 LUMINA 夏季新品 Campaign 生成一张高端、清透、具有自然光感的社交媒体广告图，紫色瓶身为主体，搭配春季花卉元素与水光质感。",
  promptLimit: 500,
  styleKeywords: ["高端", "清透", "水光感", "柔和", "自然光"],
  brandConstraint: {
    name: "LUMINA 品牌规范",
    desc: "已应用品牌色、字体、Logo 安全空间与高端清透视觉规则。",
  },
  references: ["A001", "A002", "A005"],
  quota: { used: 2, limit: 20, remaining: 18 },
};
