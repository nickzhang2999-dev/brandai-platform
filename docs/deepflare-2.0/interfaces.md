# 2.0 接口合同 v1

代码事实源：`packages/contracts/src/deepflare-v2.ts` 与 `apps/ai/app/deepflare_v2_schemas.py`。协议修改两边同步，共享 fixtures 也要同步。

## 开关与 HTTP

默认关闭。仅在独立开发环境设 `DEEPFLARE_V2_ENABLED=1`，`DEEPFLARE_V2_WORKSPACE_IDS=品牌ID1,品牌ID2`。不支持 *。权限来自当前登录用户，不接受客户端指定 userId。写操作校验同源，JSON 最大 64 KiB。所有响应 no-store。

基路径：`/api/workspaces/{wsId}/projects/{projectId}/v2/work-orders`。

| 操作 | 请求 | 结果 |
|---|---|---|
| POST 基路径 | CreateInput | 201，创建/幂等返回工作单 |
| GET /{workOrderId} | 无 | 200，最新服务端状态 |
| PATCH /{workOrderId} | CommandInput | 200，操作回执；确认后事务保存待执行记录 |
| 已关闭、跨范围或不存在 | — | 404 |
| 权限不足、过期 revision/planVersion、格式错误 | — | 403 / 409 / 422 |

每次用户操作生成新的 mutationId（UUID），网络重试复用同一个；不能每次自动重试换 UUID。相同 mutationId 不允许变更 payload。

创建示例：
```json
{
  "mutationId": "11111111-1111-4111-8111-111111111111",
  "brief": {
    "text": "香氛上新，主视觉和一个竖版稿",
    "mode": "DIRECTION_FIRST",
    "deliverables": [
      {"id":"main","channel":"主视觉","width":1024,"height":1024},
      {"id":"vertical","channel":"竖版","width":1024,"height":1536}
    ],
    "inspiration": []
  }
}
```

PATCH 支持 SET_DIRECTION、REVISE_BRIEF、SUBMIT、CONFIRM_DIRECTION、REQUEST_REVISION、CANCEL。方向内容是 summary/composition；例：
```json
{
  "mutationId": "22222222-2222-4222-8222-222222222222",
  "expectedRevision": 3,
  "command": {"type":"CONFIRM_DIRECTION","planVersion":2}
}
```

返回 id、workspaceId、projectId、state、`executionAvailable:false`。前端不能据此展示“AI 正在出图”。READY 后本批禁止修改/取消，避免改写交给未来执行器的批准快照；S2 需在引入真实消费者之前补在途取消语义。

## Ommi 消费边界

不假定对方 REST 路径、不传内部数据库结构、不复制其代码。适配器位于 `ports.ts::OmmiPort`：

- 输入：认证得到的 workspaceId/projectId/userId、指定 caseId/sourceVersion/insightIds/application、AbortSignal。
- 输出：逐条解析的 reference、授权 scope、原始出处、实际借鉴文字、contentHash、checkedAt、permittedUse=TEXT_REFERENCE。
- 必须检查来源身份、当前权限、明确版本与有效状态；缺失/版本变化/撤回不允许静默换成别的案例。
- 首批只采用授权文字借鉴点；图片使用权与商品保真素材沿现有素材系统，不因有参考 URL 就直接拉图。
- 草稿中的引用仅是未验证指针；“已经采用”须由 worker 从实际发送内容写回回执。每次付费步骤之前重新校验。
- 网络超时、未连接与无权限必须区分；不可返回空列表假装所有引用已解析。

当前 `disconnectedOmmi` 仅对明确空引用返回 []，非空一律报未接入。O-01 需与 Ommi 负责人确认身份映射、权限撤回、版本格式、幂等和超时协议。

## 记忆宫殿消费边界

`DesignMemoryPort.readConfirmed`：当前项目作用域 + 指定岗位需要的 kind；输出已确认记忆及其版本、来源稿件版本。未授权跨项目数据不在合同里。

`propose`：从人工审稿反馈提出候选，返回 CANDIDATE。不包含自动确认/扩大范围操作；M-02 单独实现带角色、版本校验的确认与撤回。严禁把模型提炼内容直接变成品牌硬规则。

## 执行器消费边界

`DesignEmployeePort.execute` 输入必须包含批准的计划快照、具体 task、认证 scope、稳定 idempotencyKey、deadlineAt 和 AbortSignal；返回现有任务 receiptId，随后恢复同一任务。

接入者须实施：先验证 approvedPlanVersion，再核对引用与成员权限，领取单步，再调用现有 Studio/文案服务。重复派发使用同一任务键；结果不明不重新发起付费调用。最终完成的证据必须来自现有生成记录/素材版本。当前适配器只明确返回未接入错误，不能当运行中的 harness。
