# PR: V0.0.9 图片三分法与水印确定性叠加

## Summary

- 新增 `Asset.libraryKind`，将平台图片统一为素材库、模板库、生成图三类。
- 左侧导航新增「生成图」入口，页面独立展示 `libraryKind=GENERATED`。
- 新增 `WatermarkPreset` 和水印配置 API，AI 工作台支持白紫风格的 LOGO 与水印配置弹窗。
- 将素材库「必须出现」从模型语义复现改为 worker 端 `sharp` 确定性叠加。
- 模板库升级为参考图库，只作为 AI 风格、色系、比例、构图参考。

## Key Changes

- `MATERIAL`：素材库默认列表、上传素材、工作台水印叠加。
- `TEMPLATE`：模板库参考图、工作台 inspiration。
- `GENERATED`：生成图镜像，进入独立「生成图」页面，不混入素材库默认列表。
- 旧 `STRICT` 兼容映射为默认水印，旧 `INSPIRATION` 兼容映射为模板参考。

## Tests

- `pnpm test`
- `pnpm test:ai`
- `pnpm --filter @brandai/contracts test`
- `pnpm -F web typecheck`
- `pnpm -F web build`
- `pnpm -F web exec tsx -e "<applyWatermarksToImage smoke>"`：断言输出为 PNG、内容变化且返回 `appliedAssetIds=["logo-1"]`

## Visual Acceptance

已按 `/create-visual-test-to-kb` 读取验收规范。本机缺少 Docker/Postgres/Redis，无法启动完整 localhost UI 栈做浏览器截图归档；且不能用 mock provider 冒充真出图证据。

后续在 CDS 预览或具备数据库/Redis/对象存储的环境中补跑：

- 素材库只显示 `MATERIAL`。
- 模板库只显示 `TEMPLATE`。
- 左侧导航显示「生成图」，页面只显示 `GENERATED`。
- AI 工作台水印配置弹窗可打开、拖拽、保存。
- 生成结果中 `MATERIAL` 素材以水印方式真实出现。
