# Novart 产品整合进度

本文件记录 `claude/novart-product-integration` 的实际边界。完整前后端对比在整合验收之后进行；当前不是产品完成报告。

## 当前交付顺序：先成品，再统一优化

2026-10-08 用户明确优先成品，暂缓观感、动画与零散功能打磨。执行清单以根目录 [task_plan.md](../task_plan.md) 为准，按以下顺序推进：

- [x] 独立部署与登录可用：ec5ff74 的真实登录、品牌切换、完整文档保存重开等 14 项公网检查通过；每次推送使用已批准的临时 webhook 停启窗口，长期分支排除尚未配置。
- [ ] 评审前端成为正式入口：首页、品牌、项目、素材与画布串联，刷新和深链指向真实项目。
- [ ] 品牌、项目、素材接入真实存储：创建/编辑/归档、上传/选择、品牌规则均持久化并校验归属。
- [ ] 原生画布完整保存重开：接上已实现的文档会话，混合对象与图片保持一致，失败和冲突有明确恢复入口。
- [ ] 真实生成闭环：需求与参考素材经现有任务/Worker 产生真实结果，结果进入画布、可保存重开和导出。
- [ ] 首版整体验收：真实登录、存储和模型走完整流程，修复阻断问题，交付可操作链接、私下账号及已知差异。

第一版验收主线为：登录 → 选择/创建品牌 → 新建/打开项目 → 上传素材 → 编辑画布 → 真实生成 → 保存 → 关闭重开 → 导出。画布扩展工具、动画细节和统一视觉精修放在主线通过之后；现有功能不静默删除，尚未接通的入口不得伪装可用。

## 基线与隔离

- 公司源码基线：`e99919a64cd212d5d1b083fd7210842a1962d935`，开工时本地与远端 main 一致。
- 前端分支起点：`52e95a54148400a801e487e0216d76cc33139eb0`。
- 已部署评审版仍是 `f720c4449c7a873cc352f429017709deace1572f`，运行独立文件存储。其链接不能用于验收新后端。
- 本轮不改 main、不发布正式站、不改公司共享 CDS profile。原项目 webhook 曾意外启动整合分支并写入 CDS 共享库，具体影响与停止记录见末尾；不得据此声称共享库完全未变。
- 开发机系统盘空间不足：不再启动本机 Docker，临时文件放 D 盘。数据库联调使用远程 CI 的一次性 PostgreSQL 和 Redis。

## 已实现的基础

| 部分 | 实现与复用 | 当前验证层级 |
| --- | --- | --- |
| 身份与品牌 | 复用 Auth.js、User、Membership、BrandWorkspace；新增 `/api/workbench/session` GET/POST，品牌切换复用原 cookie，显式越权选择拒绝 | 单元/契约及编译；真实登录联调由 CI 验证 |
| 项目 | 前端 API 模块对接原项目创建、列表、归档接口 | 原接口保持；页面尚未切换 |
| 完整画布 | 新增 `EditorDocument` 表及 GET/PUT `/api/workspaces/:wsId/projects/:projectId/editor-document` | 字段保留、权限、版本冲突、重试及压缩边界单测 |
| 素材引用 | 只接受同品牌已存素材或当前项目生成版本；上传模块返回鉴权 raw 地址 | 引用隔离单测；真实上传与画布导入待接 |
| 前端请求模块 | 有界请求、正式会话、读取完成后才允许保存、只读/冲突阻断、丢响应重试沿用相同 mutationId | 状态与请求行为单测；尚未接入评审 UI |
| 原生请求兼容 | `queryProject` / `saveProject` / `lovartProjectList` / `updateProjectName` 对接真实身份、品牌和文档服务；保存冲突保留原编辑器识别的 `100400` 响应 | 新增单元/契约检查与真实 HTTP/DB 检查脚本；本次远程检查结果另记 |

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

### 已确认的镜像与测试

提交 `b124ef1875621cb80b64e57312f29f5ad7d4ac1c` 的 [Branch Image 运行](https://github.com/nickzhang2999-dev/brandai-platform/actions/runs/37739584857) 已成功：四项仓库门禁全绿，真实 HTTP/数据库检查 20 项，构建后的容器内同一套 20 项再通过，Web/Worker/AI 健康检查通过。未调用模型服务。

- Web/Worker 镜像：`ghcr.io/nickzhang2999-dev/brandai-platform/novart-product-web:sha-b124ef1875621cb80b64e57312f29f5ad7d4ac1c`；digest `sha256:6c14fcdcba98a7cc0f0ffc3f9e1e92372708c60db67b402f552b0ce14c5f0f15`。
- AI 镜像：`ghcr.io/nickzhang2999-dev/brandai-platform/novart-product-ai:sha-b124ef1875621cb80b64e57312f29f5ad7d4ac1c`；digest `sha256:07708f404235255bb44d0970e968f0d4a888e6f5f658f70386a759c73322986c`。
- 两个镜像均已检查匿名 manifest 拉取 200，CDS 不需新增仓库密钥。

### 自动部署意外及处理（不得略过）

推送前未核对公司 CDS 项目 `githubAutoDeploy=true`。两次 Git 推送被项目 webhook 自动部署，生成了 `brandai-platform-claude-novart-product-integration`，使用原 dev/release profiles 和项目共享 PostgreSQL/Redis；这不是预期的独立环境。

只读核对确认：`20261008000100_native_editor_document` 已于 2026-10-08 06:38:04 UTC 在公司 CDS 共享库执行，`EditorDocument` 当前 0 条。启动脚本执行 seed，分别于 06:38:07 和 06:48:21 新建两条演示品牌；seed 同时 upsert 四档套餐，缺少执行前数值，不能断言配置没有改变。未擅自删除演示记录、回滚表或覆盖套餐值。

已通过 CDS stop 停止**仅此整合分支**的 Web/Worker/AI；06:50:32 UTC 后为 idle，CI 完成后复核仍停止。main 三服务继续 running，代码提交仍为 `e99919a`。停止分支不会禁用未来 Git webhook，因此在解决自动部署范围前，不继续向该分支推送。需要由有相应权限的管理员确认共享库初始化影响，并配置该分支的自动部署范围。

独立部署控制目录位于开发机公司文件夹中的 `novart-cds-integration-deployment`；凭据只由官方 CLI 保存。已发起一次性创建 `Novart-Product-Integration` 权限申请。批准后还须 clone、导入已经 verify 的独立 compose、确认项目级 infra 与镜像模式，再部署精确提交，最后做公网探针与入口资源检查。

### 独立 CDS 公网写入验收通过

项目 `98cfea6cdcbd`（Novart-Product-Integration）已获授权并创建；整合分支运行 `ec5ff74af693e43815cb8d40d1482df614c0c1ec` 精确镜像。部署记录 `dr_d2407a4cbe69a45a792903ad` 成功，Web、AI、Worker 均 running，公网 `/api/health` 的三服务健康均正常，Worker 报告本次提交和 9 个处理器。[CI 37745450841](https://github.com/nickzhang2999-dev/brandai-platform/actions/runs/37745450841) 成功，真实数据库检查在构建及镜像内重复通过。

官方 CLI 返回入口：https://novart-product-integration-claude-novart-product-integration.geole.me/login 。当前入口仍为原 Next 页面加新后端接口，尚未接入评审版原生 UI。

导入纠正记录：两次导入均被批准，旧导入晚于新导入导致额外 AI/Worker infra。通过官方页面同源 API 的 resync preview/execute，移除仅此新项目的两项未使用错误 infra；不删除数据卷。PostgreSQL 和 Redis 改用 `novart_integration_pgdata` / `novart_integration_redis`。导入中的自引用环境变量未生成值，后续在独立项目作用域设置专用随机凭据。已配置实际可解析的服务别名，避免过长容器名导致 ENOTFOUND。该项目使用独立 Docker 网络、数据库、Redis、会话密钥及队列前缀，不复制原公司用户或业务数据。

公网已验证登录页、构建 JS/CSS、未登录 401、真实注册和密码登录，以及测试品牌创建。专用验收账号只存开发机独立部署目录的 `.cds/review-access.json`；未进入 Git 或聊天。测试品牌使用明确验收名称，不冒充真实用户内容。

公网品牌选择的 403 已修复：Origin 校验优先使用服务器配置的 `AUTH_URL`，仍拒绝伪造 forwarded-host、陌生来源、错误协议/端口与无效配置。ec5ff74 通过本地 281 contracts + 6 UI、157 AI、typecheck、production build。公网 14 项检查通过：三服务健康、页面资源、匿名拒绝、真实密码登录、品牌切换与保持、新建项目、完整原生文档保存/原字节重开、幂等重试及过期版本拒绝。该验收覆盖 HTTP/数据库，不等于已评审 UI 的真实操作验收。

推送控制：用户批准临时关闭原公司项目的 push 自动部署，发布修复后恢复。ec5ff74 发布前已关闭并回读确认，独立部署和公网检查后已恢复为 true 并复核；main 继续 running，原项目整合分支 idle。此措施是发布窗口，不是永久排除规则。后续推送仍须先落实这一保护，不能直接 push 再靠事后 stop。

### 评审前端接线进展

`scripts/export-novart-studio.py` 仅在构建时运行既有 Python 适配器，导出首页/画布 HTML、派生 JS/CSS、捕获的动态资源及哈希清单；119 个文件、约 26.9 MB，35 个外部资源本地映射。临时编译项目和存储会清理，不复制评审账号、访问密钥或个人项目。尚未启用产品静态页面路由，避免把仍指向演示存储的页面作为成品入口。

原生项目接口使用正式 Auth.js 会话，按当前品牌或显式 `workspaceId` 校验成员和项目归属。版本映射为 `novart-<revision>`；旧本地版本不会被当成新库版本。没有客户端 mutation UUID 的原生保存，根据用户/品牌/项目/版本/完整内容确定幂等标识；原文档服务继续负责锁、权限、素材引用和冲突。自动保存中的旧标题只作为客户端回显，不覆盖独立重命名操作。原生封面/图片计数属于派生提示，不作为权威业务数据入库；列表当前不宣称提供这些派生预览。克隆/备份、增量证据和访问票据服务尚未接入，明确拒绝，不返回伪成功。

2026-10-08 用户反馈公司项目右侧分支预览不能直接进入：实查该预览根网址返回说明页，缺少评审访问 cookie；服务并未停止。为对应域名生成本机私有启动页，HTTP 验证完整入口及 `/studio` 均成功。首次在同一浏览器访问后，再点 CDS 根网址会跳转工作台；访问能力不写入 Git/公开文档，也不因此去掉评审门禁。
