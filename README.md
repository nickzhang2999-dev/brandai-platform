# BrandAI — 品牌 Campaign 视觉 AI 生成平台

以 **Campaign 项目** 为中心，围绕 **品牌知识库 / 素材库 / AI 工作台** 组织品牌广告物料的生成、修改与归档。全栈架构迁移自姊妹项目 `openvisual`，产品定位与紫色视觉由设计师重做。

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

演示登录：`/login` 输入任意邮箱即自动建账号（`AUTH_ALLOW_DEMO=1` 时）。
真实出图 provider 通过 `/admin/settings/ai` 配置 → 加密进 `AppSetting`（DB 优先于 env）。

## 测试

```bash
pnpm test              # L1: contracts + ui vitest
pnpm test:ai           # L2: apps/ai pytest
pnpm -F web typecheck  # tsc --noEmit
pnpm -F web build      # 生产构建
```

## 文档

- 产品/页面/视觉/字段规范：`docs/`（`01`~`08`）。
- 工程约定与硬规则：`CLAUDE.md`。
- 旧 HTML 静态原型（设计参考）：`docs/legacy/prototype-html/`。
