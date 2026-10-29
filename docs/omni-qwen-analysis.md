# Omni 千问视觉分析配置

更新：2026-10-27。适用于 Omni 专用服务接口，不更改 Nova 全局模型。

## 生效配置

- `OMNI_ANALYSIS_PROVIDER=fal-openrouter`：复用后台现有 layer 的 fal 服务端密钥。
- `OMNI_ANALYSIS_MODEL=qwen/qwen3-vl-30b-a3b-instruct`：仅覆盖 Omni 灵感分析。
- `OMNI_ANALYSIS_DAILY_LIMIT=unlimited`：取消本服务每日次数限制；配置接口 `daily_limit` 返回必填的 `null`。

fal 地址固定为 `https://fal.run/openrouter/router/openai/v1`，使用 Key 鉴权，不接受客户端覆盖地址，不把 VLM 密钥发送给 fal，不改后台 AppSetting。模型或 fal 配置无效时停止接单，不回退 GPT。

未设置 provider 时保留原 VLM 通道；可独立设置模型 ID。每日限制为缺省、非法值或 0 时仍关闭；整数仍按日限制。使用 unlimited 不取消队列上限、身份验证、素材权限、幂等、超时和人工审核。A 端也需设置 `OMNISIGNAL_WORKBENCH_MODEL_DAILY_REQUEST_LIMIT=unlimited`。

## 现有 API 盘点及验收

当前产品 VLM 网关的模型目录未包含千问。现有 fal 配置提供 Qwen 图片分层能力，该图片编辑接口不直接用于设计分析；通过同一 fal 账户的 OpenRouter Vision 通道，可使用 Qwen3-VL 图文理解。

2026-10-27 单次自有合成图实测：所选模型 HTTP 200，读出图中文字、红绿颜色，八项设计字段满足严格 JSON 契约；未借用第三方素材或改其授权。此项是提供方能力验证，完整 Omni → Nova → fal → Omni 的部署后验收另记工作日志。

计费经 fal 账户；OpenRouter 公开单价和百炼单价不能直接作为公司实际账单。批量是逐张异步排队，不代表供应商异步 Batch 折扣。无限次数不代表无限余额。

## 验证与回退

代码门禁：L1 2397、AI 678，web 类型检查和生产构建通过；发布协议检查与 6 项发布脚本测试通过。Omni 分析专项 84 项包含空配置、无效模型、独立凭据、fal Key 鉴权和 unlimited 边界。

按同提交 CI、Branch Image 和 CDS prebuilt 流程发布；实际环境变量、运行提交与真实链路须在上线后核验。回退时恢复本次三个服务环境变量及旧镜像；不要更改 Nova 全局模型设置或回滚业务数据库。

参考：[fal Vision](https://fal.ai/models/openrouter/router/vision)、[fal API](https://fal.ai/models/openrouter/router/vision/api)。
