# BrandAI AI 图片生成平台｜数据字段与 Mock 数据说明 v0.1

## 一、文档说明

本文档定义 BrandAI 一期前端 Demo 所需的数据字段、Mock 数据结构、页面数据来源、字段命名规则与前端开发使用方式。

## 二、Mock 文件结构

```text
src/data
├─ user.json
├─ navigation.json
├─ quickActions.json
├─ campaigns.json
├─ brands.json
├─ brandKnowledge.json
├─ assets.json
├─ assetStats.json
├─ workspace.json
├─ notifications.json
└─ mockIndex.ts
```

## 三、命名规则

| 类型 | 规则 | 示例 |
|---|---|---|
| 字段命名 | camelCase | campaignName |
| ID 命名 | 业务前缀 + 数字 | C001、B001、A001 |
| 日期格式 | YYYY.MM.DD 或 ISO 字符串 | 2025.05.12 |
| 图片路径 | public/images 下相对路径 | /images/campaign-001.png |
| 状态值 | 中文展示值 + 英文枚举可选 | 进行中 / in_progress |

## 四、用户数据 User

| 字段 | 类型 | 必填 | 说明 | 示例 |
|---|---|---|---|---|
| userId | string | 是 | 用户 ID | U001 |
| name | string | 是 | 用户姓名 | 张晓宁 |
| englishName | string | 否 | 英文名 | Xiaoning Zhang |
| role | string | 是 | 用户角色 / 职位 | Market Director |
| avatar | string | 是 | 用户头像 | /images/avatar-xiaoning.png |
| email | string | 否 | 用户邮箱 | xiaoning@lumina.com |
| workspaceId | string | 是 | 当前工作空间 ID | WKS001 |
| workspaceName | string | 是 | 当前工作空间名称 | LUMINA 品牌中心 |

## 五、导航数据 Navigation

左侧导航数据必须为：首页、Campaign 项目、品牌知识库、素材库、模板库、工作台。不允许出现创意灵感。

## 六、快捷操作 QuickAction

首页快捷操作只保留四个：创建新 Campaign、导入品牌知识库、生成广告视觉、优化现有设计。

## 七、Campaign 字段

| 字段 | 类型 | 必填 | 说明 | 示例 |
|---|---|---|---|---|
| campaignId | string | 是 | Campaign 项目 ID | C001 |
| campaignName | string | 是 | 项目名称 | 夏季新品上市 Campaign |
| brandId | string | 是 | 所属品牌 ID | B001 |
| brandName | string | 是 | 所属品牌名称 | LUMINA |
| status | string | 是 | 中文状态 | 进行中 |
| statusCode | string | 是 | 状态枚举 | in_progress |
| progress | number | 是 | 项目进度 0-100 | 40 |
| coverImage | string | 是 | 项目封面图 | /images/campaign-summer.png |
| description | string | 是 | 项目描述 | 围绕夏季新品精华水的上市传播 |
| tags | string[] | 否 | 项目标签 | ["新品上市", "产品认知"] |
| channels | string[] | 否 | 投放渠道 | ["小红书", "抖音", "天猫"] |
| startDate | string | 是 | 开始日期 | 2025.05.01 |
| endDate | string | 是 | 结束日期 | 2025.06.30 |
| aiSummary | string | 否 | AI 项目摘要 | 当前处于传播策略细化阶段 |

## 八、推荐品牌字段

| 字段 | 类型 | 必填 | 说明 | 示例 |
|---|---|---|---|---|
| brandId | string | 是 | 品牌 ID | B001 |
| brandName | string | 是 | 品牌名称 | LUMINA |
| subtitle | string | 是 | 品牌定位短语 | 光感净护品牌 |
| description | string | 是 | 品牌描述 | 专注于光感护肤科技研究 |
| coverImage | string | 是 | 品牌图片 | /images/brand-lumina.png |
| tags | string[] | 否 | 品牌标签 | ["护肤", "高端"] |
| isVerified | boolean | 否 | 是否认证 / 推荐 | true |
| actionText | string | 否 | 操作文案 | 查看品牌 |

## 九、品牌知识库字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| brandId | string | 是 | 品牌 ID |
| brandName | string | 是 | 品牌名称 |
| slogan | string | 否 | 品牌口号 |
| positioning | string | 是 | 品牌定位 |
| targetAudience | string | 否 | 目标人群 |
| logoRules | object | 是 | Logo 使用规范 |
| colorSystem | object | 是 | 色彩系统 |
| typography | object | 是 | 字体系统 |
| toneOfVoice | object | 是 | 品牌语调 |
| visualReferences | array | 是 | 视觉参考 |
| designRules | array | 是 | 设计规范 |
| aiSummary | string | 是 | AI 知识摘要 |
| keywords | string[] | 是 | 核心关键词 |

## 十、素材库字段

| 字段 | 类型 | 必填 | 说明 | 示例 |
|---|---|---|---|---|
| assetId | string | 是 | 素材 ID | A001 |
| fileName | string | 是 | 文件名 | lumina_toner_hero.jpg |
| fileType | string | 是 | 文件类型 | JPG |
| category | string | 是 | 素材分类 | 产品图 |
| thumbnail | string | 是 | 缩略图路径 | /images/assets/a001.png |
| previewImage | string | 是 | 预览图路径 | /images/assets/a001-large.png |
| tags | string[] | 否 | 标签 | ["产品图", "主视觉"] |
| aiTags | string[] | 否 | AI 标签 | ["产品", "护肤水"] |
| resolution | string | 否 | 分辨率 | 1920 × 1280 |
| fileSize | string | 否 | 文件大小 | 1.8 MB |
| uploadTime | string | 是 | 上传时间 | 2025.05.12 14:32 |
| uploader | string | 是 | 上传者 | 张晓宁 |
| isFavorite | boolean | 否 | 是否收藏 | true |
| aiDescription | string | 否 | AI 生成描述 | 紫色瓶身搭配春季花卉元素 |
| usageRecords | array | 否 | 使用记录 | Campaign 使用列表 |

## 十一、工作台字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| workspaceId | string | 是 | 工作台任务 ID |
| campaignId | string | 是 | 所属 Campaign |
| campaignName | string | 是 | Campaign 名称 |
| designType | string | 是 | 设计类型 |
| breadcrumb | string | 是 | 顶部路径 |
| currentImage | object | 是 | 当前画布图片 |
| variants | array | 是 | 生成变体列表 |
| prompt | string | 是 | 当前提示词 |
| promptLimit | number | 是 | 提示词字数限制 |
| styleKeywords | string[] | 是 | 风格关键词 |
| brandConstraint | object | 是 | 品牌约束 |
| referenceAssets | array | 是 | 参考素材 |
| quota | object | 是 | 生成额度 |

## 十二、API 预留

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/user/current | 获取当前用户 |
| GET | /api/campaigns | 获取 Campaign 列表 |
| POST | /api/campaigns | 创建 Campaign |
| GET | /api/brands/:id/knowledge | 获取品牌知识库 |
| POST | /api/brands/:id/knowledge/upload | 上传品牌资料 |
| GET | /api/assets | 获取素材列表 |
| POST | /api/assets/upload | 上传素材 |
| GET | /api/workspace/:campaignId | 获取工作台数据 |
| POST | /api/workspace/generate | 提交制作 |
