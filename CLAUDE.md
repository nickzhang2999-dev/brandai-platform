# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Provenance.** BrandAI 的全栈架构迁移自姊妹项目 `openvisual`（成熟的品牌视觉 AI 生成平台）：Next 15 BFF + FastAPI AI 服务 + BullMQ worker + Prisma/Postgres + Zod contracts。产品定位、页面与视觉由设计师重做（以 **Campaign 项目** 为中心，紫色设计语言）。架构与代码逻辑复用 openvisual，业务语义与 UI 是 BrandAI 自己的 SSOT。

---

## §0 · Hard rules（binding，迁移自 openvisual 的血泪规则）

1. **No fake data. No mock.** 每一张验收截图/产出都必须经 真 provider → 真 API → 真 DB。`IMAGE_PROVIDER=mock` / `VLM_PROVIDER=mock` 仅供开发与零 key 契约测试，**绝不出现在任何取证材料里**。禁止 `INSERT` 绕过真实 worker 管线伪造 `Generation*/Asset` 数据；禁止用 `apps/web/public/` 里的占位 SVG 冒充"生成结果"。

2. **Investigate, never ask for credentials.** 所有密钥通过 `/admin/settings/*` UI → 加密进 `AppSetting`（Postgres 单例行，运行时由 `apps/web/src/lib/settings.ts::getEffectiveAiSettings()` / `getEffectiveStorage()` 解密）。**DB 优先，env 兜底。** 在说"请提供 X key / 沙箱无凭据"之前先：
   - `docker exec brandai-postgres-1 psql -U brandai -d brandai -c 'SELECT "imageProvider", length("imageApiKey"), "imageModel" FROM "AppSetting";'`
   - `env | grep -iE 'CDS_|AI_ACCESS_KEY'`
   - `grep -rn "process.env.X" apps/` 读真实代码路径再下结论
   - 用户配置值 > 训练知识：截图里 `imageModel = gpt-image-2` 就用 `gpt-image-2`，别二次猜模型 ID/端点/厂商名。

3. **Never `await` a slow call (AI / external) in an HTTP handler.** 对任何可能长耗时的服务交互（generate / recognize / parse-manual / edit / upload）binding。四条子规则：
   - **§2.1 · 2 秒响应** — 用户必须 2s 内看到东西（结果 / 明确的"已受理/处理中" / loading）。Handler 只做：auth → 快检（DB/内存）→ 落 PENDING → enqueue → 返回 202。`await ai.*()` 在 route handler 里禁止；AI 调用在 worker。
   - **§2.2 · Server-authoritative** — 每次 AI/外部交互都在 worker 跑。客户端提交后可关闭/刷新/离开，请求照样完成、稍后浮现。客户端持 id 轮询；中间态有界（默认 6 分钟），超时给明确出口（"可能失败，重试/看队列"），绝不无限转圈。
   - **§2.3 · Observable** — 跨页常驻面（右下角队列 widget / 站内收件箱）始终展示服务端进度（PENDING/RUNNING/SUCCEEDED/FAILED + 进度 + 耗时）；终态通知；失败带可读原因 + 重试入口。
   - **§2.4 · Timeout-guarded** — 任何长操作都防呆：服务端 job TTL + 卡死 worker → FAILED；客户端有界中间态 + 出口。服务端状态是权威。

4. **CDS 就绪窗 ~215s & `.next/` 构建不变式.** `scripts/web-startup.sh` 先用 Node 占位服务器秒开端口，再前台跑 `pnpm install + prisma migrate + next build` 并 exec 进 `next start`。`.next/` 通过 `.:/app` bind 跨部署存活——它把已构建 commit 记到 `apps/web/.next/CDS_DEPLOY_COMMIT`，只有 `git rev-parse HEAD` 匹配才跳过构建。**改这个文件务必保留：(a) 2s 内开端口；(b) HEAD 变化必重新 build。** "部署成功" ≠ "新代码在跑"——用 `/api/health` + 反映新行为的端点确认。

5. **Compose审批 expensive — batch changes.** `cds-compose.yml` 改动触发人工审批门（`pending-import` → 人点 `approveUrl` → `branch deploy`）。纯代码改动（含 `scripts/web-startup.sh`、`.npmrc`、env）直接 `branch deploy`。compose 改动攒批，一批一审。

6. **Frontend = BrandAI 紫色设计语言（唯一品牌色 violet）.** `packages/ui/src/styles.css` 是 16 语义 token 系统，切换 `<html>` 上的 class 即整体换肤。**品牌色只有 violet `#7C5CFF`（`--primary`/`--accent`/`--ring`）；soft lavender `#F4F0FF`（`--accent-soft`）做选中/强调底；页面近白中性 `#FAFAFC`，白卡靠 violet 染色软阴影 + 中性 hairline `#ECECF3` 浮起。** 圆角偏大（卡片 24px、AI 输入 32px、chip/badge 全圆）。字体统一 **Inter**（无衬线，`font-serif` 已别名到 Inter）。**禁止** 重新引入 burgundy / 暖色 tan / cream；禁止硬编码 `bg-[#...]` / `text-yellow-600`，全部走语义 token。复用 `packages/ui` 的 primitives（Button / Card / Badge / Input / Panel）+ `Lightbox`，匹配其圆角/间距/边框风格。
   > 注：本规则取代了 openvisual 的 burgundy/中性约束——BrandAI 是新产品，紫色方案是新 SSOT（见 `docs/04_UI视觉规范文档.md`）。

7. **交付门（binding，V0.02 复盘沉淀）—— 见 [`AGENTS.md`](./AGENTS.md) 跨工具门禁全文.** 两条不可违反：
   - **未验证不交付**：push 前 `pnpm test && pnpm test:ai && pnpm -F web typecheck && pnpm -F web build` 必须全绿。**「沙箱无网/装不上依赖」不是放行理由**——换能联网环境跑，或把改动停在分支等门禁过。交付说明只写**已实测结果**，禁止「未完成校验」却同时标「已推送」（V0.02 犯过，`docs/10` #6）。
   - **会被刷新/分享的状态必须服务端权威**：租户/品牌/当前项目落 cookie 或进 URL，让 SSR/刷新/深链解析同一值；**只存 `localStorage` = 双事实源，禁止**（V0.02 多品牌切换犯过，`docs/10` #5；活动品牌现走 `lib/brand-cookie.ts` + `getOrCreateActiveBrand` 成员校验）。

---

## §1 · 四个 canonical 操作

### 本地起栈
```bash
cp .env.example .env
pnpm install
docker compose up -d postgres redis
pnpm db:generate && pnpm db:migrate && pnpm db:seed
# AI 服务默认 mock，无需 key；真 provider 走 /admin/settings/ai → AppSetting
cd apps/ai && python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt \
  && uvicorn app.main:app --reload --port 8000     # http://localhost:8000/docs
pnpm --filter @brandai/web dev                      # http://localhost:3000
```

### 测试 + typecheck（每次 push 前必须全绿）
```bash
pnpm test              # L1: contracts + ui vitest
pnpm test:ai           # L2: apps/ai pytest（需 apps/ai/.venv）
pnpm -F web typecheck  # tsc --noEmit
pnpm -F web build      # 生产 next build，抓 Module-not-found 等
```
L1 含契约快照测试；改 `Card`/`Badge` tone token 或 `editorial.tsx` 需 `pnpm -F @brandai/ui exec vitest --run -u` 重生成快照。

### 部署 CDS 灰度
沙箱 env 已有 `CDS_HOST` / `AI_ACCESS_KEY`，**别问**。`PROJECT_ID`/branch slug 见 §3。注册分支 → （compose 改动才需）pending-import 审批 → `branch deploy`。
健康探针：`curl -sSk https://<branch>-claude-brandai.miduo.org/api/health` 应返回 `{"web":"ok","ai":"ok"}`。

---

## §2 · 架构（动跨切代码前必读）

```
       Browser ── HTTPS ──►  apps/web (Next 15 App Router, :3000)
                                   │  BFF routes → BullMQ
                          ┌────────┴────────┐
                          ▼                 ▼
                    next-server     apps/web/src/lib/workers (BullMQ 容器)
                                            │
                                            └──► apps/ai (FastAPI :8000) ──► IMAGE/VLM provider
                                                                            (AppSetting > env)
        Postgres (Prisma) ◄────────── 全程 ──────────► Redis (BullMQ)
```

- `apps/web` = Next 15 BFF + React。HTTP 路由在 `src/app/api/`；客户端页面在 `src/app/(app)/`。
- `apps/web/src/lib/workers/` 是独立容器（`cds-compose.yml` 的 `worker` 服务），消费 BullMQ job（`generate/recognize/parse-manual/edit.worker.ts`）调 AI 服务。
- `apps/ai`（FastAPI）暴露 `/v1/generate` `/v1/recognize` `/v1/compliance/check` `/v1/parse-manual`。Provider 在 `app/providers/`：`mock.py`（确定性、零 key）+ `http_providers.py`（OpenAI / Gemini / SeedDream / 任意 OpenAI 兼容网关）。

### 唯一事实源：`packages/contracts`
`packages/contracts/src/` 的 Zod schema 是**唯一** wire 格式源——每个 API 路由、每个表单、每个 worker payload、每个 AI 请求体都过它。同一套 schema 镜像在 `apps/ai/app/schemas.py`——**任何契约改动两边同时改**。L1 有 null-vs-optional 测试，Pydantic 与 Zod 不一致就红。
关键文件：`enums.ts` / `entities.ts` / `ai.ts` / `api.ts` / `admin.ts` / `async-task.ts` / `rule-snapshot.ts`。

### 运行时配置真相：`apps/web/src/lib/settings.ts`
`AppSetting` 单例行（`id="singleton"`）存管理员配置的 provider + storage。`getEffectiveAiSettings()` / `getEffectiveStorage()` 解析 DB > env > 默认。`imageApiKey/vlmApiKey/storageSecretKey` 用 `SETTINGS_ENC_KEY`（默认回退 `AUTH_SECRET`）静态加密。轮换该 key 会孤立已存密钥并回退 env——"provider 莫名变回 mock"先查这里。

### 异步任务
recognize / parse-manual / edit / generate 都 server-authoritative：建 `AsyncTask` 行 + BullMQ job，客户端用 `?task=<id>` 刷新可续。Helper：`apps/web/src/lib/async-tasks.ts`；读端点 `api/workspaces/[wsId]/tasks/[taskId]/route.ts`。

### 存储：`apps/web/src/lib/s3.ts`
S3Client 每次调用从 `getEffectiveStorage()` 现构造；未配置存储时回退 `data:` URL。worker 的 `uploadDataUrlImage()` 是唯一把生成图转公网 URL 的调用方。

---

## §3 · 业务模型映射（迁移现状）

架构层（lib / contracts / db schema / workers / ai）已整体迁入并全绿；**业务语义重命名为 BrandAI 概念是进行中的工作**。映射约定：

| 迁移自 openvisual | BrandAI 概念 | 说明 |
|---|---|---|
| `BrandWorkspace` | **Brand**（品牌） | 品牌容器 + 视觉/调性属性 |
| `Project` | **Campaign**（项目） | status/progress/tags/channels/起止日期/aiSummary |
| `BrandRule`+`ProhibitionRule`+`ComplianceTerm`+`RuleSnapshot` | **BrandKnowledge**（品牌知识库） | logoRules/colorSystem/typography/toneOfVoice/visualReferences/designRules + 版本快照 |
| `Asset` | **Asset**（素材库） | + aiTags / aiDescription / isFavorite |
| `Generation`+`GenerationVersion` | **Workspace 出图 + variants** | prompt + styleKeywords + brandConstraint + references |

页面（`src/app/(brandai)/`，5 页）：`/` 首页 · `/campaigns` · `/brand-knowledge` · `/assets` · `/workspace`，加 `/admin/settings/*`。**这 5 页已从 mock 接到真实 workspace 作用域 BFF**（不再用 `brandai-mock.ts` 的实体数据，仅保留 navItems/quickActions 等 UI 常量）：`(brandai)/layout.tsx` 服务端守卫 + `lib/brandai.ts::getOrCreateActiveBrand` 解析"当前品牌"(workspace)，经 `brand-context.tsx` 注入 wsId；各页用 React Query + `apiFetch` 调 `/api/workspaces/[wsId]/*`。工作台 `/workspace` 走真实 server-authoritative 出图（POST generations→worker→apps/ai→真 provider→`GenerationVersion`）。仓库仍保留迁移来的 openvisual 路由（`/workspaces` 等）作为底座/参考。

---

## §3.5 · 最终目标 · 阶段模型 · 多租户隔离标准（phase-2 SSOT）

> 这一节是后续智能体接手的事实源。`docs/01 §六`：**一期专属定制（1-2 客户、单超管内部后台），最终升级为标准 SaaS 多租户运营**。

### 最终目标
BrandAI 终态 = **多租户 SaaS 品牌视觉 AI 平台**：多客户 / 多用户 / 多品牌，带租户隔离 + RBAC + 配额计费。**用户体系不是丢弃、而是分阶段启用**——迁移自 `openvisual` 的成熟用户体系底座（Auth.js + `User`/`Membership` + workspace 作用域 + `quota.ts`）就是这套多租户的地基，phase 2 在其上长出来。

### 阶段模型
- **Phase 1（已完成，闭环 6/6,端到端真验收）** — 单超管内部后台 + BrandAI 紫色 5 页接真后端 + 真出图（`gpt-image-2`【铁律,2026-06-21 起】)。
  - ✅ Campaign 创建 / 品牌知识库 / 素材库 / 工作台真出图。
  - ✅ **修改优化(改图)**:工作台选中变体→op+指令→真 OpenAI `/images/edits`(multipart)→改图子版本。
  - ✅ **最终交付/归档**:设为终稿(isFinal)+ 导出交付 ZIP。
  - ✅ **公网门禁(锁 OpenAI key)**:demo 关 + 注册关/防接管 + 只 `ADMIN_EMAILS` 能登录 + 边缘门禁中间件(`middleware.ts`,未登录连接口都到不了) + key 加密存 DB 永不下发(密钥+JWT 混合)。
  - 全程真 provider→真 API→真 DB,端到端验收通过(生成→改图→终选→导出 ZIP)。
- **Phase 2（多租户 SaaS）** — 启用/补全 openvisual 用户体系底座，落地下方隔离标准 + 配额计费 enforcement + G6 协作。**本轮 Codex 评审里所有"计费/配额/协作/竞态"类 P2 都是 phase-2 backlog（见下），不是 phase-1 缺陷。**

### 多租户隔离标准（binding for phase 2）
1. **每个数据查询必须 workspace（=租户/品牌）作用域 + 成员校验**（`requireWorkspaceRole` / `requireOwnedWorkspace`）。禁止任何跨 workspace 读写。
2. **跨 workspace 资源引用必须校验归属**——已立此规：`lib/prohibitions.ts::assertExampleAssetsInWorkspace`（防 IDOR）。新增引用一律照此。
3. **配额/计费按 workspace owner（租户）计，不按发起的协作者**。
4. **SSRF/asset 代理只服务本租户资源 + 公网安全**：`lib/ssrf.ts`（web）/ `apps/ai/app/ssrf.py`（AI），初始+逐跳重定向+IPv6 映射全维度;raw 代理非图片强制 attachment。
5. **AI 服务不出公网**：已移除 `cds.path-prefix=/ai/`，只经内部 `AI_SERVICE_URL=http://ai:8000`。FastAPI `/v1/*` 无鉴权，永不直接对外。

### Phase-2 backlog（从本轮 PR #1 Codex 评审沉淀，均一期外）
- **配额**：共享 workspace 出图计入 owner / 配额原子预留(并发) / `regenerate` 与 `campaign-kit` 走配额门 / 套餐 `maxWorkspaces` enforcement。
- **协作(G6)**：`(app)` owner-only 守卫放行被邀成员 / `getOrCreateActiveBrand` 先解析 `Membership` 再兜底建品牌 / 项目导出 + 单图下载只放行 final/approved 版本(职责分离,防协作者/VIEWER 拿未审批草稿)。
- **健壮性**：首个 admin bootstrap 原子化(并发竞态)。
- **SSRF · WEBSITE 素材防 DNS rebinding**：`apps/ai` `_inline_image` 现 `allow_private_initial=True` 盲信初始 host(仅校验重定向跳)。WEBSITE 素材 URL 仅存盘时校验过,出图/识别时 host 可能已重绑到私网。接 ingest(下条)+多用户时一并修:按 asset source 区分——UPLOAD/storage URL 可私网,WEBSITE 初始 host 也要校验(threading source 到 AI 服务或在 web worker 侧预解析)。一期单超管+注册关→无不可信 editor,威胁不可达。
- **§2 异步化(底座未接入一期的路径)**：Campaign Kit `runPrecheck` / `ingest` 网站采集都在 HTTP handler 里 `await` 慢 AI,需移入 worker 异步任务；`lib/precheck.ts` 自调用 `/compliance/precheck` 缺会话(仅 `baseUrl` 配置时触发,有直连兜底)。
- **Campaign Kit 计费**：配额按 `scenes.length` 计,但实际按去重 `Set(scenes)` 出图,重复 scene 会误触 402。
- **多尺寸**：记录 OpenAI snap 后的真实尺寸 / `regenerate` 的 `textMode` 仍需持久化才能保留(targets 已能从版本 params 重建)。(targets 数量上界 12 + 尺寸上界 8192 已加。)
- **PDF 知识库 / recognize 证据**：接 PDF 知识库时成套改——① `_coerce_recognize` 现在会丢弃无 `assetId` 的证据(note-only 被丢)且不校验 model 给的 `assetId` 是否属于请求素材集(幻觉 ID 会进证据);② `Evidence.assetId` 改 optional(Zod+Pydantic),否则真 VLM 的 note-only 引用要么被丢、要么回填前 400。三者一并做。
- (已完成,留痕)改图 OpenAI `/images/edits` multipart、targets 上界、demo 关 + 注册防接管 + 边缘门禁,均已在一期做掉。

---

## §4 · 完成任务时
1. `pnpm test && pnpm -F web typecheck && pnpm -F web build` 全绿。
2. commit 用真实 subject（非 "WIP"），分支 `claude/<slug>`。
3. push；compose 改了才走 pending-import 审批，否则 `branch deploy` 即可。**不建 PR 除非用户明确要求。**
4. **push 后必给 CDS 预览地址（binding，用户每次都要）** —— 跑 `python3 .claude/skills/preview-url/preview_url.py` 取根域，按本次改动的真实路由拼功能页路径，回复里贴一行 `【预览】<url>{路径}`；顺手 `curl .../api/health` 期望 `{"web":"ok","ai":"ok",...}`。**禁止自己 slugify / 手拼 `.geole.me`**（唯一入口是该脚本，见 `preview-url` 技能）。交付回复里漏这一行 = 没交付完。
5. **更新 `README.md` 顶部「进度表」对应行的状态/日期**（本仓库最重要的文档·单一事实源），并同步对应 SSOT 文档（`docs/` 下产品/UI/字段文档）。
6. **提需求调整须自带归因代号** —— 凡建议改/加/补需求，标一个代号 + 一句根因，记入 `docs/10_需求调整归因表.md`：**N** 新增需求 · **S** 需求没想清楚 · **I** 没按需求做 · **O** 可见性·验收缺口（做了但页面上看不到/没法确认） · **R** 优化·重构提议 · **E** 环境·部署·运行时（代码对但线上跑旧 commit/缓存/测错环境——判 E 前须 `cds-deploy-verify` 运行时取证，别冤枉 AI）。归因不裁决，聚合后看分布定基础设施投向（O/S 多→CDS 预览+视觉测试+DoD 前置；I 多→CI 回归；E 多→上线判据自动化）。用户侧入口是 **`/prd` 技能**（`.claude/skills/prd/`）：抛一句感受 → 闸门追问到三要素具体 → 落 `docs/prd-intake/` + 回填 docs/10。

## §5 · 接着读
| 想知道 | 读 |
|---|---|
| **进度表（最重要·产品×实现超集·做完一项就勾）** | **`README.md` 顶部 §A–§L** |
| 产品定位与一期范围 | `docs/01_产品定位与一期范围说明.md` |
| 页面功能 | `docs/02_页面功能详细说明表.md` / `docs/03_PRD产品需求文档.md` |
| 视觉规范（紫色 SSOT） | `docs/04_UI视觉规范文档.md` |
| 数据字段与 Mock | `docs/05_数据字段与Mock数据说明.md` |
| **需求调整归因（N/S/I/O/R·投基础设施的依据）** | `docs/10_需求调整归因表.md` |
| **画布/交互类 UI 改动前必读（四类反模式 + 本地真测 playbook，编译绿≠能用）** | `docs/11_前端画布交互经验与本地真测.md` + [`AGENTS.md` G-INTERACT](./AGENTS.md) + `tests/interaction/` |
| wire 格式真相（别造字段） | `packages/contracts/src/*.ts` + `apps/ai/app/schemas.py` |
| 旧 HTML 原型（参考） | `docs/legacy/prototype-html/` |
