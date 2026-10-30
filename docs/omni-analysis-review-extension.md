# Omni 自动分析与图片审核接入约定

日期：2026-10-30。此文档为后续修改 Omni 的接续入口。

## 当前接好了什么

BrandAI 预留 `packages/contracts/src/omni-asset-workflow.ts`，Python 镜像为 `apps/ai/app/omni_asset_workflow_schemas.py`。这是可执行校验的数据契约与纯函数，不是新增 HTTP 接口；尚未接入 Omni 实际记录和发布链路，不会改变线上审核结果。

`evaluateOmniAssetWorkflow(record, currentSource)` 检查记录是否属于当前素材版本、人工审核与用途权限是否具备、是否已撤下，只返回资格与缺口。它不发模型请求、不写数据库、不自动发布。模型成功或建议接受，不能自动填成人工审核通过。

## 不重复建设已有链路

| 用途 | 现有位置 | 后续改造约定 |
|---|---|---|
| Omni 请求 Nova 分析图片 | `apps/web/src/app/api/internal/inspiration-analysis/config/route.ts`、`jobs/route.ts`、`jobs/[jobId]/route.ts`、`jobs/by-request/[requestId]/route.ts` | 沿用服务鉴权、任务队列、稳定 request_id、按原任务查询，模型凭据留在服务端 |
| Omni 分析执行与批处理 | `D:/coding/OmniSignal-ad-workbench/src/omnisignal/workbench/analysis.py`、`nova_analysis.py` | 修改分析策略/批量限制时，不修改分层任务；已有失败和结果不明的任务不自动重发 |
| Omni 审核与新旧结果判断 | `D:/coding/OmniSignal-ad-workbench/src/omnisignal/workbench/review.py`、`store.py` | 由已认证的服务端操作生成审核记录，不信任模型返回或前端提交的审核人、权限、来源字段 |
| Omni 发布 | `D:/coding/OmniSignal-ad-workbench/src/omnisignal/workbench/publishing.py` | AI 建议先保留为建议；沿用真实审核、用途权限和版本绑定，不以模型成功代替发布门槛 |
| Nova 知识副本 | `apps/web/src/lib/inspiration/protocol.ts`、`replica.ts` | 沿用签名知识包、哈希校验、版本切换和撤回；本次未增加第二条推送通道 |

## 扩展数据格式

```ts
{
  schema_version: 1,
  source: { asset_id, revision, sha256 },
  analysis: { status, job_id, model_version },
  ai_review: { status, suggestion, policy_version, job_id },
  human_review: { status, reviewer_id, decided_at },
  permissions: { analysis, display, export },
  publication: "draft" | "published" | "withdrawn"
}
```

- `analysis.status`、`ai_review.status`：`not_requested / queued / running / completed / failed`。
- `ai_review.suggestion`：完成前为 `null`；完成后为 `accept / reject / needs_human`。记录审核策略版本和真实任务 ID，方便复核与追踪变化。
- `human_review.status`：`unknown / pending / approved / rejected`。未知和待审时审核人、时间必须为 `null`；已决策时必须有服务端身份与时间。缺历史数据应填未知。
- 三项 `permissions` 均为 `allowed / denied / unknown`。允许本批 AI 分析不等于允许展示、导出或未来批次分析。
- 图片身份、版本或哈希变化时，旧记录返回 `stale_source`；有拒绝、撤下或权限缺口时，资格检查不通过。
- 人工可以独立完成审核，因此不要求模型成功才能人工通过；反向推导不成立。

这里的 `revision` 必须由接入适配器绑定当前权威记录。Omni 现有审核操作可能递增素材版本，不得把递增前的任务版本直接当作新审核版本，也不得只替换一个 revision 就假装旧建议仍然有效。需复用 `fresh_review` / `completed_source_job` 等检查，并核实人工确认是否覆盖当前图片及修改内容。

当前契约不读取任何外部 URL、不含文件内容、密钥、账户配置或计费额度。调用方身份和 workspace 隔离仍由原服务端鉴权负责，资格检查本身不能替代它们。

## 下一次接着做的顺序

1. 在 Omni 独立工作区盘点分析任务、失败类型、重复提交、版本过期和审核记录，先保留现有未提交改动。
2. 明确自动审核的对象：广告相关性、图片质量、设计分析完整度分别是什么；输出需要具体依据，避免一个综合分数决定一切。
3. 实现从 Omni 权威数据到上述契约的适配器，并用当前真实记录核实新旧版本关系。没有证据的字段填未知，不补造。
4. 新自动审核先生成建议；若以后要增加策略自动放行，需要单独设计 `policy approval`、审计和发布条件，不能冒充 `human_review.approved`。
5. 验证批量任务取消、额度、限流、失败回执、重复点击、来源图片更新、人工覆盖、撤回；随后才接知识包发布。

本轮未改 Omni 的计划任务、额度、模型、权限或审核程序；它的既有脏工作区保持原状。后续在 `D:/coding/OmniSignal-ad-workbench` 单独推进，不与 `claude/layer-quality` 混合提交。
