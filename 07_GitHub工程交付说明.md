# BrandAI AI 图片生成平台｜GitHub 工程交付说明 v0.1

## 一、工程交付目标

建立一个可运行、可构建、可演示、可交接的 BrandAI 前端 Demo 仓库。

| 目标 | 说明 |
|---|---|
| 可运行 | 本地执行 npm install、npm run dev 后可访问页面 |
| 可构建 | 执行 npm run build 可正常生成生产构建文件 |
| 可预览 | 可通过 npm run preview 或部署平台预览 |
| 可维护 | 目录结构清晰，组件拆分合理 |
| 可扩展 | 后续可接 API、AI 服务、数据库、登录权限 |
| 可交接 | README、PRD、UI 规范、Mock 数据说明齐全 |
| 可部署 | 支持 GitHub + Vercel / GitHub Pages 部署 |

## 二、推荐仓库命名

推荐：brandai-platform。

仓库说明建议：BrandAI is an AI-driven brand campaign visual design platform demo built with React, TypeScript, Vite and Tailwind CSS.

## 三、推荐技术栈

React、TypeScript、Vite、Tailwind CSS、React Router、lucide-react、本地 JSON Mock 数据、GitHub、Vercel / GitHub Pages。

## 四、推荐目录结构

```text
brandai-platform
├─ README.md
├─ DEPLOY.md
├─ CHANGELOG.md
├─ package.json
├─ index.html
├─ vite.config.ts
├─ tsconfig.json
├─ tailwind.config.js
├─ postcss.config.js
├─ .gitignore
├─ .env.example
├─ public/images
├─ docs
├─ prototype-images
└─ src
   ├─ main.tsx
   ├─ App.tsx
   ├─ routes
   ├─ layouts
   ├─ pages
   ├─ components
   ├─ data
   ├─ types
   ├─ styles
   └─ utils
```

## 五、Git 分支管理建议

| 分支 | 用途 |
|---|---|
| main | 稳定可演示版本 |
| develop | 日常开发集成分支 |
| feature/home-page | 首页开发 |
| feature/campaigns-page | Campaign 项目页开发 |
| feature/brand-knowledge-page | 品牌知识库开发 |
| feature/assets-page | 素材库开发 |
| feature/workspace-page | 工作台开发 |
| feature/mock-data | Mock 数据开发 |
| feature/ui-components | 通用组件开发 |

## 六、Commit 提交规范

推荐格式：`<type>: <description>`。

| 类型 | 说明 |
|---|---|
| feat | 新功能 |
| fix | 修复问题 |
| docs | 文档更新 |
| style | 样式调整 |
| refactor | 代码重构 |
| chore | 工程配置 |
| data | Mock 数据调整 |
| ui | UI 视觉调整 |
| deploy | 部署配置 |

## 七、README 建议内容

README 应包含项目简介、技术栈、核心页面、本地运行、构建、预览、当前实现范围、暂未实现内容和文档目录。

## 八、DEPLOY 建议内容

DEPLOY.md 应包含本地构建、Vercel 部署、GitHub Pages 部署、注意事项。Demo 阶段优先推荐 Vercel。

## 九、.gitignore 建议

```gitignore
node_modules
dist
build
.env
.env.local
.DS_Store
Thumbs.db
.vscode
.idea
.cache
.temp
```

## 十、技术团队接管清单

| 文件 / 目录 | 是否必须 | 说明 |
|---|---|---|
| README.md | 是 | 项目说明 |
| DEPLOY.md | 是 | 部署说明 |
| docs/ | 是 | 产品文档 |
| src/ | 是 | 源代码 |
| src/data/ | 是 | Mock 数据 |
| src/types/ | 是 | 类型定义 |
| public/images/ | 是 | 图片资源 |
| prototype-images/ | 是 | 原型效果图 |
| .gitignore | 是 | Git 忽略配置 |
| .env.example | 建议 | 环境变量示例 |

## 十一、接管前检查

1. npm run dev 正常；
2. npm run build 正常；
3. 五个核心页面可访问；
4. 左侧导航切换正常；
5. 无“创意灵感”“品牌资产”“图片设计编辑页”；
6. Mock 数据可正常渲染；
7. 样式与视觉规范一致；
8. docs 目录完整。

## 十二、后续真实系统接入路径

1. 替换 Mock 数据为真实 API；
2. 接入登录与账号体系；
3. 接入素材上传与对象存储；
4. 接入品牌知识库真实编辑与保存；
5. 接入 Campaign 项目真实创建与管理；
6. 接入 AI 文本解析；
7. 接入 AI 图片生成模型；
8. 接入生成记录、版本管理与归档；
9. 接入多租户与权限体系；
10. 上线试点客户。
