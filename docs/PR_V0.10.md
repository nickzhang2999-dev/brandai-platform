# PR: V0.10 生成图检索与项目维度过滤

## Summary

- 将 **生成图** 入口从单纯图库升级为可检索、可过滤的生成图管理页。
- 新增生成图专用查询接口，返回 `GENERATED` 图片及其所属项目信息。
- 生成图页面支持搜索、项目筛选、项目状态筛选、时间筛选和排序。
- 生成图卡片展示项目上下文，并提供回到项目工作台的入口。

## Key Changes

- 新增 `GeneratedAsset` 契约：在 `Asset` 基础上附加 `projectId`、`projectName`、`projectStatus`、`generationId`、`generationCreatedAt`、`sceneType`。
- 新增 `GET /api/workspaces/[wsId]/generated-assets`。
- `/generated` 页面改为读取生成图专用接口，而不是直接读取通用素材接口。
- `/generated` 页面顶部新增查询与筛选工具条。
- README 和本轮修改统计文档同步更新到 V0.10。

## Test Plan

- `pnpm test`
- `pnpm test:ai`
- `pnpm -F web typecheck`
- `pnpm -F web build`

## Acceptance

- 左侧导航可进入 **生成图**。
- 生成图页面只展示 `libraryKind=GENERATED`。
- 搜索框可按文件名、描述、项目和提示词检索。
- 项目、项目状态、时间范围和排序控件可正常联动刷新列表。
- 生成图卡片显示所属项目、状态和场景类型。
- 点击卡片中的回跳入口可进入对应项目工作台。
