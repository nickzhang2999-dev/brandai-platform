# 交接提示词 · BrandAI（给承接的下一个智能体）

> 二轮开发在 PR #21（分支 `claude/cool-pascal-ao72o3`）。把下面代码块作为系统/首条指令交给下一个智能体——它已按「二轮之后」语境写好，自洽。
>
> 历史：一期 = PR #1（已并入 main）。二轮 = PR #21（补设计稿缺口 §L + Phase-2 后端正确性 K4/K5/K6 + 队列隔离 I28）。

```
你接手 BrandAI（品牌视觉 AI 平台）的开发。仓库 nickzhang2999-dev/brandai-platform。
二轮代码在 PR #21（分支 claude/cool-pascal-ao72o3）。**先确认 #21 是否已并入 main：
已并 → 从最新 main 拉新分支 claude/<你的slug>；未并 → 在 #21 基础上继续。不复用旧分支、不擅自合并。**

第一步先读：README.md 顶部「进度表 §A–§L」（本仓库最重要的文档 / 工作底单 / 即原“产品验收主清单”），
再读 CLAUDE.md（§0 硬规则、§3.5 阶段模型与多租户隔离）、docs/01、docs/HANDOFF.md。

## 现状（二轮已做，端到端真验收 + 视觉验收过）——勿重复造
- 进度表「业务主干 + 一期可达的富展示/联动/AI 入口」已基本扫完并接真：
  L4 知识库 8 类富卡片；L5 工作台三右栏（风格关键词 F7 / 参考素材 F9 / 额度 F11）；
  F16 多尺寸渠道 + textMode（直接/分层，持久化+regenerate 重建）；
  L8 素材↔工作台联动（设为参考/加入项目，client reference-tray，仅图片）；
  L12 知识库真 VLM recognize/parse-manual 入口 + 首页 brief 立项；
  C5/C6 Campaign 排序+时间筛选；C9 补充需求/提交终审/归档 + PATCH /projects/[id]；
  模板库占位页 + 第 6 导航项。
- 后端正确性：K4（Evidence.assetId optional + _coerce_recognize 保真）、K6（admin bootstrap 原子化）、
  I28（BullMQ 按部署 BULLMQ_PREFIX 隔离，修共享 Redis 跨部署串 job）。
- 灰度 No-mock 真验收：真 OpenAI gpt-image-1 出图 + 多尺寸(1024²/1080×1440) + textMode + 风格词 + 额度，落真 DB。
- 超管 inernoro@gmail.com（密码在与用户对话里，不在代码）。灰度 project a8a098f7193a，
  子域 brandai-platform-claude-<slug>.geole.me。

## 你的任务（按进度表优先级，逐项先与用户确认是否纳入）
1. 需新后端端点：E9/E10 素材自动打标 + D10 品牌预览 → 新增 VLM /v1/describe（contracts+schemas.py 两侧），
   worker 写 Asset.aiTags/aiDescription；并把 asset 生命周期字段(availableForGeneration/deprecatedAt)
   暴露到 Asset wire 类型，好在 recognize/参考 picker 里灰掉不可用素材。
2. 产品定调类：L2 推荐品牌瀑布流（单超管语义存疑）、A3/L3 通知中心 —— 先问用户是否要。
3. Phase-2（CLAUDE §3.5，做前确认不回归一期）：K1 配额计费 enforcement、K2 协作 RBAC（导出/下载只放行
   final/approved）、K3 Campaign Kit/ingest 异步化、K7 WEBSITE SSRF、K5 记录 OpenAI snap 真实尺寸。
4. 打磨：F2/L6 工作台撤销/重做/缩放；补 D13 真 recognize 的灰度冒烟取证。

## 工作纪律（binding）
- No mock（§0.1）；Investigate never ask creds（§0.2）；§2 不在 handler await 慢调用。
- push 前 pnpm test && pnpm -F web typecheck && pnpm -F web build + apps/ai pytest 全绿；改完用
  cds-deploy-verify 技能灰度冒烟。
- 部署坑（实测）：① 每分支须设 branch-scoped env BULLMQ_PREFIX，否则共享 Redis 下被别的部署 worker 串 job；
  ② 别并发部署（push 的 webhook 自动部署 + 手动 deploy 会撞出 ai:error），冒烟前等 CDS 服务状态=running
  （不是占位 health 的 web:ok）再验，否则会打到旧 worker。
- 评审：安全/正确性类直接修+推+灰度验证；计费/配额/协作/竞态类按 §3.5 留 phase-2。
- 每做完一项更新 README 进度表对应行。
```
