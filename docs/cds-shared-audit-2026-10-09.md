# CDS 公司共享库只读审计 · 2026-10-09

本次核查解决 [2026-10-08 CDS 问题记录](cds-development-issues-2026-10-08.md) 中“最后一次 `f968f1a` 意外部署是否继续执行迁移和 seed”的未决项。所有时间均为 UTC；北京时间为 UTC + 8 小时。

**结论：最后一次意外部署确实执行了新迁移和 seed。** 共享库新增了四张工作台状态表；该次 seed 新建了 1 个演示品牌及 3 条关联合规词，并执行了四档套餐的 upsert。当前套餐字段与 seed 一致，但没有变更前快照，无法判断其业务值是否被改动。没有执行数据删除、回滚、修复或部署操作。

## 核查范围与方法

- 目标项目：公司共享项目 `a8a098f7193a`。
- 目标分支：`brandai-platform-claude-novart-product-integration`，Git 分支 `claude/novart-product-integration`。
- 目标提交：`f968f1a0e26722af4c57ba54271f4d6acf16ca00`。
- 使用项目内 CDS CLI 的凭据加载及请求函数，读取 live 分支状态、部署记录、已停止 Web 容器的日志。
- 数据库查询通过已经运行的 `brandai-platform-main` / `web` 容器执行；`profileId=web` 在调用前从 live 服务状态确认。
- 查询使用 Prisma 事务，首先执行 `SET TRANSACTION READ ONLY`。数据库回读 `transaction_read_only=on`，首次数据库取证时间为 `2026-10-09T02:41:51.258Z`。
- 输出仅保留部署元数据、迁移元数据、表行数、演示数据聚合和套餐匹配布尔值。不记录连接串、凭据、账号标识、邮箱、品牌 ID、用户内容或完整日志。
- 未启动已停止的整合分支；未运行 migrate、seed、写入 SQL、配置变更或 Git 写操作。

## 1. 最后部署与当前运行状态

部署记录 `dr_2a55f8fe3d85ac8e94cf16f4`：

| 字段 | 实际值 |
| --- | --- |
| trigger | `webhook` |
| commitSha | `f968f1a0e26722af4c57ba54271f4d6acf16ca00` |
| startedAt | `2026-10-08T09:50:08.880Z` |
| finishedAt | `2026-10-08T09:51:32.141Z` |
| phase | `complete` |
| status | `running`，此值属于历史部署记录 |

live 分支接口记录该分支 `lastDeployAt=2026-10-08T09:51:31.928Z`、`lastStoppedAt=2026-10-08T10:11:54.682Z`，最近派发来源为 `webhook`，提交为上述完整 SHA。

本次实时回读：

| 分支 | 当前提交 | live 分支状态 | Web / Worker / AI |
| --- | --- | --- | --- |
| 公司 `main` | `e99919a` | `running` | 三者均 `running` |
| 公司整合分支 | `f968f1a` | `idle` | 三者均 `stopped` |

历史部署记录的 `status=running` 表示当次部署结果，不能据此认定已停止分支当前仍在运行。当前运行状态以上述 live 响应为准。

## 2. 迁移已执行，文件校验一致

共享库 `_prisma_migrations` 返回：

| migration_name | started_at | finished_at | applied_steps_count | rolled_back_at |
| --- | --- | --- | --- | --- |
| `20261008000100_native_editor_document` | `2026-10-08T06:38:04.757Z` | `2026-10-08T06:38:04.912Z` | 1 | NULL |
| `20261008000200_workbench_shell_state` | `2026-10-08T09:51:03.459Z` | `2026-10-08T09:51:03.611Z` | 1 | NULL |

第二项记录的 checksum 与 `git show f968f1a0e26722af4c57ba54271f4d6acf16ca00:packages/db/prisma/migrations/20261008000200_workbench_shell_state/migration.sql` 的 SHA-256 **一致**。

已停止整合分支 Web 容器的保留日志提供直接佐证：

```text
2026-10-08T09:51:03.717803843Z Applying migration `20261008000200_workbench_shell_state`
```

迁移新增以下四张表及其约束、索引；当前四表与早先新增的 `EditorDocument` 均存在：

| 表 | 本次查询行数 |
| --- | ---: |
| `WorkbenchBrandDraft` | 0 |
| `WorkbenchUserState` | 0 |
| `WorkbenchProjectState` | 0 |
| `WorkbenchChatDraft` | 0 |
| `EditorDocument` | 0 |

0 行仅描述本次查询时的状态，不证明历史上从未写入。新增表本身已经构成共享数据库 schema 的变化。

## 3. Seed 已执行，可确认的新增数据

同一 Web 容器日志包含：

```text
2026-10-08T09:51:05.265642614Z > tsx prisma/seed.ts
2026-10-08T09:51:06.171990443Z Seeded workspace: [REDACTED]
```

核对目标提交中的 `packages/db/prisma/seed.ts`：执行顺序为演示账号 upsert、四档 Plan upsert、演示品牌 create、三条 ComplianceTerm createMany，最后打印 `Seeded workspace`。因此末尾成功日志与数据库记录共同证明本次 seed 已走完上述步骤。

查询按照源代码中演示品牌的固定名称、行业、示例站点和部署时间窗匹配，未输出品牌或账号标识：

| 对应启动 | 演示品牌 createdAt | 新增品牌 | 合规词 createdAt | 新增合规词 |
| --- | --- | ---: | --- | ---: |
| 早先第一次整合部署 | `2026-10-08T06:38:07.269Z` | 1 | `2026-10-08T06:38:07.278Z` | 3 |
| 早先第二次整合部署 | `2026-10-08T06:48:21.403Z` | 1 | `2026-10-08T06:48:21.412Z` | 3 |
| 最后 `f968f1a` 部署 | `2026-10-08T09:51:06.158Z` | 1 | `2026-10-08T09:51:06.164Z` | 3 |

每组 3 条合规词均为 2 条 `FORBIDDEN`、1 条 `CAUTION`。已关联这三次整合部署的可确认新增量合计为 **3 个演示品牌、9 条合规词**；本次待核实的最后一次部署占其中 **1 个品牌、3 条合规词**。

最后一组演示品牌的 owner 在该次部署前已经存在；源码对既有演示账号使用 `update: {}`。没有证据表明该次 seed 创建了一个新演示账号或改写了既有账号字段。

另行聚合发现，10 月 8 日全日有 8 组符合相同 seed 品牌特征的数据，共 24 条关联合规词。其余 5 组早于上述三次整合部署，本次没有完成其来源归属核查，**不得把全日 8 组都归因于本次分支或最后一次部署**。

## 4. Plan upsert 的确定项与未知项

目标提交的 seed 逐项执行 `plan.upsert({ where: { tier }, update: p, create: p })`，该步骤在演示品牌创建与末尾成功日志之前。

| tier | 当前存在 | 被 seed 覆盖的字段均与该提交一致 | createdAt 早于最后部署 |
| --- | --- | --- | --- |
| STARTER | 是 | 是 | 是 |
| PRO | 是 | 是 | 是 |
| TEAM | 是 | 是 | 是 |
| ENTERPRISE | 是 | 是 | 是 |

比较字段为 `name`、`priceCentsMonthly`、`monthlyGenerationQuota`、`dailyGenerationLimit`、`maxWorkspaces`。可以确认最后一次 seed 对四个已存在套餐执行了 upsert 的更新路径。

`Plan` 模型只有 `createdAt`，没有 `updatedAt`；当前没有取得执行前的字段快照或历史变更记录。因此无法量化套餐业务字段的前后差值，也无法声明“套餐完全没有被改动”。当前值与 seed 一致不等于执行前也一致。

## 5. 仍未解决的事项

1. 共享库已有变化，停止分支不会撤销这些变化。是否保留四张空表、如何清理演示品牌和合规词，应在确认依赖与备份后另行决定；本次没有进行清理。
2. 如需核实套餐的实际业务差异，需要恢复变更前快照或取得审计历史，再作比较；不能凭当前值倒推。
3. 本次仅审计共享 PostgreSQL 的上述迁移和 seed 影响，未全面审计 Redis、对象存储或其他业务写入，不能将结论扩展成“所有共享资源均无其他影响”。
4. webhook 接受与派发的证据已经确认；自动部署排除规则、开关恢复与延迟派发的控制，属于另一条调查，不由本次数据库审计推断平台缺陷。

## 取证入口与可复核查询

只读 CDS 调用：

```text
GET /api/branches?project=a8a098f7193a&live=true
GET /api/deployment-runs?project=a8a098f7193a&branch=brandai-platform-claude-novart-product-integration&limit=10
GET /api/deployment-runs/dr_2a55f8fe3d85ac8e94cf16f4
POST /api/branches/brandai-platform-claude-novart-product-integration/container-logs
  profileId: web
POST /api/branches/brandai-platform-main/container-exec
  profileId: web
  command: 在 /app/packages/db 使用 Prisma 执行只读事务查询
```

关键 SQL（均在 `SET TRANSACTION READ ONLY` 后执行）：

```sql
SELECT now() AS audited_at,
       current_setting('transaction_read_only') AS read_only;

SELECT migration_name, started_at, finished_at,
       rolled_back_at, applied_steps_count
FROM "_prisma_migrations"
WHERE migration_name LIKE '20261008%'
ORDER BY started_at;

SELECT 'EditorDocument' AS table_name, count(*)::int AS rows FROM "EditorDocument"
UNION ALL SELECT 'WorkbenchBrandDraft', count(*)::int FROM "WorkbenchBrandDraft"
UNION ALL SELECT 'WorkbenchUserState', count(*)::int FROM "WorkbenchUserState"
UNION ALL SELECT 'WorkbenchProjectState', count(*)::int FROM "WorkbenchProjectState"
UNION ALL SELECT 'WorkbenchChatDraft', count(*)::int FROM "WorkbenchChatDraft";
```

源码依据：

- [工作台状态迁移](../packages/db/prisma/migrations/20261008000200_workbench_shell_state/migration.sql)
- [种子数据脚本](../packages/db/prisma/seed.ts)：Plan upsert 第 21 行、品牌 create 第 24 行、合规词 createMany 第 33 行、末尾成功日志第 58 行。
- [数据库模型](../packages/db/prisma/schema.prisma)：Plan 无更新时刻字段。
- [2026-10-08 开发日志](development-log-2026-10-08.md)：原始未决项与停止分支记录。
