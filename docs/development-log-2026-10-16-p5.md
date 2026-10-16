# 2026-10-16 P5 工程质量开发日志

## 范围

独立本地分支 chore/p5-engineering，基线 devUpdate1012@2cf3932，工作区 brandai-p5-engineering。未推送、未部署、未合并 main/dev，未读取真实配置/密钥，未启动 Docker。本分支不包含 P1–P4 的独立修改。

## 已实现

- ESLint 精确版本、flat config、React Hooks 两规则 error，CI纳入lint，移除Next跳过lint。修error，不全仓禁用规则。
- Web 自己运行 Vitest，原 contracts 中109个依赖 Web 的测试按22/22/22/22/21分批迁移；保留断言及真实固定样本。迁移中修正别名与相对引用解析到同一模块后的重复mock自引用。
- Pydantic textMode/mode/source/op 与 Zod Literal 镜像，RecognizeRequest.assets非空；source省略允许、null拒绝。
- 新增6个安全workspace外键与7个索引；只读SQL统计26个表的孤儿和6条跨品牌关联。迁移发现脏数据直接失败回滚，不擅自改数据。
- README历史原始字节完整归档到 docs/worklog/README-history-through-2026-10-15.md。根README仅留使用说明。progress/task_plan/findings迁入docs/worklog，AGENTS/CLAUDE引用同步。
- 根test实际不是空文件，而是6字节test加换行；原件迁到docs/worklog/test-root-original.txt，避免丢弃用户记录。

## 数据库验证与例外

已在外置PGlite内存PostgreSQL WASM引擎重放41个历史迁移与候选迁移，58项断言通过。正常合成fixture的26张表孤儿为0；故意注入Membership/StudioGeneratedMaterial孤儿各1可被审计检出。错品牌引用拒绝迁移；失败事务不会留下部分外键；删除品牌A后品牌B完整。

真实目标数据库的孤儿行数量：**未测**。未连接共享库，没有native PostgreSQL或Prisma migrate执行验收。此结果不等于可直接执行生产迁移。

保留软引用的理由：

- AsyncTask和StudioMaterialUpload：保留对象键与过期清理收据；级联删除task会丢掉上传清理依据。
- StudioDecompositionRequest：保留对象键、图层发布与已付费处理收据。
- UsageLog：保留费用审计。
- StudioBrandCreation：维持已有nullable FK/SET NULL墓碑。
- ProjectCanvas、EditorDocument、WorkbenchProjectState已有Project级联，本次未补直接workspace外键；WorkbenchKnowledgeImport幂等收据软引用不改。

后续可用nullable FK + originalWorkspaceId快照或独立cleanup表解决清理类表的约束；这轮不扩大重构。新增单列FK只保证workspace存在，不替代业务同租户校验；不可称全量FK或租户复合约束已齐。

可重跑SQL验证（外置测试依赖不进入产品）：

```powershell
node --wasm-num-compilation-tasks=1 --liftoff-only --no-wasm-tier-up scripts/test-p5-workspace-fk.mjs D:/coding/.codex-scratch/p5-postgres/node_modules/@electric-sql/pglite/dist/index.js
```

## 验证

- 定向Python契约29项通过。
- Prisma validate/generate通过。
- SQL58断言通过。
- Hooks修复前后画布Chromium各52项通过（loopback合成API，非真实生成验收）。
- 最终全量 L1：Web 1327、contracts 287、UI 34 项通过；109 个测试文件迁移证据确认全部原断言保留，7 个文件仅补齐 mock 解析适配。
- 全量 AI pytest 529 项通过（1 条 warning），使用现有本地测试解释器，不调用真实模型。
- Web typecheck、生产 build 均 exit 0；独立 lint 为 0 errors、12 warnings，构建已实际执行 lint，不再跳过。
- 报告位于本工作区 `.novart-build/p5-{test,ai,typecheck,build}-20261016.log`、`p5-eslint-final.log`、`p5-test-migration-proof.json`。

## 集成与发布边界

P5与P3均修改schemas.py/schema.prisma，后续合并必须保留P3任务持久化字段/attemptToken；P4新增Web测试也要迁入新的Web测试套件。P4路由移动与P5的hook/import修复需要集成复核。独立分支验证不能冒充五阶段集成验收。共享迁移及发布仍需原计划对应审批，本轮保持本地。

## 本地验证资源问题

并行门禁一度耗尽系统虚拟内存；已停止自己的挂起测试进程，改为单worker串行。PGlite采用单WASM编译线程低内存参数后通过。没有改系统内存设置，也未终止用户应用。这是本机验证资源问题，本轮没有新的CDS线上故障取证。
