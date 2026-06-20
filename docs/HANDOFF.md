# 交接提示词 · BrandAI（给承接的下一个智能体）

> 直接把下面 `===` 区块作为系统/首条指令交给下一个智能体。它是自洽的。

```
你接手 BrandAI（品牌视觉 AI 平台）的开发。仓库 nickzhang2999-dev/brandai-platform，
开发分支 claude/brave-wright-2p3u3e，PR #1 已开。**先读 CLAUDE.md（尤其 §0 硬规则与
§3.5 阶段模型/多租户隔离标准），再读 docs/01、docs/HANDOFF.md。**

## 这是什么
BrandAI 全栈架构迁移自 openvisual（成熟的多租户品牌视觉平台）：Next15 BFF + FastAPI
AI 服务 + BullMQ worker + Prisma/Postgres + Zod contracts。产品以 Campaign 为中心、
紫色设计语言。最终目标是**多租户 SaaS**；一期是单超管内部后台。

## 现状（已验收）
- 5 个 BrandAI 紫色页（/、/campaigns、/brand-knowledge、/assets、/workspace）已从
  mock 接到真实 workspace 作用域 BFF；工作台真出图已端到端验收（OpenAI gpt-image-1，
  落 GenerationVersion，真 PNG）。
- OpenAI provider 已配（加密入 DB，/admin/settings/ai，DB>env）。
- 部署在 geole.me 的 CDS 灰度，project id a8a098f7193a，URL
  https://brandai-platform-claude-brave-wright-2p3u3e.geole.me 。部署+冒烟用
  `.claude/skills/cds-deploy-verify` 技能（push→deploy→等构建→登录/health/真出图冒烟）。
- 超管账号 inernoro@gmail.com（密码在与用户的对话里，不在代码）。ADMIN_EMAILS 经
  CDS 单键 env 配置。

## 你的任务（按优先级，逐项与用户确认范围）
1. **补齐一期闭环最后两环到 BrandAI 界面**（现仅在 (app)/workspaces 底座）：
   a. 修改优化（改图 edit）——注意 apps/ai 的 OpenAI /images/edits 需改 multipart
      form-data（当前 JSON 会被 OpenAI 400，见 CLAUDE.md §3.5 backlog）。
   b. 最终交付 / 归档（终选 isFinal + 导出 ZIP）。
2. **门禁 UX 决策**（公网安全，必须先问用户拍板，别擅自）：BrandAI 想"打开即后台"，
   但部署在公网，裸跑=任何人烧 OpenAI key。选项：单一访问口令 / CDS 反代 Basic Auth /
   完整用户体系登录。用户已表态"phase 2 增加用户体系"，故用户体系底座（Auth.js +
   User/Membership + workspace 作用域）保留、勿删，作为多租户地基。
3. **Phase 2（多租户 SaaS）**：按 CLAUDE.md §3.5 的隔离标准 + backlog 推进——配额按
   owner 计、配额原子预留、套餐 enforcement、G6 协作放行成员、首个 admin bootstrap
   原子化、Campaign Kit precheck 异步化、多尺寸 snap 尺寸等。这批正是 PR #1 里被
   归类为"一期外"的 Codex P2。

## 工作纪律（binding）
- **No mock**（CLAUDE.md §0.1）：每张验收产出必须 真 provider→真 API→真 DB。
- **Investigate, never ask for creds**（§0.2）：先查 DB/env/代码再下结论；CDS/AI key
  已在沙箱 env。
- **§2 不在 HTTP handler await 慢调用**：AI 调用进 worker，2s 响应 + 轮询 + 有界中间态。
- **紫色设计语言**（§0.6）：唯一品牌色 violet，走语义 token，复用 packages/ui。
- 每次 push 前 `pnpm test && pnpm -F web typecheck && pnpm -F web build` + `apps/ai`
  pytest 全绿。改完用 cds-deploy-verify 技能在灰度冒烟。
- **PR #1 的 Codex 评审**：安全/数据/正确性类直接修+推+灰度验证；计费/配额/协作/竞态类
  属 phase-2 backlog，按 §3.5 暂缓（单超管一期不触发）。回评论要克制。
- 不建新 PR（push 本分支即更新 #1）；不擅自合并。
```
