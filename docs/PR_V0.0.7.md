# PR: V0.0.7 素材标签与工作台素材调用方式

## 变更内容

- 素材库新增人工标签字段 `Asset.tags`，与 AI 自动标签 `aiTags` 分离。
- 素材库支持单个素材编辑标签。
- 素材库支持多选素材并批量追加、移除、覆盖标签。
- 素材搜索范围扩展到人工标签。
- AI 工作台右侧参考素材区新增“选择素材”入口。
- 工作台支持从素材库直接选择一个或多个图片素材。
- 工作台素材调用方式新增：
  - `STRICT`：必须 100% 调用，仅允许尺寸、比例、摆放和颜色处理。
  - `INSPIRATION`：仿制借鉴，允许改写和再创作。
- 生成请求新增 `referenceAssets`，并兼容旧 `referenceAssetIds`。
- 生成 worker 会根据调用方式追加不同提示，并在版本参数中记录调用方式。

## 数据库变更

- 新增 `Asset.tags String[] @default([])`。
- 新增迁移：`20260705000000_asset_manual_tags`。

## 验证

- 已通过：`git diff --check`。
- 已通过：package JSON 解析检查。
- 已执行但未通过：`apps/web/node_modules/.bin/tsc --noEmit -p apps/web/tsconfig.json`。
  - 阻塞原因：仓库既有 `@brandai/db` Prisma 导出问题与旧页面 / 旧接口隐式 `any` 问题仍存在。
  - 本次修正：已清理 V0.0.7 新增 `referenceAssets` 链路中出现的类型不匹配与局部隐式类型噪音。
- 已执行但未进入测试主体：`pnpm test`、`pnpm test:ai`、`pnpm -F web typecheck`、`pnpm -F web build`。
  - 阻塞原因：pnpm 安装校验阶段要求审批 Prisma、esbuild、sharp 等依赖构建脚本，命令在进入测试主体前退出。
- 未执行：端到端浏览器手动验收。

## 风险与说明

- `STRICT` 当前通过强提示和 reference image note 表达，最终是否完全保真仍受模型能力影响。
- 旧 `referenceAssetIds` 保持兼容，默认按 `INSPIRATION` 处理。
- 素材标签新增数据库字段，部署前需要执行 Prisma migration / generate。
