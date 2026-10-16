# 2026-10-16 · P3 AI 调用与后台任务可靠性

工作目录：`D:\coding\公司\brandai-devUpdate1012`。分支：`fix/p3-ai-reliability`，从 `devUpdate1012@2cf3932` 建立。用户当前要求仅保留本地成果，未推送、部署、合入 dev/main、启动 Docker、运行真实模型或访问共享数据库。

## 本轮处理

1. AI 调用默认五分钟，覆盖配置解析、服务发现、HTTP 和流式响应读取。旧入口也使用有界错误解析，不把上游原始错误体直接显示给用户。
2. Web 付费调用统一发送 `providerRetryPolicy: never`；Python 抓取、识别、描述、手册解析、摘要、编辑同步支持。能力版本升级为 `single-provider-attempt-r2`，避免新版 Web 静默连接不支持旧入口单次调用的 AI 容器。以后部署必须同步 Web/worker/AI。
3. 两个预检和版本复检返回202，输入和结果存进 AsyncTask；独立队列执行，Redis入队丢失可以恢复，已认领任务不重复购买调用。前端从数据库任务读取结果。
4. 旧 worker 使用执行凭据、AbortSignal 和条件事务，阻止超时、清理或重复投递后的迟到业务写入；按 kind 清理僵尸任务，保留 Studio/分层已有生命周期。
5. 多尺寸按每个三分钟、总计三分钟乘尺寸数加一分钟分配预算。同步调整旧生成扫除规则，避免十分钟清理误杀仍在运行的大批次。
6. 六分钟是前台自动查询窗口，不是后台失败判据。页面保留任务并提供继续查询；只恢复 GET，不自动再发一次收费 POST。
7. 生产缺存储明确失败，开发演示兼容；图片上传接入取消信号。非base64的内联data输入不能绕过生产校验。

## 交叉复查

- 发现旧 stalled 消息可能在用户重新生成后抢到新的 PENDING，补本轮任务身份绑定。
- 发现单尺寸期限仅覆盖模型，不覆盖上传；将上传取消与完整单尺寸预算连接。
- 检查终态后查询、组件卸载和 workspace 切换，防止旧结果覆盖新页面。

## 验证记录

最终源码提交：`8bc050a`。四项门禁均 exit 0，结果如下：

| 门禁 | 实测结果 | 本地证据 |
|---|---|---|
| `pnpm test` 的等价本地 Turbo 执行 | contracts **1718 passed**、UI **34 passed**；2 successful / 2 total | `.novart-build/p3-test-20261016.log` |
| `pnpm test:ai` 的 Windows 等价 venv pytest | **518 passed, 1 warning** | `.novart-build/p3-ai-20261016.log` |
| `pnpm -F web typecheck` | next typegen + tsc --noEmit，exit 0 | `.novart-build/p3-typecheck-20261016.log` |
| `pnpm -F web build` | Compiled successfully，静态/动态路由产物生成，exit 0 | `.novart-build/p3-build-20261016.log` |

L1使用 `node node_modules/turbo/bin/turbo run test --force -- --maxWorkers=1 --minWorkers=1`，禁用缓存且限制并发。AI在 `apps/ai` 执行 `.venv\Scripts\python.exe -m pytest -q`；原shell脚本为Unix路径，Windows直接使用同一venv和pytest。原样关键输出：

```text
@brandai/contracts:test:  Test Files  141 passed (141)
@brandai/contracts:test:       Tests  1718 passed (1718)
@brandai/ui:test:  Test Files  5 passed (5)
@brandai/ui:test:       Tests  34 passed (34)
Tasks:    2 successful, 2 total
518 passed, 1 warning in 5.50s
Generating route types...
✓ Route types generated successfully
✓ Compiled successfully in 9.0s
```

构建使用低内存配置和 `127.0.0.1:1` 合成数据库/队列地址，避免连接共享服务。构建日志中的 ECONNREFUSED 为此隔离设置导致，不能拿这次构建证明实际数据库/Redis连通。Next构建设置跳过内置类型检查，独立typecheck已另行通过。AI警告来自既有Starlette/httpx兼容提示。

真实 Chromium / loopback：

- 共享轮询及实际 TextChecker/GenerateWizard **8/8**：暂停、恢复同一任务、读取失败立即恢复、终态不再查询、切换上下文取消旧读取、202接单、成功结果显示、超时后收费按钮仍锁定。`.novart-build/p3-bounded-poll-browser.json`。
- 自研画布 **52/52**：原有绘制、移动、文本、上传、保存恢复、导出等交互回归。`.novart-build/p3-owned-canvas-browser.json`。
- 品牌素材抽屉 **12/12**：`.novart-build/temporary/brand-materials-browser-FduoUx/report.json`。
- 共 **72** 项浏览器检查，异常及外部请求为0。测试用真实React与浏览器、合成HTTP数据；不是实际 SQL、Redis、S3 或真实模型质量验收。

本机未安装 Playwright 默认headless shell；复跑时明确使用已有 `NOVART_CHROMIUM_EXECUTABLE` 指向本机Chrome，测试通过，没有下载或打开用户浏览器会话。

## 交付与待办边界

- 新迁移只生成文件与 Prisma client，没有执行数据库迁移；将来上线前必须先在隔离数据库验证迁移和真队列流程。
- P1@97ed7fb、P2@940e0fd 独立保留，本分支没有自动包含它们。合并候选需要用户确认，并重新验证组合后的最终版本。
- 本轮没有操作CDS，也没有新的CDS故障证据。不能把本地代码问题说成CDS服务器问题。
- AbortSignal 能停止本进程等待、后续调用和业务写入，不能承诺外部供应商撤销已经接收的模型请求，也不能保证对象存储撤销已经完成的写入；可能的孤儿对象清理仍需后续独立策略。
- 将多尺寸拆成每尺寸独立任务仍按原计划留待后续。


## 本地任务提交

| 任务 | 主要位置 | 本地提交 |
|---|---|---|
| 3.1 默认超时、3.3单次调用协议基础 | `lib/ai.ts`、`lib/ai-service.ts`、AI `main.py/schemas.py`、contracts | badc181 / 05805a4 |
| 3.2 异步预检/复检 | 3个API路由、`compliance-task*`、`precheck.ts`、AsyncTask迁移 | ca39f09 |
| 3.3 旧worker中止与迟到写保护 | `worker-deadline.ts`、`legacy-task-runtime.ts`、6个worker、`asset-mirror.ts` | 4e9a293 |
| 3.4 清扫、进度保护及新worker注册 | `async-tasks.ts`、`workers/index.ts` | 90a3b65 |
| 3.5 多尺寸与本轮任务身份 | `generate.worker.ts`、`generations.ts`、4个生成入口、attemptToken迁移 | 1502787 |
| 3.6 六分钟可恢复轮询与202消费者 | 共享hook、14个UI文件、浏览器脚本 | 8bc050a |
| 3.7 生产缺存储失败、取消上传 | `s3.ts`及回归测试 | e07f3f4 / 9e5812d |

任务间有共享文件依赖，表中以主要责任归组。不得挑单个中间提交当完整发布版本；将来应集成本分支完整候选后重新验收。

升级说明：历史 legacy Generation 队列消息没有 attemptToken，将明确失败并要求用户主动重新提交；新旧消息不会混用。迁移目录 `20261016080000_async_task_compliance_payload`、`20261016080500_generation_attempt_token` 均未执行。旧生成的进程崩溃清扫采用38分钟保守上界，活跃worker看门狗仍按真实尺寸数预算执行。
