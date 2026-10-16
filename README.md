# DeepFlare — 品牌视觉 AI 工作台

## 架构

Monorepo（pnpm + Turborepo）：

| 路径                 | 说明                                                                    |
| -------------------- | ----------------------------------------------------------------------- |
| `apps/web`           | Next.js 15 App Router（前端 + BFF），Auth.js / TanStack Query / Zustand |
| `apps/ai`            | Python FastAPI AI 服务，Provider 适配层（mock + 第三方 HTTP）           |
| `packages/contracts` | **冻结契约**：Zod schema + TS 类型，前后端 + AI 唯一事实源              |
| `packages/db`        | Prisma schema + client（PostgreSQL）                                    |
| `packages/ui`        | 设计系统 + AppShell（BrandAI 紫色主题，16 语义 token）                  |
| `packages/config`    | tsconfig / tailwind 预设                                                |

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
pnpm -F web dev                        # http://localhost:3000
```

Windows 的 AI 单测可在 `apps/ai` 下运行 `.venv\Scripts\python.exe -m pytest -q`。数据库命令仅对自己的隔离开发库执行，不要把示例连接配置指向共享库。Web 开发服务默认在 `http://localhost:3000`；登录后进入 `/studio`，项目画布使用 `/studio-editor?workspaceId=…&projectId=…`。

真实出图 provider 通过 `/admin/settings/ai` 配置 → 加密进 `AppSetting`（DB 优先于 env）。

## 测试

```bash
pnpm install
pnpm db:generate       # ⚠️ 前置：未生成 Prisma client 时 typecheck/build 会红（@prisma/client did not initialize）
pnpm -F web lint       # ESLint + React Hooks
pnpm test              # L1: contracts + web + ui vitest
pnpm test:ai           # L2: apps/ai pytest
pnpm -F web typecheck  # tsc --noEmit
pnpm -F web build      # 生产构建
```

## 文档

- 开发进度与历史：[工作记录目录](docs/worklog/README.md)。README 只维护使用说明；历史版本和发布回执不代表当前分支已部署。
- **新对话 / 新 AI 快速接手入口**：[`docs/产品功能.md`](docs/产品功能.md) + [`docs/产品文档.md`](docs/产品文档.md)。
- 产品/页面/视觉/字段规范：`docs/`（`01`~`08`）。
- 工程约定与硬规则：`CLAUDE.md`。
- 交接提示词（给下一个智能体）：`docs/HANDOFF.md`。
- 旧 HTML 静态原型（设计参考）：`docs/legacy/prototype-html/`。
