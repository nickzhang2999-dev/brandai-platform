# PR: V0.0.11 编辑图片后应用水印规则

## Summary

- 补齐 AI 工作台二次编辑链路的水印叠加。
- 编辑图片时，如果用户当前选择了素材水印，最终编辑结果会按规则确定性合成水印。
- 编辑后的 `GenerationVersion.params` 会记录水印配置和实际应用的素材 ID。

## Key Changes

- `EditVersionInput` 新增 `watermarkOverlays`。
- 工作台 `runEdit()` 提交编辑任务时携带当前水印配置。
- `edit.worker.ts` 在 AI edit 返回底图后调用 `applyWatermarksToImage()`。
- 合成后的最终图再上传、落库、镜像为 `GENERATED`。
- 工程版本同步为 `0.0.11`。

## Test Plan

- `pnpm test`
- `pnpm test:ai`
- `pnpm -F web typecheck`
- `pnpm -F web build`

## Acceptance

- 选择素材水印后，普通生成结果带水印。
- 对已有图进行换背景、局部重画、改文字、加元素等编辑后，编辑子版本也带水印。
- 编辑版本参数中记录 `watermarkOverlays` 和 `appliedWatermarkAssetIds`。
- 无效素材不会被静默忽略。
