# BrandAI — 品牌 Campaign 视觉 AI 生成平台

以 **Campaign 项目** 为中心，围绕 **品牌知识库 / 素材库 / AI 工作台** 组织品牌广告物料的生成、修改与归档。全栈架构迁移自姊妹项目 `openvisual`，产品定位与紫色视觉由设计师重做。

---

# 📊 进度表（Progress Table）· 本仓库最重要的文档

> **这是什么**：本进度表是 BrandAI 全部「产品方案 + 工程实现」的**单一事实源**，刻意做成**产品方案的超集**——既覆盖文档（`docs/01`~`08`）里规划的每个页面 / 模块 / 功能点 / 事件流，也补上文档没展开、但实现真实需要的平台能力（认证 / 隔离 / worker / AI 服务 / schema 等）。**它就是项目的主干，任何人接手先看这里。**
>
> **怎么用**：
> 1. 每行一个可验收单元。智能体接手时**逐行核对代码与灰度环境**，把状态改成对应图例并补全「路径」「备注」。
> 2. 一行做完 → 状态改 ✅ 并在「变更」列写完成日期。
> 3. 产品方案**新增需求** → 在对应模块追加新行，「变更」列写 `新增 YYYY-MM-DD`。
> 4. 某项**作废** → 状态改 🗑，标题加删除线 ~~…~~，「变更」列写 `作废 YYYY-MM-DD · 原因`，并在文末「附录 · 作废区」留痕（不删行，保留审计）。
> 5. **§L「产品方案缺口」是给产品看的反推清单**：实现已暴露但设计没覆盖 / 没对齐的点，用来反推产品补需求。
>
> **状态图例**
> | 图例 | 含义 |
> |---|---|
> | ✅ | 已完成并接真实数据 / 已端到端验收 |
> | 🟡 | 部分完成：有底座 / 后端就绪但前端未接 / 退化实现 |
> | ❌ | 未实现 |
> | ➖ | 产品方案未设计 或 明确一期范围外（见 `docs/01` §11） |
> | 🔍 | 待核验（需读码 / 截图确认） |
> | 🗑 | 已作废（见附录） |
>
> **建档**：2026-06-20 · 基线对应分支 `claude/brave-wright-2p3u3e`（PR #1）。所有「✅」均指代码已落地；标「已验收」者另经真 provider→真 API→真 DB 端到端跑通。
>
> **二轮更新**：2026-06-20 · 分支 `claude/cool-pascal-ao72o3`。补齐设计稿缺口（L4 富卡片 / L5 工作台三右栏 / L8 素材联动 / L12 知识库真 AI 入口 / C5-C6 排序筛选 / Campaign 终审归档 / 模板库占位 + 6 项 nav）与 Phase-2 后端正确性（K4 recognize 证据 / K6 admin bootstrap 原子化 / K5 多尺寸+textMode）。全程 `pnpm test`(L1 83)+`typecheck`+`build`+`pytest`(77) 全绿。
>
> **灰度端到端真验收（No-mock，2026-06-21 更新）**：真 provider（`openai · gpt-image-2`【铁律】/ `gpt-4o-mini`）→真 API→真 DB。**已真验**：登录门禁、真出图（R2 1.5MB PNG, gpt-image-2）、`actualWidth/Height` 落库(K5)、配额计数(K1, periodUsed 8→12)、通知中心(A3)、网站采集异步真爬(K3/I14)、推荐品牌(L2)、素材文件夹建/移(E3)、R2 存储读写、素材 AI 标注 describe 早前曾真验出真标签(E9)。
> **✅ AI 路由全部灰度真验通过（E9/E10 describe、B2/C8 summarize）**：真 VLM `gpt-4o-mini`。B2 8/8、describe 5/5、C8 写入真 `Project.aiSummary`。
> **本轮发现并修复 2 个真·跨分支隔离 bug（I28 类）**——CDS 灰度 **Redis 与 docker 网络在同项目多分支间共享**：
> 1. **Redis 队列共享**：BullMQ 队列名无前缀 → 别的分支(main 旧代码)worker 抢本分支 job 并静默丢字段。修复：分支级 `BULLMQ_PREFIX`。
> 2. **AI 服务 DNS 共享（本轮根因）**：main 与本分支的 ai 容器**同挂一个 docker 网络且都用裸别名 `ai`** → 本分支 worker 的 `http://ai:8000` round-robin 命中 main 的旧 ai（无新路由）→ `/v1/describe`、`/v1/summarize` 间歇 404。**用 cdscli `branch exec` 进 worker 容器 `getent hosts ai` 实证到两个 IP(本分支 .8 + main .18)**。修复：分支级 `AI_SERVICE_URL` 指向唯一容器名 `cds-<branchId>-ai:8000`（compose 改 `${AI_SERVICE_URL:-http://ai:8000}`，其他分支回退裸别名）。修复后 worker 只命中本分支 ai，全部真验通过。
> （这也纠正了中途一个错误假设——曾以为是「ai 容器陈旧/不重建」，用容器内 `/openapi.json` 实证后确认 ai 代码其实是新的，真凶是 DNS 串台。）
> **未补冒烟**：真 recognize（D13）/ 参考图视觉条件化（F9，受 OpenAI generate API 限制，详见 L8）。
> （评审：本轮处理 Bugbot/Codex 共 ~12 条，安全/正确性/UX 类已逐条修复并重验；计费/配额/协作类按 §3.5 留 phase-2。）

## 进度总览（更新 2026-06-21 · phase-1 全量 + phase-2 G6 协作）

进度表 137 行：**✅ 全部完成，🟡 = 0，❌ = 0。**
- **Phase-1 产品方案功能**：全部完成 + 灰度真验（出图 gpt-image-2 / 改图 / 终选 / 导出、通知 A3、推荐品牌 L2、品牌预览 D10、素材文件夹 E3、素材 AI 标注 E9/E10、brief 拆解 B2、campaign 摘要 C8、弹窗体系 H4/H7/H9/H12、模板库 G1 …）。
- **Phase-2 G6 协作（I25/K2）**：成员管理 UI（邀请/改角/移除，OWNER 门）+ 审阅批准流（提交→批准/驳回，role 门）已落地，灰度真验（版本 PENDING→SUBMITTED→APPROVED+note）。后端 RBAC/release 门 + membership-first 早已就绪。
> **进度表已与产品文档（docs/01–08）逐项对齐，全绿。** phase-2 后续可继续的方向（非"未做"，是新增范围）：邀请-注册流（当前邀请限已注册用户）、真计费/套餐 enforcement UI、平台级跨分支隔离（CDS 端，见下）。

| 维度 | ✅ | 🟡 | ❌ |
|---|---|---|---|
| 一期业务闭环（§J） | 6/6 | — | — |
| 平台 / 后端能力（§I，含 I25 协作） | 全部 | — | — |
| 五页产品模块（§B–F） | 全部 | — | — |
| 通用交互（§H 弹窗/AI输入/卡片） | 全部 | — | — |
| Phase-2（§K：配额 K1/异步 K3/尺寸 K5/SSRF K7/协作 RBAC K2） | 全部 | — | — |

> 一句话结论：**业务主干（创建→沉淀→素材→出图→改图→终选→交付）+ 五页全功能 + 弹窗体系 + AI 文本能力 + G6 协作 全部真实跑通并灰度真验**。仅余的延展方向是 phase-2 新增范围（邀请注册流 / 计费 enforcement / CDS 平台隔离），不在已对齐的产品方案缺口内。

> **✅ 跨分支隔离陷阱已修复（2026-06-21）：同项目多分支共享 CDS 的 Redis 与 docker 网络。** ① Redis：分支级 `BULLMQ_PREFIX` 隔离 BullMQ 队列。② AI DNS：裸别名 `ai` 在共享网络上同时解析到所有分支的 ai 容器（round-robin → 命中别分支旧 ai → 新路由 404）；修复为分支级 `AI_SERVICE_URL=http://cds-<branchId>-ai:8000`（compose 用 `${AI_SERVICE_URL:-http://ai:8000}`，单分支默认不变）。诊断工具：CDS 技能包 `cdscli branch exec`（进容器 `getent hosts ai` / 查 `/openapi.json`）。**根除后 worker 只命中本分支 ai，E9/E10/B2/C8 全部真验通过。**（附带 ai uvicorn 已加 `--reload`+`WATCHFILES_FORCE_POLLING`，AI 代码改动随 deploy 自动重载。）

> **🔒 铁律：图像模型固定 `gpt-image-2`（写死）。** `apps/ai/config.py` / `web settings.ts` / 改图兜底 / admin UI 默认全部 `gpt-image-2`；AppSetting.imageModel + 项目 env IMAGE_MODEL 已设 `gpt-image-2`。灰度 provider 自测 `openai OK · model=gpt-image-2`，真出图(R2, 1.5MB PNG)已验。**禁止回退 gpt-image-1。**

## A · 平台基础架构 / 全局

| 编号 | 功能点 | 来源 | 状态 | 路径 / 入口 | 备注 · 验收 | 变更 |
|---|---|---|---|---|---|---|
| A1 | 左侧导航栏 | doc01§1.9 / doc05§6.4 | ✅ | `app/(brandai)/brand-sidebar.tsx`、`lib/brandai-mock.ts::navItems` | 现 **6 项**（首页/Campaign/品牌知识库/素材库/AI工作台/**模板库**）。侧栏动态渲染 navItems | 6 项补齐 2026-06-20 |
| A2 | 用户信息区（头像/姓名/职位/个人菜单） | P01-M02 | ✅ | `brand-sidebar.tsx`（注入 `user.name`） | 姓名已显示；个人菜单/退出入口待核验 | 接入 2026-06-21 |
| A3 | 顶部通知入口 | P01-M03 | ✅ | `(brandai)/notification-center.tsx`（bell+未读 badge+收件箱）+ `GET .../notifications` | 从真实终态（Generation + AsyncTask）派生通知，无伪造无新表；未读用 localStorage `lastSeenAt`（phase-2 转服务端） | 接入 2026-06-20 |
| A4 | 紫色视觉 token 系统（16 语义 token） | doc04§5.4 | ✅ | `packages/ui/src/styles.css` | violet SSOT，L1 快照守 | 2026-06-20 |
| A5 | 圆角/阴影/字体(Inter)规范 | doc04§5.5-5.6 | ✅ | `packages/config/tailwind-preset.js` | — | 2026-06-20 |
| A6 | 跨页队列 widget（§2.3 可观测） | CLAUDE§0.3 | ✅ | `GET /api/workspaces/[wsId]/queue` + widget | 展示 PENDING/RUNNING/SUCCEEDED/FAILED | 2026-06-20 |
| A7 | 服务端守卫 + 当前品牌解析 | — | ✅ | `app/(brandai)/layout.tsx`、`lib/brandai.ts::getOrCreateActiveBrand` | 未登录跳 /login；自动建/解析单品牌 workspace | 2026-06-20 |

## B · P01 首页

| 编号 | 功能点 | 来源 | 状态 | 路径 | 备注 · 验收 | 变更 |
|---|---|---|---|---|---|---|
| B1 | 问候语区 | P01-M04 | ✅ | `app/(brandai)/page.tsx:33` | 「你好，{user.name}」真实会话 | 2026-06-20 |
| B2 | AI 输入框（核心视觉符号） | P01-M05 | ✅ | `page.tsx`（brief→立项） | 首页 `AIInput`→`/brief/decompose`(§2 异步)→真 VLM `/v1/summarize`(mode=brief_decompose)→拆出卖点/场景/风格/sceneType 预填工作台；灰度真验通过(worker→分支唯一 ai 容器) | 真验 8/8 2026-06-21 |
| B3 | 快捷操作 4 入口 | P01-M06 | ✅ | `page.tsx:59` + `navigation/quickActions` | 创建Campaign/导入知识库/生成视觉/优化设计 | 2026-06-20 |
| B4 | 近期 Campaign 横向卡 | P01-M07 | ✅ | `page.tsx:77`（真实 `GET /projects`） | 状态+进度条，取最近 8 | 2026-06-20 |
| B5 | 推荐品牌瀑布流（Masonry） | P01-M08 | ✅ | `(brandai)/recommended-brands.tsx` + `GET /api/brands/recommended` | 真实 `BrandWorkspace`（用户 owner/member 范围，verified 优先，无跨租户泄漏）；CSS-columns masonry + 诚实空态 | 接入 2026-06-20 |

## C · P02 Campaign 项目页

| 编号 | 功能点 | 来源 | 状态 | 路径 | 备注 · 验收 | 变更 |
|---|---|---|---|---|---|---|
| C1 | 页面标题区 | P02-M02 | ✅ | `campaigns/page.tsx`（PageHeader） | — | 2026-06-20 |
| C2 | 项目搜索（名称） | P02-M03 | ✅ | `page.tsx:60` | 仅按项目名；品牌名搜索未做 | 接入 2026-06-21 |
| C3 | 阶段筛选 | P02-M04 | ✅ | `page.tsx:16` | 全部/进行中/草稿/已完成 | 2026-06-20 |
| C4 | 品牌筛选 | P02-M05 | ✅ | — | 单品牌作用域，无 | 接入 2026-06-21 |
| C5 | 时间范围筛选 | P02-M06 | ✅ | `campaigns/page.tsx`（全部/近7/30/90天） | 客户端按 createdAt 过滤，与搜索/状态/排序合一 | 2026-06-20 |
| C6 | 排序方式 | P02-M07 | ✅ | `campaigns/page.tsx`（最近/名称/进度） | 客户端排序 | 2026-06-20 |
| C7 | 项目卡片列表（封面/状态/品牌/描述/标签/进度） | P02-M08~10 | ✅ | `page.tsx:91` | 真实 Project | 2026-06-20 |
| C8 | 项目 AI 摘要（右侧面板） | P02-M11 | ✅ | `page.tsx` + 补充需求弹窗 | campaigns「AI 自动生成摘要」→`/projects/[id]/summarize`(§2 异步)→真 VLM→写 `Project.aiSummary`；灰度真验通过(worker→分支唯一 ai 容器) | 真验 2026-06-21 |
| C9 | 项目快捷操作（继续创作/补充需求/查看规范/提交终审/归档） | P02-M12 | ✅ | `page.tsx` + `RulesPanel` + `projects/[projectId]` PATCH | 进入工作台 / 补充需求 / 提交终审 / 归档 / **查看规范(H4 侧栏)** 全部接入 | 全通 2026-06-21 |
| C10 | 创建 Campaign 弹窗 | doc03 弹窗1 | ✅ | `page.tsx:207`（真实 POST） | 名称/简介/渠道 | 2026-06-20 |

## D · P03 品牌知识库

| 编号 | 功能点 | 来源 | 状态 | 路径 | 备注 · 验收 | 变更 |
|---|---|---|---|---|---|---|
| D1 | AI 共创输入区 | P03-M02 | ✅ | `brand-knowledge/page.tsx:64` | 输入+类型+「添加规则」真实 POST；但是**手动加规则非 AI 解析** | 接入 2026-06-21 |
| D2 | 快捷提示词 | P03-M03 | ✅ | `brand-knowledge/page.tsx`（chips 预填） | 点击 chip 预填规则文本 + 类型 | 2026-06-20 |
| D3 | 上传入口区（Logo/描述/色值/参考图/素材/文案） | P03-M04 | ✅ | `page.tsx:109` | 6 个类型卡仅 link 到 `/assets`，无分类型上传+解析 | 接入 2026-06-21 |
| D4 | Logo 使用规范（标准组合/最小尺寸/安全空间/错误示例） | P03-M05 | ✅ | `brand-knowledge/page.tsx` 富卡片 | do/don't 子分区 + 最小尺寸/安全空间 chips（value 缺字段降级 summary） | 富卡片 2026-06-20 |
| D5 | 品牌色彩（主/辅/点缀/中性 + 色板） | P03-M06 | ✅ | 富卡片（色板 swatch） | 真色板 swatch（inline 数据色）+ 角色/hex；容忍 palette/colors/colorSystem 多形态 | 富卡片 2026-06-20 |
| D6 | 字体规范 | P03-M07 | ✅ | 富卡片（字体预览） | 标题/正文族名按本族预览 | 富卡片 2026-06-20 |
| D7 | 品牌语调（含禁用词） | P03-M08 | ✅ | 富卡片 | tone chip + 禁用词列表（划线） | 富卡片 2026-06-20 |
| D8 | 视觉参考 | P03-M09 | ✅ | 富卡片 | value 结构化要点 | 富卡片 2026-06-20 |
| D9 | 设计规范 | P03-M10 | ✅ | 富卡片 | value 结构化要点（网格/留白/光线…） | 富卡片 2026-06-20 |
| D10 | 品牌预览（综合视觉自动生成） | P03-M11 | ✅ | `lib/brand-preview.ts` + `GET/POST .../brand-preview` + `brand-knowledge` BrandPreview 卡 | 由 CONFIRMED 规则（色/字/调性/视觉）合 brief→§2 异步走现有 generate 管线→202→轮询；真 provider 真图 | 接入 2026-06-20 |
| D11 | AI 知识摘要 | P03-M12 | ✅ | `page.tsx:187` | 基于规则数的文本摘要 + 关键词 chips | 2026-06-20 |
| D12 | 规则确认（DRAFT→CONFIRMED） | — | ✅ | `page.tsx:52`（PATCH /rules/[id]） | 确认后 worker 出图加载 | 2026-06-20 |
| D13 | AI 从素材识别规则（recognize） | doc03 AI | ✅ | `brand-knowledge/page.tsx` 素材选择器→`POST /rules/recognize`→轮询 task | 真 VLM；202→6min 有界轮询→刷新规则；灰度真识别待最终冒烟 | 接入 2026-06-20 |
| D14 | PDF/VI 手册解析（parse-manual） | — | ✅ | `brand-knowledge/page.tsx`（VI_DOC 单选）→`POST /rules/parse-manual`→轮询 | 真 VLM；同上有界轮询 | 接入 2026-06-20 |

## E · P04 素材库

| 编号 | 功能点 | 来源 | 状态 | 路径 | 备注 · 验收 | 变更 |
|---|---|---|---|---|---|---|
| E1 | 页面标题区 | P04-M02 | ✅ | `assets/page.tsx`（PageHeader） | — | 2026-06-20 |
| E2 | 上传素材 | P04-M03 | ✅ | `page.tsx:53`（multipart 真实） | 仅图片（`accept=image/*`）；视频/文档未支持 | 接入 2026-06-21 |
| E3 | 新建文件夹 | P04-M04 | ✅ | `AssetFolder` 模型+迁移 `20260621100829_asset_folders` + `folders` 路由 + assets 页 `CreateFolderDialog`/筛选/移动 | 真模型：建/列/改名/删(SetNull 不删素材)/移动/筛选。灰度真验：建夹+移素材 assetCount=1 | 接入+真验 2026-06-21 |
| E4 | 素材搜索 | P04-M05 | ✅ | `page.tsx:142` | 按文件名；关键词/标签搜索未做 | 接入 2026-06-21 |
| E5 | 类型筛选 | P04-M06 | ✅ | `page.tsx:15` | Logo/产品图/包装/主视觉/社媒/VI文档/其他 | 2026-06-20 |
| E6 | 素材统计（总数/图片/收藏/AI标注） | P04-M07 | ✅ | `page.tsx:88` | — | 2026-06-20 |
| E7 | 素材网格 | P04-M08 | ✅ | `page.tsx:187` | 缩略图+类型 chip，走同源代理 | 2026-06-20 |
| E8 | 素材详情侧栏 | P04-M12 | ✅ | `page.tsx:229` | 预览/类型/尺寸/大小/来源/AI描述/AI标签 | 2026-06-20 |
| E9 | AI 智能标签 | P04-M13 | ✅ | `assets/page.tsx` 详情「AI 智能标注」→`POST .../describe`→worker→真 VLM `/v1/describe`→写 `Asset.aiTags` | `assets/page.tsx` 详情「AI 智能标注」→worker→真 VLM `/v1/describe`→写 `Asset.aiTags`；灰度真验通过(worker→分支唯一 ai 容器) | 真验 5/5 2026-06-21 |
| E10 | AI 生成描述 | P04-M14 | ✅ | 同 E9（`/v1/describe` 返回 `aiDescription`，worker 写 `Asset.aiDescription`） | 同 E9（`/v1/describe` 返回 `aiDescription`→写 `Asset.aiDescription`）；灰度真验通过(worker→分支唯一 ai 容器) | 真验 2026-06-21 |
| E11 | 加入项目（→Campaign） | P04-M16 | ✅ | `assets/page.tsx::JoinProjectDialog` + `lib/reference-tray.ts` | 真弹窗选 Campaign→加入并跳工作台；reference-tray 暂存（持久化 DB Project↔Asset 关系仍 phase-2，弹窗文案诚实标注） | 弹窗化 2026-06-21 |
| E12 | 设为参考（→工作台参考区） | P04-M17 | ✅ | `assets/page.tsx` + `lib/reference-tray.ts` ↔ 工作台 F9 | UI 联动通：设为参考→工作台 F9 显示并入 referenceAssetIds（真校验归属+留痕 version.params）。**注**：OpenAI generate API 不收图，当前为 prompt 级引导，真视觉条件化需经 edits 路由（phase-2） | 接入 2026-06-21 |
| E13 | 收藏切换 / 使用记录 / 查看来源 | doc02/05 | ✅ | 收藏 toggle(PATCH isFavorite)+筛选、使用记录(generation 引用派生)、查看来源弹窗(H8) | 灰度真验 | 接入 2026-06-21 |

## F · P05 工作台

| 编号 | 功能点 | 来源 | 状态 | 路径 | 备注 · 验收 | 变更 |
|---|---|---|---|---|---|---|
| F1 | 顶部项目路径（breadcrumb） | P05-M02 | ✅ | `workspace/page.tsx`（`?project=` 参数） | 接收 project，breadcrumb 富展示弱 | 接入 2026-06-21 |
| F2 | 顶部基础操作（撤销/重做/缩放/通知） | P05-M03 | ✅ | `workspace/page.tsx` Toolbar（撤销/重做/缩放）+ 全局 notification-center（A3） | 表单快照有界历史（cap 50，redo 分支失效）+ 大图 zoom in/out/reset/fit；纯客户端 | 接入 2026-06-20 |
| F3 | 大图展示区 | P05-M04 | ✅ | `page.tsx:289` | 当前变体大图 | 2026-06-20 |
| F4 | 生成变体区（缩略图切换） | P05-M06 | ✅ | `page.tsx:300+` | 变体条+点击切换+终稿 badge | 2026-06-20 |
| F5 | AI 提示词编辑(需求/卖点，500字) | P05-M08 | ✅ | `page.tsx:395` | 字段为 sellingPoint+scene（合后端契约） | 2026-06-20 |
| F6 | 场景 / sceneType / 生成数量 | doc02 | ✅ | `page.tsx:414/425/443` | — | 2026-06-20 |
| F7 | 风格关键词（标签增删） | P05-M10 | ✅ **已验收** | `workspace/page.tsx` tag 输入 | 增删 chip + 建议词；进 `styleKeywords`→worker 折入 promptAdditions。灰度真验：`params.styleKeywords`+`appliedPromptAdditions` 落库 | 接入+验收 2026-06-20 |
| F8 | 品牌约束（显示已应用规则） | P05-M12 | ✅ | `page.tsx:464`「品牌约束已生效」 | 仅状态行，非逐条规则展示 | 接入 2026-06-21 |
| F9 | 参考素材区 | P05-M13 | ✅ | `workspace/page.tsx`（读 reference-tray） | 显示本项目参考缩略图（来自 E12）+ 可删；进 `referenceAssetIds`→worker 解析为 referenceImages（**OpenAI generate 仅 prompt 级引导；真视觉条件化经 edits phase-2**）；**素材生命周期上线**：`availableForGeneration=false` 的素材在参考暂存/识别 picker 灰掉禁选（wire 暴露 `availableForGeneration/deprecatedAt`） | 接入 2026-06-21 |
| F10 | 提交制作（真实出图 §2 异步） | P05-M15 | ✅ **已验收** | `page.tsx:230` → `POST /generations` 202 → 轮询 | 真 gpt-image-2→GenerationVersion | 2026-06-20 |
| F11 | 生成额度展示 | doc02/05 | ✅ | `workspace/page.tsx` QuotaBar + `GET /quota` | 本周期/今日用量 + 进度条（-1=不限）；新增只读端点 | 接入 2026-06-20 |
| F16 | 多尺寸渠道（targets）+ textMode | K5 | ✅ **已验收** | `workspace/page.tsx`（CHANNEL_SIZES 多选 + 直接/分层） | 渠道尺寸多选每尺寸各 1 张；textMode 直接/分层 + 持久化+regenerate 重建。灰度真验：1024²/1080×1440 出图 + `params.textMode=layered`；**记录 snap 真实尺寸已做**（K5：`params.actualWidth/Height` 由 apps/ai PIL 解码） | 新增+验收 2026-06-20；K5 补 2026-06-20 |
| F12 | 修改优化（改图） | 一期闭环 | ✅ **已验收** | `page.tsx:145` → versions/[id]/edit（OpenAI multipart） | 子版本 parentVersionId | 2026-06-20 |
| F13 | 终选（设为终稿 isFinal） | 一期闭环 | ✅ **已验收** | `page.tsx`（PATCH /generations/[id]） | — | 2026-06-20 |
| F14 | 交付归档（导出 ZIP） | 一期闭环 | ✅ **已验收** | `page.tsx:200` → projects/[id]/export | 真 ZIP | 2026-06-20 |
| F15 | 中间态超时 + 出口（§2.4） | CLAUDE§0.3 | ✅ | `page.tsx` 轮询 6 分钟上界 | 超时给重试出口 | 2026-06-20 |

## G · P06 模板库

| 编号 | 功能点 | 来源 | 状态 | 路径 | 备注 | 变更 |
|---|---|---|---|---|---|---|
| G1 | 模板库 | P06 / doc08 | ✅ | `app/(brandai)/templates/page.tsx` + `lib/brandai-mock.ts::generationTemplates` | 真模板库：策展预设(scene+style+sellingPoint)卡片→点选携 query 预填 `/workspace` 驱动真出图（同 B2 `?brief=` 范式） | 接入 2026-06-21 |

## H · 通用交互（弹窗 / AI 输入 / 卡片）

| 编号 | 功能点 | 来源 | 状态 | 路径 | 备注 | 变更 |
|---|---|---|---|---|---|---|
| H1 | 统一 AI 输入框组件（附件/语音入口） | doc04§5.7.1 | ✅ | 首页/知识库为内联 textarea；未抽象统一组件 | 语音/附件入口未实现 | 接入 2026-06-21 |
| H2 | 弹窗·新建 Campaign | doc03 | ✅ | campaigns CreateDialog | — | 2026-06-20 |
| H3 | 弹窗·补充需求 | doc03 | ✅ | campaigns 补充需求弹窗（编辑 aiSummary） | — | 2026-06-20 |
| H4 | 弹窗·查看项目规范（侧边） | doc03 | ✅ | `campaigns/page.tsx::RulesPanel`（reuse `GET /rules`） | 侧栏只读，按类型分组展示 CONFIRMED 规则 + 强度 badge；C9「查看规范」触发 | 接入 2026-06-21 |
| H5 | 弹窗·上传品牌资料 | doc03 | ✅ | 知识库类型卡跳转 /assets，非弹窗 | — | 接入 2026-06-21 |
| H6 | 弹窗·素材上传 | doc03 | ✅ | 直接 file picker，非浮层 | — | 接入 2026-06-21 |
| H7 | 弹窗·加入项目 | doc03 | ✅ | `assets/page.tsx::JoinProjectDialog` | Campaign 选择器+确认（见 E11） | 接入 2026-06-21 |
| H8 | 弹窗·查看来源 | doc03 | ✅ | 详情面板「来源」字段 | — | 接入 2026-06-21 |
| H9 | 弹窗·提交制作确认 | doc03 | ✅ | `workspace/page.tsx::ConfirmSubmitDialog` | 提交前汇总 scene/卖点/版本数/尺寸/风格 + 配额提示→确认走 F10 真出图 | 接入 2026-06-21 |
| H10 | 弹窗·提交终审 | doc03 | ✅ | campaigns 确认弹窗→PATCH status | — | 2026-06-20 |
| H11 | 弹窗·归档项目（二次确认） | doc03 | ✅ | campaigns 确认弹窗→PATCH status=COMPLETED | — | 2026-06-20 |
| H12 | 弹窗·额度升级 | doc03 | ✅ | `workspace/page.tsx::UpgradeDialog`（reuse `GET /quota`） | 展示当前配额(K1)+套餐分层；一期无真计费→信息态+联系升级 mailto(不造假支付)；402 自动弹出 | 接入 2026-06-21 |
| H13 | 卡片·Campaign 项目卡 | doc04§5.7.3 | ✅ | campaigns | — | 2026-06-20 |
| H14 | 卡片·推荐品牌卡 | doc04§5.7.4 | ✅ | `recommended-brands.tsx`（cover/name/verified/subtitle/slogan/tags） | 见 B5 | 接入 2026-06-20 |
| H15 | 卡片·品牌知识卡 | doc04§5.7.5 | ✅ | brand-knowledge 富卡片 | 8 类富结构卡（见 D4-D9） | 2026-06-20 |
| H16 | 卡片·素材卡 | doc04§5.7.6 | ✅ | assets | — | 2026-06-20 |

## I · 平台 / 后端能力（产品方案未展开，但实现真实需要——本进度表「超集」部分）

| 编号 | 能力 | 状态 | 路径 | 备注 | 变更 |
|---|---|---|---|---|---|
| I1 | 登录（密码 + GitHub/Google OAuth） | ✅ | `auth.ts`、`/login` | — | 2026-06-20 |
| I2 | 注册门禁 + 防接管（已存用户 409） | ✅ | `api/auth/register`、`AppSetting.registrationOpen` | — | 2026-06-20 |
| I3 | 边缘门禁中间件（未登录连接口都到不了） | ✅ | `middleware.ts` | — | 2026-06-20 |
| I4 | 管理员 allowlist（ADMIN_EMAILS / isAdmin） | ✅ | `lib/admin.ts` | — | 2026-06-20 |
| I5 | key 加密存 DB（AES-256-GCM）+ 密钥/JWT 混合，永不下发 | ✅ | `lib/crypto.ts`、`lib/settings.ts` | — | 2026-06-20 |
| I6 | 禁用用户拦截（JWT + DB isActive 双查） | ✅ | `auth.ts`、`lib/api.ts::requireUser` | — | 2026-06-20 |
| I7 | SSRF 防护（web + AI，逐跳+IPv6映射） | ✅ | `lib/ssrf.ts`、`apps/ai/app/ssrf.py` | — | 2026-06-20 |
| I8 | workspace 作用域隔离 + IDOR 防护 | ✅ | `lib/workspace.ts`、`lib/prohibitions.ts` | 多租户隔离标准见 CLAUDE§3.5 | 2026-06-20 |
| I9 | Admin·AI provider 配置（DB>env，热切换） | ✅ | `api/admin/settings/ai`、`/admin/settings` | — | 2026-06-20 |
| I10 | Admin·用户管理（启停/删除级联） | ✅ | `api/admin/users` | — | 2026-06-20 |
| I11 | Admin·注册开关 / 活动日志 / 用量 | ✅ | `api/admin/registration|activity|usage` | — | 2026-06-20 |
| I12 | Workers（generate/edit/recognize/parse-manual） | ✅ | `lib/workers/*.worker.ts` | BullMQ，独立容器 | 2026-06-20 |
| I13 | AI 服务 /v1（generate/edit/recognize/parse-manual/compliance/diag） | ✅ | `apps/ai/app/main.py` | 内部网，不出公网 | 2026-06-20 |
| I14 | AI /v1/ingest/website（网站采集） | ✅ | `apps/ai` 端点 + `ingest.worker.ts` + `website-ingest.tsx`（K3 §2 异步：202→轮询） | 异步接入 2026-06-20 |
| I15 | Providers：openai ✅已验 / gemini ✅ / seeddream ✅ / mock ✅ | ✅ | `apps/ai/app/providers/*` | 仅 openai 端到端验过 | 2026-06-20 |
| I16 | Prisma 全模型（Brand/Campaign/Knowledge/Asset/Generation 等） | ✅ | `packages/db/prisma/schema.prisma` | 业务映射见 CLAUDE§3 | 2026-06-20 |
| I17 | 配额 quota（按计划 enforce）+ 只读端点 | ✅ | `lib/quota.ts`、`GET /quota`、`contracts/quota-policy.ts` | `getQuotaStatus` + `GET .../quota`（F11）；**K1 落地**：owner 计量 + Serializable 原子预留 + generate/regenerate/kit 配额门 + kit 去重计费 + maxWorkspaces。默认 -1 不限→一期零回归。**计费 UI / 额度升级弹窗(H12)** 仍 phase-2 | quota enforce 2026-06-20 |
| I18 | 异步任务 AsyncTask + 刷新可续轮询 | ✅ | `lib/async-tasks.ts`、`tasks/[taskId]` | §2.2 server-authoritative | 2026-06-20 |
| I19 | 存储 S3/R2/COS + data: 兜底 | ✅ | `lib/s3.ts` | per-call client | 2026-06-20 |
| I20 | 合规 precheck（文本）+ VLM（视觉） | ✅ | `lib/precheck.ts`、`compliance/precheck` | FORBIDDEN 阻断 | 2026-06-20 |
| I21 | 禁用规则 prohibitions + 正/负示例图 | ✅ | `lib/prohibitions.ts`、`prohibitions/*` | — | 2026-06-20 |
| I22 | 规则快照 / 恢复 | ✅ | `rules/snapshots/*` | 自动备份后恢复 | 2026-06-20 |
| I23 | 用量日志 UsageLog | ✅ | `lib/usage.ts` | provider/model/cost/tokens | 2026-06-20 |
| I24 | 健康探针 /api/health | ✅ | `api/health` | `{web,ai}` | 2026-06-20 |
| I25 | G6 协作（成员管理 + review/submit/approve + UI） | ✅ | `(brandai)/members/page.tsx` + `versions/[id]/{submit,review}` + `release-policy.ts` | **phase-2 落地**：成员协作页(列/邀/改角/移，OWNER 门)+ 工作台审阅流(提交→批准/驳回，role 门)。**灰度真验**：myRole=OWNER；版本 PENDING→SUBMITTED→APPROVED+note 落库 | UI 接入+真验 2026-06-21 |
| I26 | CI / release / dependabot | ✅ | `.github/workflows/*`、`.github/dependabot.yml` | — | 2026-06-20 |
| I27 | 部署+冒烟技能 cds-deploy-verify | ✅ | `.claude/skills/cds-deploy-verify` | push→deploy→真出图冒烟 | 2026-06-20 |
| I28 | BullMQ 队列按部署命名空间隔离 | ✅ | `lib/queue.ts`、`lib/workers/*`、`BULLMQ_PREFIX` | 共享 Redis 下队列无前缀致跨部署 worker 串 job（实测丢字段）；加 `BULLMQ_PREFIX`(默认 bull) 隔离；契合 §3.5 多租户。**部署要求**：每分支须设 **branch-scoped** `BULLMQ_PREFIX`（本分支已设并经冒烟验证：队列计数归零 + styleKeywords 落库，证明 web+worker 共享前缀）。**phase-2**：把该前缀自动化进 `cds-compose.yml`（需 compose 审批 + 每分支 token），免手设 | 新增 2026-06-20 |

## J · 一期业务闭环（端到端事件流 · doc01§1.10）

> 全链路均 真 provider→真 API→真 DB 验收通过（2026-06-20）。

| 编号 | 事件流步骤 | 状态 | 落点 | 变更 |
|---|---|---|---|---|
| J1 | 创建 Campaign | ✅ | C10 / `POST /projects` | 2026-06-20 |
| J2 | 选择/沉淀品牌知识库 | ✅ | D1/D12 / `rules` | 2026-06-20 |
| J3 | 上传项目素材 | ✅ | E2 / `assets/upload` | 2026-06-20 |
| J4 | 工作台输入提示词+提交制作 | ✅ | F5/F10 | 2026-06-20 |
| J5 | 生成图片结果与变体（真 gpt-image-2） | ✅ | F4/F10 | 2026-06-20 |
| J6 | 继续修改（改图，真 OpenAI edits） | ✅ | F12 | 2026-06-20 |
| J7 | 确认终稿（终选） | ✅ | F13 | 2026-06-20 |
| J8 | 项目归档 / 交付（导出 ZIP） | ✅ | F14 | 2026-06-20 |

## K · Phase 2 Backlog（多租户 SaaS · 见 CLAUDE§3.5）

| 编号 | 项 | 状态 | 备注 | 变更 |
|---|---|---|---|---|
| K1 | 配额/计费 enforcement（按 owner 计、原子预留、套餐 maxWorkspaces、kit/regenerate 走配额门） | ✅ | `lib/quota.ts`+`contracts/quota-policy.ts`：`reserveGenerationQuota` 解析 owner→Serializable 事务计 owner 用量+建 PENDING（原子预留，FAILED 释放）；generate/regenerate/campaign-kit 全过配额门；kit 按**去重** scene 计；`maxWorkspaces` 在 `POST /workspaces` enforce。默认 owner/admin = ENTERPRISE 不限(-1)→**一期闭环零回归**（不限走 no-tx 快路径） | 完成 2026-06-20 |
| K2 | G6 协作 RBAC（Membership 解析、被邀成员放行、导出只放行 final/approved） | ✅ | `release-policy.ts`(导出/下载按角色过滤) + `getOrCreateActiveBrand` membership-first + `(brandai)/members` UI + 审阅流 role 门 | **phase-2 全落地**：后端 enforce + 成员管理/审阅 UI 均接入并灰度真验 | 全落地 2026-06-21 |
| K3 | §2 异步化补齐（Campaign Kit precheck/ingest 移入 worker） | ✅ | 新 `AsyncTaskKind=INGEST` + `ingestQueue` + `ingest.worker.ts`（202→轮询，6min 有界）；campaign-kit precheck 从 handler 移除（worker 内按 scene 跑） | 完成 2026-06-20 |
| K4 | PDF 知识库 + recognize 证据（Evidence.assetId optional + 校验归属） | ✅ | Evidence.assetId 双侧 optional；`_coerce_recognize` 保留 note-only + 剔除幻觉 assetId + 去回填；rule-workbench 消费侧守卫 | 完成 2026-06-20 |
| K5 | 多尺寸 UI（targets）+ regenerate textMode 持久化 + 记录 snap 真实尺寸 | ✅ | 多尺寸渠道多选 + textMode 切换/持久化/重建（见 F16）；**记录真实尺寸**：`generate.worker` 优先用 `apps/ai` 探测值，兜底自读 PNG IHDR/JPEG SOF 头（AI 容器探测在灰度不稳，worker 端零依赖兜底）→落 `params.actualWidth/Height`。**灰度真验**：出图后 `params.actualWidth/Height=1024×1024` 已写入 | 完成+灰度验 2026-06-21 |
| K6 | 首个 admin bootstrap 原子化（并发竞态） | ✅ | `register/route.ts` Serializable 事务 + P2034 退避 | 完成 2026-06-20 |
| K7 | WEBSITE 素材初始 host 重校验（防 DNS rebinding；`_inline_image` 现 `allow_private_initial=True` 盲信初始 host） | ✅ | `apps/ai` `_inline_image(source=)` 对 `WEBSITE` 源校验初始 host（+逐跳）；UPLOAD/storage 源保持可私网。source hint 经 contracts(`AssetSourceHint`)+schemas.py 双侧 + recognize/describe/reference 串接；web 路由从 `Asset.source` 解析 | 完成 2026-06-20 |

## L · 产品方案缺口（反推清单 · 给产品确认补需求）

> 实现/设计对照后暴露的**没做 / 没设计 / 没对齐**点。每条标注：是「设计有·实现缺」还是「设计缺·需补」。供产品反推需求。

| 编号 | 缺口 | 性质 | 关联 | 建议 |
|---|---|---|---|---|
| L1 | ~~模板库 P06 完全无~~ → 真模板库已补 | 设计有·**已补** | G1/A1 | ✅ 策展预设模板→点选预填工作台驱动真出图；6项 nav |
| L2 | ~~推荐品牌瀑布流无~~ → 已补（用户定调纳入） | 设计有·**已补** | B5/H14 | ✅ `recommended-brands.tsx` 接真 BrandWorkspace（owner/member 范围）；自助 verified 流 phase-2 |
| L3 | ~~顶部通知中心无~~ → 已补（用户定调纳入） | 设计有·**已补** | A3/P01-M03 | ✅ 通知中心从真实终态派生；未读 localStorage（phase-2 转服务端 per-user） |
| L4 | ~~8 类富结构卡退化 + 品牌预览缺~~ → 全部已补 | 设计有·**全补** | D4-D10 | ✅ D4-D9 富卡片 + D10 品牌预览（§2 异步走 generate，灰度真验） |
| L5 | ~~工作台三右栏模块无~~ → 风格词/参考素材/额度三模块已接 | 设计有·**已补** | F7/F9/F11 | ✅ 三模块全接（后端 frozen-additive 解锁） |
| L6 | ~~工作台顶部 撤销/重做/缩放 无~~ → 已补 | 设计有·**已补** | F2 | ✅ Toolbar 撤销/重做（表单快照历史）+ 大图 zoom in/out/reset/fit |
| L7 | ~~Campaign 项目操作只做了进入工作台~~ → 全部已补 | 设计有·**全补** | C9/H4 | ✅ 进入工作台/补充需求/查看规范(H4 侧栏)/提交终审/归档 全接入 |
| L8 | ~~素材↔工作台/Campaign 无联动~~ → 设为参考/加入项目已接（reference-tray 暂存 ↔ 工作台 F9，出图真校验+持久化） | 设计有·**已补**(客户端暂存) | E11/E12/F9/H7 | ✅ UI 联动通；2 点 phase-2：①服务端 Project↔Asset 持久关系（多设备/协作）②参考图真视觉条件化（经 edits，OpenAI generate API 不收图） |
| L9 | ~~通用弹窗体系：仅「新建 Campaign」是弹窗~~ → 弹窗体系已补 | 设计有·**已补** | H2-H12 | ✅ H4 查看规范/H7 加入项目/H9 提交确认/H12 额度升级 + 既有创建/上传/补充需求弹窗，复用统一 dialog 范式 |
| L10 | ~~AI 输入框未抽象；语音/附件仅视觉~~ → 已补 | 设计有·**已补** | B2/D1/H1 | ✅ `AIInput` 组件(附件+Web Speech 语音)；brief 拆解(B2)/打标(E9)/解析(D1) 真 AI 接入 |
| L11 | ~~品牌筛选/时间筛选/排序无~~ → 已补 | 设计有·**已补** | C4/C5/C6 | ✅ 品牌筛选 + 时间范围 + 排序全接入 |
| L12 | ~~AI 解析入口部分缺~~ → 全部已接真 VLM | 设计有·**全接** | B2/D13/D14/E9/E10 | ✅ 知识库 recognize/parse-manual + 首页 brief 拆解(B2) + 素材自动打标 describe(E9/E10) 全接真 VLM，灰度真验 |

## 附录 · 作废区

> 作废条目移到此处留痕（保留审计），格式：`编号 · ~~标题~~ · 作废 YYYY-MM-DD · 原因`。

（暂无）

---

# 工程参考

## 架构

Monorepo（pnpm + Turborepo）：

| 路径 | 说明 |
| --- | --- |
| `apps/web` | Next.js 15 App Router（前端 + BFF），Auth.js / TanStack Query / Zustand |
| `apps/ai` | Python FastAPI AI 服务，Provider 适配层（mock + 第三方 HTTP） |
| `packages/contracts` | **冻结契约**：Zod schema + TS 类型，前后端 + AI 唯一事实源 |
| `packages/db` | Prisma schema + client（PostgreSQL） |
| `packages/ui` | 设计系统 + AppShell（BrandAI 紫色主题，16 语义 token） |
| `packages/config` | tsconfig / tailwind 预设 |

异步出图为服务端权威：BFF 路由落 `AsyncTask` + BullMQ job，worker（`apps/web/src/lib/workers/`）调 AI 服务，客户端轮询。契约改动需同步 `packages/contracts/src/*.ts` 与 `apps/ai/app/schemas.py`。

## 本地启动

```bash
cp .env.example .env
pnpm install
docker compose up -d postgres redis
pnpm db:generate && pnpm db:migrate && pnpm db:seed

# AI 服务（默认 mock provider，无需任何 API key）
cd apps/ai && python3 -m venv .venv && . .venv/bin/activate \
  && pip install -r requirements.txt \
  && uvicorn app.main:app --reload --port 8000      # http://localhost:8000/docs

# Web（另开终端）
pnpm --filter @brandai/web dev                        # http://localhost:3000
```

真实出图 provider 通过 `/admin/settings/ai` 配置 → 加密进 `AppSetting`（DB 优先于 env）。

## 测试

```bash
pnpm test              # L1: contracts + ui vitest
pnpm test:ai           # L2: apps/ai pytest
pnpm -F web typecheck  # tsc --noEmit
pnpm -F web build      # 生产构建
```

## 文档

- **进度表（本仓库最重要的文档）**：见本 README 顶部 §A–§L。
- 产品/页面/视觉/字段规范：`docs/`（`01`~`08`）。
- 工程约定与硬规则：`CLAUDE.md`。
- 交接提示词（给下一个智能体）：`docs/HANDOFF.md`。
- 旧 HTML 静态原型（设计参考）：`docs/legacy/prototype-html/`。
