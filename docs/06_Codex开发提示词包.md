# BrandAI AI 图片生成平台｜Codex 开发提示词包 v0.1

## 一、文档说明

本文档用于指导 Codex 或技术团队基于既有产品文档，逐步生成 BrandAI AI 图片生成平台一期前端 Demo 工程。

当前目标不是一次性开发完整生产系统，而是先完成：可点击、可跳转、可演示、视觉高度还原的前端高保真 Demo。

## 二、Prompt 0｜项目上下文总提示词

```text
你正在开发一个名为 BrandAI 的 AI 图片生成平台前端 Demo。

项目定位：BrandAI 是一套面向品牌方自用场景的 AI 驱动型品牌广告素材设计平台，围绕 Campaign 营销项目，帮助用户通过品牌知识库、素材库和 AI 工作台完成广告素材生成、修改、复用和归档。

一期目标：完成一个可点击、可跳转、可演示的高保真前端 Demo，不接真实后端，不接真实 AI 生图接口，全部使用本地 Mock JSON 数据。

技术栈：React、TypeScript、Vite、Tailwind CSS、React Router、lucide-react、本地 JSON Mock 数据。

一期页面：/ 首页、/campaigns Campaign 项目页、/brand-knowledge 品牌知识库、/assets 素材库、/workspace 工作台。

统一左侧导航：首页、Campaign 项目、品牌知识库、素材库、模板库、工作台。

重要命名规则：不要出现“创意灵感”一级导航；“品牌资产”统一改为“品牌知识库”；“图片设计编辑页”统一改为“工作台”。

视觉风格：高端、简约、留白、AI 原生、浅色背景、蓝紫强调色、柔和阴影、大圆角卡片、商业品牌摄影感。
```

## 三、Prompt 1｜初始化项目

```text
请初始化 BrandAI 前端项目。使用 React + TypeScript + Vite 创建项目，安装并配置 Tailwind CSS、react-router-dom、lucide-react。建立 src/pages、src/components、src/data、src/types、src/layouts、src/styles。配置 /、/campaigns、/brand-knowledge、/assets、/workspace 五个路由。确保 npm run dev 可以正常启动。
```

## 四、Prompt 2｜建立全局视觉 Token 与基础样式

```text
请为 BrandAI 项目建立全局 UI 视觉规范和基础样式。扩展 Tailwind 色彩：primary #7C5CFF、violet #8B6CFF、lavender #F4F0FF、pageBg #FAFAFC、cardBg #FFFFFF、textPrimary #1F1F2A、textSecondary #6B6B7A、borderLight #ECECF3。设置全局字体、背景、阴影和滚动条样式。
```

## 五、Prompt 3｜建立全局 Layout 与左侧导航

```text
请开发 BrandAI 的全局 AppLayout 和 Sidebar。左侧导航固定为：首页、Campaign 项目、品牌知识库、素材库、模板库、工作台。不要出现“创意灵感”。当前路由菜单高亮。底部显示用户头像、姓名“张晓宁”、职位“Market Director”。
```

## 六、Prompt 4｜建立 Mock 数据文件

```text
请在 src/data 下建立 user.json、navigation.json、quickActions.json、campaigns.json、brands.json、brandKnowledge.json、assets.json、assetStats.json、workspace.json、mockIndex.ts。数据围绕 LUMINA 高端护肤品牌场景，字段使用 camelCase，不连接真实 API。
```

## 七、Prompt 5｜开发通用组件

```text
请开发 AIInput、StatusBadge、TagChip、ProgressBar、Card、Modal、SectionHeader、EmptyState 等通用组件。视觉要求白色卡片、大圆角、轻阴影、浅紫 hover、蓝紫主色。
```

## 八、Prompt 6｜开发首页 Home

```text
请开发 BrandAI 首页 Home.tsx。数据使用 user、quickActions、campaigns、brands。页面包含问候语、中央 AI 输入框、四个快捷操作、近期 Campaign 横向卡片、推荐品牌瀑布流。不展示品牌一致性检查，不展示当前品牌 / 当前项目卡片。
```

## 九、Prompt 7｜开发 Campaign 项目页

```text
请开发 Campaign 项目页 Campaigns.tsx。页面包含标题、搜索栏、筛选区、项目卡片列表、右侧 AI 项目摘要面板。点击项目卡片后，右侧 AI 摘要切换为对应项目；继续创作跳转工作台。
```

## 十、Prompt 8｜开发品牌知识库页面

```text
请开发品牌知识库页面 BrandKnowledge.tsx。页面顶部为“AI 助手 · 共创你的品牌知识库”，AI 输入区居中偏上，包含快捷提示词、上传入口、品牌核心知识区、AI 生成知识摘要。不要出现“品牌资产”旧命名。
```

## 十一、Prompt 9｜开发素材库页面

```text
请开发素材库页面 Assets.tsx。页面包含标题、搜索栏、类型筛选、统计卡片、素材网格、右侧素材详情面板。点击素材卡片选中并更新右侧详情。
```

## 十二、Prompt 10｜开发工作台页面

```text
请开发工作台页面 Workspace.tsx。布局为左侧大面积图片展示区 + 右侧提示词编辑区。包含项目路径、大图画布、生成变体、AI 提示词编辑、风格关键词、品牌约束、参考素材、提交制作、额度和免责声明。页面名称统一为“工作台”，不要出现“图片设计编辑页”。
```

## 十三、Prompt 11｜补充弹窗与基础交互

```text
请为 BrandAI 前端 Demo 补充新建 Campaign、补充需求、上传资料 / 素材、查看项目规范、提交制作确认、归档确认等弹窗。使用统一 Modal 组件，弹窗大圆角、白色背景、轻阴影。
```

## 十四、Prompt 12｜补充页面动效与体验优化

```text
请补充轻量页面动效：卡片 hover 轻微上浮、按钮 hover 颜色加深、导航 hover 浅紫背景、弹窗淡入、AI 提交 loading、工作台提交制作显示“AI 正在生成...”。
```

## 十五、Prompt 13｜补充 README 与运行说明

```text
请补充 README.md，包含项目简介、技术栈、页面说明、运行方式、构建方式、目录结构、Mock 数据说明、当前实现范围、暂未实现功能和后续开发建议。
```

## 十六、Prompt 14｜GitHub 部署准备

```text
请补充 .gitignore、DEPLOY.md、Vercel 部署说明、GitHub Pages 部署说明。确保 npm run build 可以成功。
```

## 十七、Prompt 15｜代码质量检查与优化

```text
请检查 TypeScript 错误、组件命名、Mock 数据引用、路由、build、是否误出现“创意灵感”“品牌资产”“图片设计编辑页”，并修复明显问题。
```
