# 灵感库每日有效新增图片接收合同

本合同按“接收端首次成功入库、当时可浏览、公司范围内 SHA256 去重的新图片”计量。下载尝试、AI 分析完成、发布包生成和案例条数均不算接收成功。当前实现不代表已在预览或正式环境启用，也不证明每日目标已经达到。

## 作用范围与启用

需要先通过正常发布流程应用 `20261105160000_inspiration_daily_receipts` 数据库迁移。上线不会自动开启计量或改变既有接收方式。

配置项：

| 配置 | 用途 |
| --- | --- |
| `INSPIRATION_DAILY_RECEIPTS_ENABLED=true` | 启用指定公司的计量及日接收额度；缺省关闭 |
| `INSPIRATION_RECEIPT_OWNER_ID` | 固定公司所有者 ID；其他所有者的接收不受这项额度限制 |
| `INSPIRATION_RECEIPT_TOKEN_SHA256` | 新生成的独立只读 token 的 SHA256，小写 64 位十六进制；不得复用分析或发布 token |

Web 和 Worker 必须使用相同的启用开关与 owner 绑定；只读 token 的 SHA256 供 Web 接口鉴权。调用者将新 token 原值通过 `Authorization: Bearer ...` 提交，接收端做 SHA256 恒定时间比较。凭据原值只存部署秘密配置，不写入代码、本文或报告。该 token 只能读取绑定 owner 的日报和已接收 hash，不能初始化策略、升档、导入或发布素材。

按以下顺序启用：迁移 → 用正常管理员会话初始化 → 配置双方独立只读凭据与 owner → 开启指定公司的日额度。发布端确认 preflight 返回 `enabled=true`、`initialized=true` 后，才按剩余额度发包。

## 基线与正常管理接口

使用原管理员账号登录产品，通过正常管理 API 调用：

```http
POST /api/admin/inspiration/daily-policy
Content-Type: application/json

{"action":"initialize","ownerId":"<公司所有者ID>"}
```

初始化在公司事务锁内将已有库的图片 hash 记录为 baseline。旧素材没有已验证的首次接收日期，所以不补写历史成功数，也不计入启用当天的新增。重复初始化不会重置目标或清除回执。曾在计量关闭期间导入的未登记图片，会在下一次启用导入前加入 baseline，避免冒充当天新增。

初始目标固定为 100。策略持久保存首次初始化时间与北京时间日期。质量评估由操作者对已结束日期的实际结果确认，可以是抽样评估，不要求每图重新人工审核：

```http
POST /api/admin/inspiration/daily-policy
Content-Type: application/json

{"action":"promote","ownerId":"<公司所有者ID>","qualityDay":"<已结束的北京时间日期>","qualityEvidence":"<至少10字的真实质量评估依据，记录抽样范围、结论与缺口>"}
```

只有该日实际接收数达到当前目标、日期不早于启动日、且未复用上一阶段的审核日期，才允许从 100 升至 200，再从 200 升至 300。未确认的质量状态不能自动通过；不得用空白、虚构评估或 AI 调用成功替代质量依据。

## 发布端查询与预检

`GET /api/internal/inspiration-receipts/daily?day=YYYY-MM-DD` 返回绑定公司的日报。省略日期表示当前北京时间日期。

`POST /api/internal/inspiration-receipts/preflight` 接受：

```json
{"sha256":["<小写64位图片SHA256>"]}
```

最多 1000 项，重复 hash 按一张计。响应包含 `day`、`target`、`received`、`remaining`、`known_sha256`、`new_unique_images`、`fits`，以及 `receipt_revision`、`baseline_revision`。日报与 known hash 来自同一个 RepeatableRead 数据库快照。revision 随永久回执或基线增长而变化，可用于发布端缓存失效判断。

preflight 是只读建议，**不预留额度**。发布端必须从 remaining 中扣除自己已经签名发布、尚未被确认接收的包所占的新 hash 额度，避免连续发包超额。建议按较小的新图片增量签完整包；整包已有 hash 的正常内容修订不重复占额。接收成功只以 B 端持久回执为准。

正常登录用户可通过 `GET /api/workspaces/{wsId}/inspiration/daily-receipts` 查看所属公司的聚合日报；接口需要该品牌 VIEWER 权限，不返回完整 hash 清单。

## 原子性、配额失败与撤回

图片、案例记录、版本切换及新增回执在一个事务中提交；公司 owner 锁串行处理跨库并发。失败不计数，重放同一包也不重复计数。整包新 hash 数超过当前剩额时，整个包回滚，原有库与原版本保留，绝不截断签名包。

现有任务 contract 仍使用 `FAILED`，安全错误码为 `DAILY_IMAGE_LIMIT`。前端明确显示是今日剩余额度不足，不再误导为发布连接故障。手动模式提示“北京时间次日可再接收”；自动模式提示“北京时间次日系统会自动再次检查”。配额按北京时间午夜重置，明日可原样重新接收未入库的合法包。**若一个包的新增量大于完整日目标，等到明日也无法容纳，发布端必须重新构造更小的完整签名发布包。**

撤回检查仍走独立通道，不受新增额度阻塞。已成功接收后又被撤回的图片不从“首次接收数”中扣除；指标不表示当前全部仍可见。`human_reviewed` 保持 null，明确人工审核数未知。

本次不修改 Worker 调度：自动模式超额时仍可能按既有周期再次下载、校验并回滚同一个包。正确的发布端 preflight 和未接收包预算是当前避免重复开销的措施；接收端下载前的持久延期检查尚未实现。

## 日报限制和验收边界

首次启用前的日期返回 409，说明历史接收数未知。历史日期的目标尚未逐日归档，返回 `target=null`、`remaining=null`，不把当前档位套到历史日报。停止计量期间不能据此声称完整连续的业务日报。

本机隔离 PostgreSQL 已验证全量迁移、旧素材 baseline、跨库去重、并发竞争最后额度、整包回滚、跨日再次接收及其他 owner 不受影响。真实接收量、质量、成本和站点使用依据仍须在部署后的业务运行中核验，不能用这些工程测试替代。
