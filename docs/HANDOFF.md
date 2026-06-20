# 交接提示词 · BrandAI（给承接的下一个智能体）

> 一期代码已合并入主分支、PR #1 已关闭。直接把下面代码块作为系统/首条指令交给下一个智能体——它已按「合并后」语境写好，自洽。

```
你接手 BrandAI（品牌视觉 AI 平台）的开发。仓库 nickzhang2999-dev/brandai-platform。
一期代码已合并入主分支（main），PR #1 已关闭。**你从最新 main 拉一条新分支
claude/<你的-slug> 开发，完成后开一个新 PR；不要复用旧分支、不要往已关闭的 PR #1 推。**

第一步先读：README.md 顶部「进度表」（本仓库最重要的文档 / 你的工作底单），
再读 CLAUDE.md（尤其 §0 硬规则与 §3.5 阶段模型/多租户隔离标准）、docs/01、docs/HANDOFF.md。

## 这是什么
BrandAI 全栈架构迁移自 openvisual（成熟的多租户品牌视觉平台）：Next15 BFF + FastAPI
AI 服务 + BullMQ worker + Prisma/Postgres + Zod contracts。产品以 Campaign 为中心、
紫色设计语言。最终目标是多租户 SaaS；一期是单超管内部后台。

## 第一件事:读 README 顶部「进度表」
它是「产品方案 × 实现」的超集进度表(模块/子模块/功能点/事件流 + 状态勾选 + 代码路径 +
变更/作废机制),是你的工作底单。逐行核对、勾选、补完成日期;产品新增需求往对应模块追加行
(变更列写"新增 日期");作废条目移文末附录留痕。动手前先按它对一遍现状,做完一项就更新对应
行——这是避免遗漏的唯一抓手。

## 现状(一期已合并,端到端真验收过)——勿重复造
- 5 个 BrandAI 紫色页(/、/campaigns、/brand-knowledge、/assets、/workspace)已从 mock
  接到真实 workspace 作用域 BFF;工作台真出图端到端验收过(OpenAI gpt-image-1,落
  GenerationVersion,真 PNG)。
- 一期闭环 6/6 全通:Campaign 创建 → 品牌知识库 → 素材库 → 真出图(gpt-image-1) → 真改图
  (OpenAI /images/edits multipart) → 终选 + 导出交付 ZIP。
- 公网门禁已做:demo 关 + 注册防接管 + 只 ADMIN_EMAILS 登录 + middleware.ts 边缘门禁 +
  key 加密存 DB(密钥+JWT 混合,永不下发)。用户体系底座(Auth.js + User/Membership +
  workspace 作用域)保留勿删——是二期多租户地基。
- OpenAI provider 经 /admin/settings/ai 加密入 DB(DB>env)。超管账号 inernoro@gmail.com
  (密码在与用户的对话里,不在代码);ADMIN_EMAILS 经 CDS 单键 env 配置。
- 部署:geole.me 的 CDS 灰度,project id a8a098f7193a。用 .claude/skills/cds-deploy-verify
  技能部署+冒烟(push 你的分支→注册分支→deploy→等构建→登录/health/真出图冒烟);灰度子域
  由你的分支名派生。

## 你的任务 = 两条线,都以 README 进度表为底单推进

### 线 A · 补齐设计稿(README 进度表 §L「产品方案缺口·反推清单」)
一期把业务主干跑通了,但设计稿的「富展示 / 跨模块联动 / 弹窗体系」大量没做。优先级建议
(逐项先与用户确认范围,部分需产品定调):
- L8 素材「加入项目/设为参考」 → 素材库↔工作台/Campaign 的核心联动,断点,优先。
- L5 工作台缺 风格关键词 / 参考素材 / 额度 三右栏模块(后端已支持,UI 未接)。
- L12 AI 解析入口未接(首页输入解析 / 知识库 AI 共创 / 素材自动打标)——后端能力都在,
  前端入口空着,这是「AI 驱动」定位的核心。
- L4 品牌知识库 8 类富卡片退化为通用规则卡(色板/Logo do-don't/品牌预览)。
- L1 模板库 / L2 推荐品牌瀑布流 / L3 通知中心完全没做(L2 在单超管语义存疑,先问用户)。
- L9 11 个产品弹窗目前只做了「新建 Campaign」。
紫色设计语言(CLAUDE§0.6):唯一品牌色 violet,走语义 token,复用 packages/ui。

### 线 B · Phase 2 多租户 SaaS(README 进度表 §K + CLAUDE §3.5)
这批是一期里被归「一期外」的评审 P2,不是一期缺陷:
- 配额/计费:按 owner 计、配额原子预留(并发)、regenerate/campaign-kit 走配额门、套餐
  maxWorkspaces enforcement。
- G6 协作:(app) owner-only 守卫放行被邀成员、getOrCreateActiveBrand 先解析 Membership、
  导出/单图下载只放行 final/approved。
- 健壮性 & §2 异步化:首个 admin bootstrap 原子化;Campaign Kit precheck / ingest 网站
  采集移入 worker(现同步 await 慢 AI,违反 §2)。
- SSRF·WEBSITE 素材防 DNS rebinding(K7):_inline_image 现盲信初始 host;接 ingest+多用户
  时按 asset source 区分修(UPLOAD/storage 可私网,WEBSITE 初始 host 也校验)。
- PDF 知识库 / recognize 证据:Evidence.assetId 改 optional + _coerce_recognize 保留
  note-only & 校验 assetId 属于请求素材集(成套改两侧)。
- 多尺寸:记录 OpenAI snap 后真实尺寸、regenerate 持久化 textMode。

## 工作纪律(binding)
- No mock(CLAUDE§0.1):每张验收产出必须 真 provider→真 API→真 DB。
- Investigate, never ask for creds(§0.2):先查 DB/env/代码再下结论;CDS/AI key 已在沙箱 env。
- §2 不在 HTTP handler await 慢调用:AI 调用进 worker,2s 响应 + 轮询 + 有界中间态。
- 每次 push 前 pnpm test && pnpm -F web typecheck && pnpm -F web build + apps/ai pytest
  全绿。改完用 cds-deploy-verify 技能在灰度冒烟。
- 评审(Codex/Bugbot):安全/数据/正确性类直接修+推+灰度验证;计费/配额/协作/竞态类属
  phase-2 backlog,按 §3.5 暂缓(单超管一期不触发)。回评论要克制。
- 每做完一项,更新 README 进度表对应行的状态/日期——避免遗漏的唯一抓手。
- 分支纪律:从最新 main 开新分支 claude/<slug>,完成开新 PR;不直接推 main、不擅自合并。
```
