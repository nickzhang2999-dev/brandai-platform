# PR: V0.0.8 修复工作台素材 100% 调用链路

## 变更内容

- `ReferenceImage` 新增 `mode` 字段，用于区分 `STRICT` 与 `INSPIRATION`。
- 工作台选择「必须 100% 调用」的素材后，worker 会把 `mode: STRICT` 写入 AI 约束。
- AI 服务识别 `STRICT` 后，改走 `provider.edit()` 图像输入链路。
- STRICT 生成版本写入 `generationPath: strict_image_input` 与 `strictReferencePolicy`，便于后续追溯。
- Web API 与 AI 服务均限制当前每次生成最多 1 张 STRICT 素材。
- 工作台切换参考素材调用方式时，同步更新本地 reference tray。
- 版本号更新为 `0.0.8`。

## 当前限制

- V0.0.8 仅支持 1 张 STRICT 主素材。
- 多张必须保真素材需要后续设计画布合成、多图编辑或坐标约束能力。
- 服务端 ProjectAsset 关系暂未持久化 STRICT / INSPIRATION mode，跨设备恢复仍需后续补字段。

## 验证

- 已通过：`git diff --check`。
- 已通过：`apps/ai/.venv/bin/python -m pytest tests/test_ai_constraints.py -q`，8 passed。
- 已通过：`pnpm test`。
- 已通过：`pnpm test:ai`，99 passed。
- 已通过：`pnpm -F web typecheck`。
- 已通过：`pnpm -F web build`。
  - 构建过程中仍出现既有 `url.parse()` deprecation 与静态收集阶段 `ECONNREFUSED` 警告，但命令退出码为 0，生产构建完成。

## 风险与说明

- `STRICT` 现在会真实进入图像输入链路，但最终视觉保真程度仍受底层 provider 的编辑能力影响。
- 如果 provider 的 `/images/edits` 不可用，请求会失败，不再静默退回纯文生图。
