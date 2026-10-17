# 2026-10-17 集成版本推送前检查

## 结论

**首次检查阻断已按用户明确授权处理，等待推送验收。** 交接基线为 `integration/devupdate-opt@21eb6a5979e44ef47572e6c9102978c7be107f1c`。下文 A/B/C 保留首次检查原始结果；后续修复见本节更新。

用户确认“可以的，按你说的做”后，已备份并精确删除独立库中唯一的孤立 Membership。备份在 Git 忽略目录，Windows ACL 仅允许当前用户访问；写入后读取校验一致，SHA-256 为 `726ee10e652af468b07e4488fb471586e68bf2b92dcbd5efa62341467343b03d`。原始记录和标识不进入 Git 或公开报告。

事务内核对库名、唯一记录指纹及26表依赖；以短期表锁防止检查与删除之间产生新关联。精确删除影响行数为1，复核26表孤儿计数全部0、6项跨品牌计数全部0，用户和现存品牌数量不变。事务成功提交。未更改main共享库、密钥、CDS配置或迁移脚本，未执行migrate resolve。

## 实测环境

- 使用已批准的 CDS 项目凭据及官方 CLI 请求函数，通过当前运行的 devUpdate1012 Web 容器执行 SQL。
- 实际 `current_database()` 为 `brandai_devupdate1012`，`transaction_read_only=on`；所有审计在同一 Repeatable Read 只读事务内。
- 没有连接或修改 main 共享库；未读取私密账号目录。报告仅记录计数、版本和布尔值，不含账号、连接串、密钥或孤儿记录标识。
- CDS 当前部署提交为 `83a5dca`，Web/Worker/AI 均 running。
- 实际 CDS 返回的预览地址：<https://devupdate1012-brandai-platform.geole.me>。它当前仍是旧版，不是本次集成版本。

## A：孤儿记录计数（原样）

| table_name | orphan_count |
|---|---:|
| Asset | 0 |
| AssetFolder | 0 |
| AsyncTask | 0 |
| BrandRule | 0 |
| ComplianceTerm | 0 |
| EditorDocument | 0 |
| Generation | 0 |
| Membership | 1 |
| ProhibitionRule | 0 |
| Project | 0 |
| ProjectCanvas | 0 |
| RuleSnapshot | 0 |
| StudioBrandCreation | 0 |
| StudioBrandMaterialReceipt | 0 |
| StudioConversation | 0 |
| StudioDecompositionRequest | 0 |
| StudioGeneratedMaterial | 0 |
| StudioGenerationOutput | 0 |
| StudioGenerationRequest | 0 |
| StudioMaterialUpload | 0 |
| UsageLog | 0 |
| WatermarkPreset | 0 |
| WorkbenchBrandDraft | 0 |
| WorkbenchKnowledgeImport | 0 |
| WorkbenchProjectState | 0 |
| WorkbenchUserState | 0 |

| relation_name | mismatch_count |
|---|---:|
| Generation.projectId | 0 |
| StudioBrandMaterialReceipt.assetId | 0 |
| StudioGeneratedMaterial.outputId | 0 |
| StudioGeneratedMaterial.requestId | 0 |
| StudioGenerationOutput.requestId | 0 |
| StudioGenerationRequest.generationId | 0 |

判定：**不通过**。Membership 是本次新增外键的六张表之一。当前只证明引用的品牌不存在，尚未确认该条记录的业务来源，不据此直接判定可删除。

## B：启动密钥

在运行中的 Web 和 Worker 容器内检查实际 AUTH_SECRET，只返回布尔值，采用与启动守卫一致的 trim 后长度检查。

| 服务 | 长度 ≥32 | 非示例占位值 |
|---|---|---|
| Web | 是 | 是 |
| Worker | 是 | 是 |

容器没有提供可直接比较的 CDS_JWT_SECRET，因此没有宣称核实平台存储原值；已核实实际注入应用、供启动守卫使用的 AUTH_SECRET。未更换任何密钥或 SETTINGS_ENC_KEY。

## C：Git 与本地检查

- 已正常安装/运行推送检查，`cds-pre-push --check-head` exit 0。
- 已 fetch 目标远端：`origin/devUpdate1012=83a5dcac58bec45e6051d7e2ab1cf952678f3e7d`，是当前 HEAD 的祖先，快进检查 exit 0。
- 本轮重新执行：Web 1596、contracts 293、UI 34 项通过；AI pytest 547 项通过（1 warning）；Web typecheck 通过；ESLint 0 errors、14 warnings。
- `pnpm -F web build:low-memory` 生产构建 exit 0；使用 loopback 合成连接参数，不连接真实数据库、Redis 或模型。
- 没有 push，因此远端提交没有被本轮改变；没有新 CI、CDS 部署、迁移完成记录或新版页面验收结果。

## 下一步

### 补充只读定位（2026-10-17）

独立库事务再次确认只读。孤儿成员关系创建于2026-07-18，角色OWNER；用户仍存在，有19条其他有效品牌成员关系，并拥有19个现存品牌。缺失品牌在其余25张带workspaceId的表中引用计数全部为0，包括素材、项目、画布文档、生成任务、对话和用量记录。Membership运行时仅有指向User的外键，没有指向BrandWorkspace的外键，也没有其他表指向Membership的外键。

这符合历史孤立成员关系的特征，但没有历史删除审计，不能断言具体由哪次操作造成。源码现有品牌删除入口只删除BrandWorkspace；缺少数据库级关联约束使残留关系成为可能。新迁移的ON DELETE CASCADE将约束后续品牌删除行为。

### 建议处置（尚未执行，需用户确认数据库写入）

1. 只针对brandai_devupdate1012：重新核对当前库、孤儿数仍为1、关联表仍全部无数据，以及记录指纹与本次只读报告一致；任何不一致即停止。
2. 将这一条原始记录保存到Git忽略的本地受限备份文件，校验文件可读及SHA-256；原始标识不输出到对话、不进入Git。备份失败不进入写步骤。
3. 在事务中锁定该Membership行，按原记录完整字段精确匹配，重新确认目标品牌不存在，只删除这一条。删除影响行数必须恰好为1；否则回滚。事务内重新审计后提交。
4. 保留账号、其他成员关系及全部现存品牌；不访问main共享库、不调整密钥、不关闭外键约束。复跑26表孤儿审计与6项跨品牌检查。
5. 若在新外键迁移前需要撤销，可按备份与不存在重复键的检查恢复原记录，但会重新引入发布阻断；新外键生效后不能盲目恢复孤儿，需先确认合法品牌归属。绝不为回滚禁用约束或补造品牌。

上述方案在首次记录时未执行；之后用户明确批准，备份与清理已执行，结果见报告开头。迁移留待正常部署执行。

阻断解除后需要重新审计、重新 fetch 检查远端，再正常推送；不得沿用已经过时的计数直接发布。

本地脱敏证据：`.novart-build/handoff-{status,audit,auth}-20261017.json`；重新执行的检查日志：`.novart-build/integration-{test,ai,typecheck,lint,build}-20261017.log`。
