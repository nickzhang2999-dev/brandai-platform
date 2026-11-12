# 2.0 接手说明

## 新同事从这里开始

1. 阅读 README、TODO、architecture 和 interfaces，先确认自己接的任务编号。
2. 获取远端 `claude/deepflare-2.0-foundation`（首批 PR 尚未合入集成分支时，以该分支评审代码为准）。不要在 main 上开发，不自动更新/合并主分支。
3. 使用 Node >=20、pnpm 9.15.0；`pnpm install --frozen-lockfile`、`pnpm db:generate`。首次工作区执行 `node scripts/install-cds-push-guard.cjs`。
4. 使用独立数据库、Redis 与存储路径。不要复制正式库地址或私密 .env 到文档。只有测试/独立开发库才执行新增迁移。
5. 如需查看骨架接口，仅在独立环境配置双开关。此时没有新 UI 和真实员工执行，READY 的含义见 README。

## 具体分工

| 角色 | 首个任务 | 主要文件 | 交接成果 |
|---|---|---|---|
| 后端 / 编排 | R-01/R-02 | lib/deepflare-v2/service.ts、ports.ts、已有 workers | 有界派发、步骤领取、原任务恢复、未知付费结果不重发 |
| Ommi 对接同事 | O-01/O-02 | contracts/deepflare-v2.ts、OmmiPort | 版本/权限合同、实际选用快照、可回查引用 |
| 前端 | U-01/U-02/U-03 | 新 v2 API + 原 Studio | 简洁任务区、可选粗构图确认、刷新恢复、按次灵感选用 |
| 记忆后端 | M-01/M-02 | DesignMemoryPort | 有来源的候选、确认/撤回、默认同项目 |
| 产品 / 视觉设计师 | U-04/Q-01 | references 中高保真/Features，当前 TODO | 真实 brief、商品图与双模式验收记录 |
| 总负责人 | 分配具体同事、决定下一批与最终合并 | TODO、PR | 优先级与授权，不承担每个工具调用审批 |

## 验证入口

```bash
pnpm test
pnpm test:ai
pnpm -F web typecheck
pnpm -F web lint
pnpm -F web build
bash cds-release.sh check
node --test scripts/test-project-release.mjs
```

一次性 PostgreSQL 库名必须为 `deepflare_v2_test` 且 host 为 localhost/127.0.0.1。设定它的 DATABASE_URL 后：
```bash
pnpm --filter @brandai/db exec prisma migrate deploy
pnpm --filter @brandai/web exec vitest run --config vitest.v2-db.config.ts
```
测试只创建带随机前缀的测试用户/品牌/项目，结束清理；禁止指向业务库。CI 同样使用一次性 Postgres 服务，不读取生产 secrets。

## 每个 PR 交接包

用 [.github/pull_request_template/deepflare-2.0.md](../../.github/pull_request_template/deepflare-2.0.md) 的结构：任务编号/变化、范围、迁移、接口兼容、验收、未完成、回退、文档链接。当前骨架 PR 的线上地址与精确验证状态记在 verification。

代码里已有的“未接入”是明确的责任边界，不要通过返回成功样例消除它。将适配器接入后，先增加故障/权限测试，再用真实服务验证；保留真实请求与产物版本的脱敏证据。
