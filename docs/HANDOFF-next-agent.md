# 交接文档 · 下一个智能体接手（2026-06-21）

> 本轮收尾：PR #27 已 **merged**，所有"可立即修"的评审项均已修复并合入。本文件是下一个智能体的事实源——读完即可接着干。配合 `README.md` 顶部进度表 + `CLAUDE.md §3.5`（phase-2 SSOT）一起看。

开发分支（两仓库一致）：`claude/cool-dirac-ufjfyg`
活动仓库：`nickzhang2999-dev/brandai-platform`（`inernoro/openvisual` 本轮无改动，是参考底座）

---

## 一、本轮已完成（PR #27，已合并）

按评审轮次修复并合入的项（全部走过 gate：`pnpm test` + `pnpm -F web typecheck` + `pnpm -F web build` + `apps/ai` pytest）：

- **R5**：网站采集 ingest 轮询的 BullMQ returnvalue 竞态（重试而非硬失败）；品牌预览轮询仅在 `jobId` 非空时拼接 `?jobId=`；素材页读取 `?category=` 深链筛选。
- **K7 source hint 串接**：`generate.worker.ts` 用户参考素材 + `recognize` 入队路由都把 `Asset.source` 作为 SSRF 提示透传，WEBSITE 素材出图/识别时走严格初始 host 校验（防 DNS rebinding）。AI 侧（`_inline_image(source=...)`）与契约早已支持，只差 web 侧填值。
- **AI 健壮性**：多尺寸出图 `urls[0]` 空响应 → 受控 502（命名失败的 target），不再 500 IndexError。
- **§2.4 timedOut 盖过成功**：品牌预览 / 素材描述 / Campaign AI 摘要三处，渲染分支加 `status !== "SUCCEEDED"` 守卫——卡点期前后落地的成功不再被"超时"文案盖住。
- **通知中心**：`SUMMARIZE`（首页 brief 立项 + Campaign 摘要）加入 `NotificationKind` + `TASK_KIND_META`，终态进收件箱。

---

## 二、待办：品牌预览标记改 DB 列（用户已拍板做，本轮未实现）

**背景（Codex P2，真实 bug）**：品牌预览项目当前用**显示名** `"品牌预览"` 识别（`lib/brand-preview.ts`）。若用户建了同名 Campaign，会被当成预览桶（出图写进去），且 `listWorkspaceProjects` 的按名过滤会把它从 Campaign/首页/素材页全部隐藏掉 → 用户的 Campaign "消失"。

**用户决定**：用**非用户可控的 DB 列**做标记（不要按名识别）。

### 实施步骤（精确）

1. **schema** `packages/db/prisma/schema.prisma` · `model Project`：
   ```prisma
   isPreview   Boolean        @default(false)
   ```
   （可选加 `@@index([workspaceId, isPreview])`，预览查询是 `findFirst` 单行，非必需。）

2. **迁移**（沙箱**无本地 Postgres**，`DATABASE_URL` 未设，跑不了 `prisma migrate dev`）。手写一个时间戳目录，仿照现有 `packages/db/prisma/migrations/*/migration.sql`：
   目录名如 `packages/db/prisma/migrations/20260621NNNNNN_project_is_preview/migration.sql`
   ```sql
   ALTER TABLE "Project" ADD COLUMN "isPreview" BOOLEAN NOT NULL DEFAULT false;
   -- 回填已存在的按名预览项目（历史数据）
   UPDATE "Project" SET "isPreview" = true WHERE "name" = '品牌预览';
   ```
   注意：CDS 启动会跑 `prisma migrate deploy`（见 `scripts/web-startup.sh`）。务必让迁移文件名时间戳 > 现有最新（当前最新 `20260621100829_asset_folders`）。提交后必须 `pnpm db:generate` 刷新 Prisma client（否则 `isPreview` 字段 TS 不认）。

3. **`lib/brand-preview.ts`** `getOrCreatePreviewProject`：
   - 查找改 `where: { workspaceId, isPreview: true }`。
   - 创建改 `data: { ..., isPreview: true }`（`name` 仍可留 `"品牌预览"` 作显示用，但**身份是 flag**）。
   - `BRAND_PREVIEW_PROJECT_NAME` 常量可保留作显示名，但**不再用于识别**；其它文件不要再 import 它做过滤。

4. **`lib/generations.ts:245`** `listWorkspaceProjects`：
   `where: { workspaceId, isPreview: false }`（删掉 `name: { not: BRAND_PREVIEW_PROJECT_NAME }` 与 import）。

5. **`lib/notifications.ts:63`**：
   `project: { isPreview: false }`（删掉按名过滤与 import）。

6. **Gate**：`pnpm db:generate && pnpm test && pnpm -F web typecheck && pnpm -F web build` 全绿，再 push。**灰度验证**：部署后建一个名为"品牌预览"的真 Campaign，确认它在 Campaign 列表正常显示、且不被当预览桶（出图仍进 isPreview=true 的隐藏项目）。

---

## 三、Phase-2 backlog（用户已同意延后，勿在 phase-1 修）

均为 `CLAUDE.md §3.5` 已登记的"竞态/配额 enforcement"类，phase-1 单超管 owner 短路配额 → 不可达：

1. **Brief-decompose 幂等**（Bugbot Medium，`summarize.worker.ts`）：每次成功都新建草稿 Campaign，超时重提会攒孤儿草稿。正解 = 客户端幂等 token 串 route→job→worker + 唯一约束（需迁移）。
2. **配额/上限原子化**（Codex P2）：
   - `app/api/workspaces/route.ts`：`maxWorkspaces` 是 read-then-write 竞态（并发 POST 可双双过检）。
   - `lib/quota.ts:296` `assertRegenerateQuota`：两个并发 FAILED 重试可同时过 `getUsage` 检查。
   - `lib/quota.ts:303`：`countOwnerUsage` 现在把"有 versions 的 FAILED"计入，但 `assertRegenerateQuota` 仍把所有 `priorStatus==="FAILED"` 当未计入 → 对"有保留产出的失败重试"会多 +1、在临界点误拦。
   修这组时按 §3.5："配额原子预留(并发)"统一用 Serializable 事务 / 约束 / 计数器。
3. 其余见 `CLAUDE.md §3.5 · Phase-2 backlog` 原文（WEBSITE 素材防 DNS rebinding 的 prohibition 示例素材路径、Campaign Kit/ingest 的 §2 异步化、PDF 知识库 recognize 证据 optional 等）。

> 注：本轮还有一处 K7 缺口**故意未补**——prohibition 示例素材经 `lib/prohibitions.ts::loadAssetUrlMap → compileAIConstraints` 内联时未带 `sourceHint`（需改编译器签名，且这些是超管自传素材）。Bugbot 未单独 flag，归入 §3.5 的 SSRF backlog。

---

## 四、运维备忘

- **Gate**：`pnpm test`（L1 contracts+ui）/ `pnpm -F web typecheck` / `pnpm -F web build`（构建期 Redis ECONNREFUSED 是预期、非致命）/ `apps/ai` pytest（需 `apps/ai/.venv`）。
- **铁律**：出图模型写死 `gpt-image-2`（`apps/ai/app/config.py` 默认 + AppSetting）。
- **CDS 灰度**：project `a8a098f7193a`，分支 `brandai-platform-claude-cool-dirac-ufjfyg`，URL `https://brandai-platform-claude-cool-dirac-ufjfyg.geole.me`。push 触发 githubAutoDeploy webhook 自动部署。CDS 技能包已装（`cds` / `cds-deploy-pipeline` / `cds-project-scan` + `cdscli`）。
- **跨分支隔离**：已修（`BULLMQ_PREFIX` 分支隔离 Redis + 分支级 `AI_SERVICE_URL` 唯一容器名）。
- **不建 PR** 除非用户明确要求。完成后更新 `README.md` 顶部进度表对应行。
