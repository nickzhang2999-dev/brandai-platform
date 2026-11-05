# 2026-11-05 品牌规范破图排查与修复交接

状态：按用户“先出日志”暂停。以下修复仅在本地工作区，未提交、推送或部署；没有修改线上素材、对象存储配置或权限，没有调用模型。

更新：用户随后批准继续，已完成下述 worker 根因修复和全部本地门禁。此前暂停段落保留为排查时间点记录；当前仍未提交、推送、部署，历史数据库恢复由主任务独立负责。

## 继续开发后的交付状态

- `runParseManualJob` 改为 `uploadBuffer(bytes, mimeType, workspace/brand-kit, signal)`，Asset 的 storageKey/url 均取自这同一次已完成上传，取消自行拼接的虚假 key。
- 新增 3 项 worker 回归：真实上传 key/url 原样持久化；上传失败不产生悬空素材/规则；上传后再校验来源权限，撤权后不写入派生素材。
- 已有 PostgreSQL 集成测试同步上传返回形状，并断言持久化的真实 key、url、MIME。全新专用本机 PostgreSQL（127.0.0.1:55456，本轮新 data 目录及数据库）完成所有迁移，8 项精确集成用例通过；测试后实例已停止，数据与日志保留，不影响既有本机或线上库。
- 完整门禁：`pnpm test` 三个包任务通过（Web 2553 passed / 71 按配置 skipped）；`pnpm test:ai` 876 passed；`pnpm -F web typecheck`、`pnpm -F web build` 均通过；`bash cds-release.sh check` 和 `node --test scripts/test-project-release.mjs` 均通过。跳过的常规集成测试不算通过，本次另行执行的精确 8 项 PostgreSQL 用例已全部通过。
- 当前专项共 20 项单元/渲染/规则 API 测试通过。尚未进行新版线上 UI 验收；没有重新调用付费视觉模型。
- 验收日志目录：`D:/coding/.novart-tmp/brand-evidence-20261105/`。最初系统 Bash 指向不可用的 WSL；后改用本机已安装 `D:/Git/bin/bash` 完成检查。新 PostgreSQL 降权进程最初没有目录写权限，仅给本轮新 data 目录当前用户权限并将服务器日志放到该目录后初始化成功；未改变全局服务配置或其他目录权限。

## 已核实的两个原因

1. 设计指南：截图对应证据引用 PDF 手册。正常登录读取原文件返回 HTTP 200、PDF 文件头、attachment 响应；旧 RuleCard 直接使用 img 显示 PDF，因而破图。这不是手册文件丢失。
2. Logo：数据库唯一“页面顶部主标”前缀对应证据引用 JPEG，素材归属正确。正常读取返回 404。当前 scoped storageKey 和旧未加 scope 的同 key 均 HEAD 404，而资产 URL 与当前配置 public origin 相同、URL 路径却不匹配 storageKey。

Logo 根因已在 `apps/web/src/lib/workers/parse-manual.worker.ts` 的 `runParseManualJob` 查到：裁图调用 `uploadDataUrlImage` 上传到 workspace/brand-kit 下的随机对象名，保存 Asset 时却另写 `brand-kit/taskId/sourceRef.jpg`。该固定 key 从未被这次上传写入。原文件代理按 storageKey 权威读取，故返回 404。不能用 UI 回退冒充原图已经恢复。

## 本地已完成

- 规则列表 GET 从同 workspace 的 Asset 批量读取真实 MIME；覆盖历史/模型输入中的不可信 MIME，不暴露桶或原始签名 URL。
- Evidence MIME 字段同步 Zod/Pydantic 镜像。
- 规则卡区分 raster 图片与 PDF/其他文档；PDF 显示手册及页码、来源文件入口。
- 缺失图片出现“原图暂不可用”提示，不再只露出破图 alt；没有改变 raw 路由权限和附件策略。
- 17 项专项测试通过，包括 API 归属/MIME、卡片实际 React 服务端渲染、已有规则修改测试。
- TypeScript `tsc --noEmit` 在增加最后三项卡片测试前通过；最后测试文件本身已通过 Vitest。未完成本轮全量 G-VERIFY、真实浏览器新 UI 验证及部署验收。

## 暂停时未完成

- `parse-manual.worker.ts` 写错 storageKey 的根因修复尚未动手。下一步改用返回 `{key,url}` 的 `uploadBuffer`，保存同一次上传返回的真实 key/url，补 worker 回归及现有 PostgreSQL 用例。
- 历史 Logo 未恢复。只检查过错误 key 的新旧位置；尚未 HEAD 原 asset.url 对应的真实对象，不能据此断言原字节已经丢失。
- 如原 URL 在同一已授权存储范围内找到对象，应先核对 MIME、字节数、尺寸、来源关联，保存 SHA-256 与修复前快照，再提交明确的历史修复清单；不要猜地址、绕跨环境限制或重新生成 Logo。
- 本机四个已知部署/备份目录中 223 份有界文本报告未命中对应 assetId/storageKey；没有搜索微信或个人图片文件。

## 私有证据

保存在 `D:/coding/.novart-tmp/omni-300-20261105/`：

- `brand-preview-readonly.json`：受限素材元数据（含内部引用 ID，不用于公开发布）。
- `brand-preview-http-readonly.json`：正常登录原文件 HTTP 状态。
- `brand-logo-exact-readonly.json`：截图 Logo 引用关联。
- `brand-logo-object-readonly.json`：错误 key 新旧位置 HEAD 结果。
- `brand-logo-recovery-readonly.json`：原 URL 与当前配置匹配布尔值、备份搜索范围。

## 待提交文件范围

`packages/contracts/src/entities.ts`、`apps/ai/app/schemas.py`、`apps/web/src/app/api/workspaces/[wsId]/rules/route.ts`、`apps/web/src/components/brand-knowledge/BrandKnowledgeEditor.tsx`、新增 `evidence-preview.ts`、`apps/web/tests/brand-evidence-preview.test.ts`、`apps/web/tests/brand-evidence-card.test.ts`，以及本日志。其他既有工作日志由主智能体统一维护。

继续开发新增：`apps/web/src/lib/workers/parse-manual.worker.ts`、`apps/web/tests/parse-manual-storage.test.ts`、`apps/web/tests/brand-kit-import-postgres.test.ts`。共 11 个文件。
