# 开发日志 · 2026-10-16 · 优化分支集成

## 2026-10-17 接手续验更新（覆盖下文旧验证状态）

小克在同一集成提交21eb6a5重新执行并保留日志：Web1596/contracts293/UI34、AI547通过；typecheck通过；lint 0错误14警告；build:low-memory exit0。此前“Web待重跑、低内存构建未执行”已补齐。

已对实际独立库执行只读审计：Membership孤儿记录1，其余25表均0，6项跨品牌不一致均0；Web和Worker实际AUTH_SECRET符合启动条件。因Membership阻断新外键迁移，按推送交接停止发布，未推送、未部署、未清理数据。详见 [推送前检查完整报告](push-preflight-2026-10-17.md)。本次不是Git权限失败或CDS构建失败。

## 范围

按《brandai-优化执行计划-2026-10-16》，把五个阶段分支依次合入集成分支 `integration/devupdate-opt`。该分支从 `devUpdate1012@2cf3932` 拉出，工作目录为 `D:/coding/公司/brandai-integration`。

五个阶段分支都是从 `2cf3932` 各自拉出的，单独验证通过不代表合在一起也能通过，所以需要这一轮集成验证。

| 顺序 | 分支 | 合并提交 |
| --- | --- | --- |
| 1 | `fix/p2-security` | `8dc0228` |
| 2 | `fix/p1-remove-captured-bundle` | `eca34e7` |
| 3 | `fix/p3-ai-reliability` | `66ceb5c` |
| 4 | `fix/p4-frontend` | `ccbb9d1` |
| 5 | `chore/p5-engineering` | `07127fd` |

P1 第一次合并时被工作区的换行符状态挡住，没有合进去，所以实际落在 P2 之后。两者改动的文件只在工作日志上重叠，顺序不影响结果。

## 冲突处理

- **工作日志类文件**（README、findings、progress、task_plan、docs/02、docs/10、当日开发日志）：两侧内容都保留，HEAD 侧在前。
- **两个预检路由**：采用 P3 的异步任务版本（`createComplianceTask`，返回 202）。P2 的 EDITOR 权限检查在两侧一致，没有丢失。
- **P4 与 P3 的前端冲突**：import 冲突两侧都保留；素材抽屉采用 P3 的有界轮询，同时改用 P4 修正后的 token 类名。`text-danger` 在预设中不存在，统一改为 `text-destructive`。
- **P5 与 P3**：
  - `RecognizeRequest` 同时保留 P3 的单次调用基类和 P5 的 `min_length=1`。
  - campaigns 页同时保留 P5 的 `<Link>` 和 P4 带 workspaceId 的链接。
  - `OwnedEditorClient` 采用 P3 的轮询，同时保留 P5 的稳定依赖写法。
- **测试归位**：P5 把 contracts 下的测试移到 `apps/web/tests`，P2 和 P3 新增的测试却还写在 contracts 下。这三个冲突测试以集成后的内容为准，按 P5 的路径规则改写。`studio-license-config.test.ts` 已被 P1 删除，跟随删除。
- **CI**：`novart-integration.yml` 采用 P5 的测试位置，去掉了 P1 已删除的 `test-novart-home-start.cjs`。

## 合并后发现并修复的问题

1. P2 和 P3 新增的 18 个测试还在 `packages/contracts/tests`，并引用了 `apps/web` 的代码。contracts 下没有 `@/` 别名，这些测试全部失败。已移到 `apps/web/tests`，并改写相对路径。
2. `asset-upload-route.test.ts` 迁移后，同一个模块被重复 mock，覆盖掉了 `handleError`。已删掉多余的那一行。
3. `runtime-security.test.ts` 的 `webRoot` 路径没有跟着迁移，已修正。
4. `precheck-permissions-route.test.ts` 还按 P2 的同步预检接口在写断言，改为断言 P3 的契约：返回 202，并调用 `createComplianceTask`。
5. `legacy-worker-runtime.test.ts` 需要真实的 `async-tasks` 模块，但 web 的 `@` 别名会把它解析到 mock 上。已改用 `vi.importActual`。
6. AI 测试 `test_legacy_single_attempt.py` 的样例违反了 P5 收紧后的契约（空的 `assets`、小写的 `op`），已改成合法值。
7. P5 启用 react-hooks lint 后，P3 新增的轮询代码有 14 处依赖报错，构建会被阻断：
   - 大部分改为解构出稳定的成员函数后再列入依赖。
   - campaigns 和 workspace 页各有一处，所需的回调声明在后面，提前列入依赖会报 TS2448，只能加带原因说明的 disable 注释。

## 验证结果（2026-10-16 实测）

| 项目 | 结果 |
| --- | --- |
| 冲突标记残留 | 0 |
| contracts / UI / web 单测（lint 修复前） | 293、34、1596 全部通过 |
| AI pytest | 547 通过 |
| web lint（`eslint src --quiet`） | 0 error |
| web 类型检查（`tsc --noEmit`，lint 修复后） | 通过 |
| UI 单测（lint 修复后） | 34 通过 |
| web 单测（lint 修复后） | **未确认**。和生产构建同时运行，出现大量 FAIL，疑似内存不足，需要单独重跑 |
| `pnpm -F web build` | **失败**，退出码 134，Node 进程崩溃，疑似内存不足。`build:low-memory` 还没跑 |

以上全部是本地运行，没有连接真实数据库、Redis、S3 或模型。

## 尚未完成

- 在本机单独重跑 web 单测，并跑一次 `pnpm -F web build:low-memory`，两项都全绿才算通过门禁。
- 没有推送，也没有部署。帅帅已决定推送到 `devUpdate1012`，但门禁通过之前不推。
- 部署前的风险：
  1. P5 的外键迁移不会清理孤儿数据。推送后 CDS 会在 `brandai_devupdate1012` 上自动执行迁移；只要有孤儿行，迁移就会失败，预览返回 503，后续部署也会被卡住。审计脚本是 `scripts/sql/p5-workspace-orphan-audit.sql`，还没执行。
  2. P2 的启动检查要求 `AUTH_SECRET` 至少 32 位，而它来自 CDS 的 `CDS_JWT_SECRET`。实际长度还没确认，太短的话 web 和 worker 会拒绝启动。
  3. web、worker、AI 三个服务必须同时发布，因为 P3 的单次调用契约版本是 r2。
- 审查中发现、集成时还没修的问题：
  - **P3**：edit worker 的业务写入和任务成功状态分在两个事务里提交，超时可能让已经生成好的图显示为失败。
  - **P4**：注册关闭时注册入口被隐藏，白名单管理员也就找不到注册入口。
  - **P2**：上传时内存会被放大，middleware 的请求体上限放宽到了所有路由。
