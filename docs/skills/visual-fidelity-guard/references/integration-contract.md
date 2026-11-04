# 产品接入约定

此文件是接入设计，不声明任何字段/API 已在产品中实现。保留宿主的队列、权限、模型配置和工具约束；不要为启用 Skill 新建影子账号、复制密钥或直接修改生产数据库。

## 执行位置

建议串联为：

`需求与有效规则 → 约束清单 → 能力检查/路线选择 → 生成任务 → 输出固化 → 对象级核验 → 结果展示 → 已授权的修复或交付`

将耗时生成和视觉核验放在宿主后台任务里。HTTP 只接受任务并返回 ID，前端显示后台状态；离开页面不丢任务。接收任务、模型完成、视觉检查完成、用户接受/发布是独立状态。

Skill 指导 Agent 如何决策，程序负责保存证据、执行工具、限制重试和判定状态。程序不能只把本文件全文拼到生图提示词里，就认为已实现蒙版保护与核验。

## 建议数据结构

实现时以产品已有契约为准；需要新增字段才迁移。以下是契约示意，不包含真实素材：

```json
{
  "contract_version": "visual-fidelity-guard/1",
  "task_id": "task-example",
  "constraint_revision": 1,
  "inputs": [{"asset_id": "source-example", "sha256": "<actual-input-sha256>"}],
  "constraints": [
    {
      "id": "c-subject-color",
      "object_id": "subject-left",
      "attribute": "surface_color",
      "operation": "preserve",
      "scope": "object",
      "expected": "原图绿色表皮，允许合理光照差异",
      "strength": "hard",
      "source": {"kind": "user_request", "ref": "request-example"},
      "required_evidence": "same-object-region-visual-comparison"
    },
    {
      "id": "c-background",
      "object_id": "background",
      "attribute": "color",
      "operation": "change",
      "scope": "region",
      "expected": "使用已启用品牌规则指定的背景色",
      "strength": "hard",
      "source": {"kind": "enabled_brand_rule", "ref": "rule-example", "revision": 2},
      "required_evidence": "background-region-comparison"
    }
  ],
  "execution": {
    "strategy": "masked-background-edit",
    "mask_asset_id": null,
    "mask_sha256": null,
    "mask_coordinate_space": null,
    "mask_editable_value": null,
    "provider_task_id": null,
    "submitted_constraint_ids": [],
    "attempts_used": 0,
    "max_attempts_authorized": null
  },
  "output": null,
  "checks": [],
  "overall": "pending"
}
```

`null` 表示未执行/未知，不是已验证。`max_attempts_authorized` 必须来自当前用户授权与预算，不能从示例推导默认执行权限；明确的本次单次生成请求可记为 1，纯方案请求不能自行补为 1。真实 mask 执行需记录范围语义、宽高、坐标/变换和已提交回执；实际没有 mask 时不能记录 `mask-enforced`。策略是计划字段，不是执行证明。

输出至少有 asset_id、sha256、width、height；若核验经过缩略图/裁剪，还要记录核验输入与完整输出的关系。精细文字只检查缩略图时，原图文字准确性仍可能未知。

每条检查至少记录：

```json
{
  "constraint_id": "c-subject-color",
  "output_sha256": "<actual-output-sha256>",
  "status": "unknown",
  "method": "visual-model",
  "reviewer_kind": "ai",
  "region_ref": null,
  "observation": "尚未定位目标主体，无法据整图色板判断表皮颜色",
  "evidence_refs": [],
  "limitations": ["目标区域未确定"]
}
```

区域引用可为像素/归一化 bbox、mask、或可复核的视觉定位描述；保存其坐标系。缺少语义分割不必阻断可清晰判断的直接视觉审核，但不能假装做过像素保护验证。

## 程序应执行的汇总规则

以服务端保存的完整约束清单为输入，不能让审核模型删掉难满足的条件。

1. 校验任务权限、输入/输出哈希与规则版本；过期检查不能用于当前输出。
2. 未知 constraint_id、缺失硬约束检查、互相矛盾的重复检查、无有效证据或证据方法不适配，都进入待核验；不要取最后一个 `pass` 覆盖失败。
3. 任一**有效**硬约束检查为 fail，整体不通过；否则有硬约束未核验则待核验；全部硬约束有适配证据且 pass 才通过。
4. 软约束独立警告，不静默升级成用户没要求的硬约束。没有适用硬约束时显示“未设置硬约束”，不要用空列表得出“品牌规范已通过”。
5. 配色抽样不能满足对象身份、对象本色、文字准确性等不同类型的 required_evidence。视觉模型也不能单独证明文件哈希或像素完全一致。

`model_generated`、`ai_checked`、`human_checked`、`accepted`、`published` 分开保存。不要依靠前端单个绿色勾号覆盖这些含义。

## 前端与后端分工

前端在发送前清楚展示“保留主体哪些属性 / 允许修改哪里 / 使用哪些品牌规则”；冲突就地解释，不要求用户反复填写已有信息。完成后显示本次具体偏离、证据类型及未知原因。

后端固化本次快照与真实提交回执，按可用能力派发工具，执行对象级检查和汇总规则。修复沿用原任务关联，生成新尝试 ID；网络超时查询原任务，不自动创建重复任务。

当用户授权自动修复时，次数、费用和期限由服务端共同限制；费用预算包含生成、修复和新增付费视觉审核。超过预算、连续同一问题、主体定位不确定或证据冲突，返回明确终态。提示词不能替代程序预算控制。

## DeepFlare 接入检查点

先核对当前分支实现，以下仅为本次编写时的定位线索，不是未来版本的事实保证：

- `getConfirmedRules`：只取适用的已启用规则，并保留实际本次快照。
- `generate.worker.ts`：在实际生成前构建约束，输出保存后进入核验；与已有模型/队列共用正常配置。
- `brand-colour-fidelity.ts`：目前全图配色抽样只能当辅助信号，不能直接充当主体属性检查。
- `studio-brand-rule-receipt.ts`：区分规则被传入和结果符合；历史证据不足显示未知。
- 图像工具路线：检查是否有真实 mask、保护区及变换信息；没有就明确降级。

完成接入须用真实输入/输出验证一例保留主体、一例允许改色、一例确定失败和一例未知。前后端契约测试、队列状态、失败展示和授权预算一起核对。模拟测试只能证明逻辑，不能证明模型能保留主体。
