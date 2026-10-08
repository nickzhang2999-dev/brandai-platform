# Novart 产品整合进度

本文件记录 `claude/novart-product-integration` 的实际边界。完整前后端对比在整合验收之后进行；当前不是产品完成报告。

## 基线与隔离

- 公司源码基线：`e99919a64cd212d5d1b083fd7210842a1962d935`，开工时本地与远端 main 一致。
- 前端分支起点：`52e95a54148400a801e487e0216d76cc33139eb0`。
- 已部署评审版仍是 `f720c4449c7a873cc352f429017709deace1572f`，运行独立文件存储。其链接不能用于验收新后端。
- 本轮不改 main、不发布正式站、不使用生产数据库、不改公司共享 CDS profile。
- 开发机系统盘空间不足：不再启动本机 Docker，临时文件放 D 盘。数据库联调使用远程 CI 的一次性 PostgreSQL 和 Redis。

## 已实现的基础

| 部分 | 实现与复用 | 当前验证层级 |
| --- | --- | --- |
| 身份与品牌 | 复用 Auth.js、User、Membership、BrandWorkspace；新增 `/api/workbench/session` GET/POST，品牌切换复用原 cookie，显式越权选择拒绝 | 单元/契约及编译；真实登录联调由 CI 验证 |
| 项目 | 前端 API 模块对接原项目创建、列表、归档接口 | 原接口保持；页面尚未切换 |
| 完整画布 | 新增 `EditorDocument` 表及 GET/PUT `/api/workspaces/:wsId/projects/:projectId/editor-document` | 字段保留、权限、版本冲突、重试及压缩边界单测 |
| 素材引用 | 只接受同品牌已存素材或当前项目生成版本；上传模块返回鉴权 raw 地址 | 引用隔离单测；真实上传与画布导入待接 |
| 前端请求模块 | 有界请求、正式会话、读取完成后才允许保存、只读/冲突阻断、丢响应重试沿用相同 mutationId | 状态与请求行为单测；尚未接入评审 UI |

画布使用 `novart-native-v1` 格式，保留原 `SHAKKERDATA://` 压缩字符串；不把笔画、旋转、组合、原生扩展字段压成原来的简化 items。解码只做验证，保存原始字符串。编码上限 8 MiB，展开上限 32 MiB。临时 `blob:` / 内嵌 `data:` 图片不能直接作为持久素材，须先入库。

`revision=0` 表示尚未保存。每次写入携带读取到的 revision 和 UUID mutationId；同版本竞争只允许一个写入，旧版本返回 409。同一次保存响应丢失，可以用完全相同的内容和 mutationId 重试；不允许悄悄读取新版本再覆盖。归档项目、VIEWER 和 REVIEWER 只读。

迁移 `20261008000100_native_editor_document` 只增加新表、索引和 Project 外键；旧 `ProjectCanvas` 与 API 保留。当前不自动迁移评审目录下的私人项目或公司旧项目。

## 验证口径

推送前必须通过 `pnpm test`、`pnpm test:ai`、`pnpm -F web typecheck`、`pnpm -F web build`。详细运行记录见根目录 `progress.md`。

`.github/workflows/novart-integration.yml` 只在整合分支执行，临时数据库名固定为 `novart_integration_test`。脚本校验数据库和应用均指向 loopback，使用合成账号经真实密码登录，检查新建品牌/项目、保存重开、两次并发首存、幂等重试、跨账号拒绝、只读与归档保护；不调用 AI provider、不伪造生成结果。工作流是否通过须以具体运行结果为准，配置文件存在不算通过。

尚未运行的真实存储、原生 UI 和模型链路不能用 mock 单测替代验收。

## 接下来必须接通的部分

1. 将评审 Python 页面/资源适配成受正式登录保护的产品入口，盘点全部请求，不只替换 `saveProject`。
2. 将 `/studio/state`、品牌规则、收藏、项目库、首页上传与创建确认、`/workflow/*` 素材及草稿语义逐项映射到品牌/用户/项目作用域。
3. 绑定完整文档会话；实测图片上传、拖放、保存、关闭、重新打开、跨品牌切换和失败恢复。
4. 接公司源码的生成、改图、分层 worker 与任务查询；真实状态/错误可恢复，未接能力明确不可用。
5. 在隔离部署上跑完整用户流程，再出“复用 / 修改 / 新增 / 待补 / 已知差异”前后端对照表。原画布与新画布格式不可假定互通，原素材模板也不等同于可编辑画布模板。

“后端基础接口完成”“页面接通”“完整业务验收”是三个独立状态，不能合并汇报。

## CDS 部署准备

用户要求将当前整合分支部署到 CDS。新增 `deploy/novart/cds-compose.yml`，目标为独立整合项目：Web、Worker、AI 使用经过 CI 检查的精确提交镜像，PostgreSQL 与 Redis 使用独立持久卷。根产品 compose 与现有评审部署保持原样。配置已通过官方 CLI verify（0 errors / 0 warnings）。

`Branch Image` 在整合分支调用集成工作流：四项门禁 → 一次性数据库 HTTP 联调 → 构建镜像 → 镜像内再跑联调和三服务健康检查 → 发布。CDS 只运行已构建镜像，启动时不安装依赖、不编译。CI 结果、镜像发布和实际 CDS 上线须分别确认。

2026-10-08 首轮远程测试在品牌选择失败，已补 Next 内部 URL 与实际请求 Host 不同的校验适配及回归测试，等待远程重验。现有 CDS 凭据仅有公司项目作用域，创建独立整合项目返回 403 `project_key_cannot_create`；须完成新项目创建授权，不改用共享数据库规避隔离。
