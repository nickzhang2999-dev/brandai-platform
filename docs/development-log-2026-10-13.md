# Novart 开发日志 · 2026-10-13

## DeepFlare 展示品牌更换

用户提供设计原稿、完整版图片和纯图形，并将最初“仅换 Logo”修正为“名称和 Logo 都换”。最终显示品牌为 **DeepFlare · 曜影深蓝**。开发仍在 `devUpdate1012`，资源说明见 [DeepFlare 品牌资源](deepflare-brand-assets.md)。

- 原稿两页分别导出完整 SVG 和纯图形；保留字形、路径及原稿渐变外观，去掉多余画板留白。渐变以内嵌采样结合矢量裁切，不冒称所有内容均为纯矢量。原稿保留，Web 资源无外部字体或网络依赖。
- 登录/注册、常规导航、品牌套件入口、Studio 首页、画布标志、产品介绍/邀请、网页标题/favicon，以及画布与 PSD 导出文件名前缀统一 DeepFlare。完整标志增加深色背景字标，图形颜色保持。
- 窄屏检查发现新增 Logo 会挤压顶栏文字，将手机按钮收紧并保持单行，返回入口保留完整无障碍名称；桌面文案和间距保持。390px 页面无横向溢出，保存状态仍可读取。
- 两套浏览器 fixture 显式服务实际 SVG 资源；仅更新品牌文件名的严格测试预期，没有放宽身份、尺寸或文件验证。

实际验证：完整 L1 1256＋28、AI pytest 430、Web 类型和生产构建通过。元数据/暗色 Logo/窄屏追加后的最后 L1 复跑使用两项 Turbo 缓存，类型及生产构建实际重跑通过。旧自研画布浏览器 49 项、新自动 PSD 浏览器 12 项通过，新增品牌视觉检查 4 项通过。Studio 资源编译 125 个文件通过；SVG、32px 和 180px 图标实际生成，登录页明亮/深色静态构建及桌面/窄屏画布均已渲染查看。

成果与报告保存于 `D:/coding/.novart-tmp/deepflare-brand-20261013/`，包括原稿渲染参考、资源报告、登录与画布图片以及 `branding-browser-report.json`；完整门禁日志 `deepflare-brand-{l1,ai,typecheck,build}-20261013.log`，49/12 项交互报告分别为 `deepflare-brand-owned-browser-20261013.json` 和 `deepflare-brand-psd-browser-20261013.json`。登录图片来自真实生产静态 HTML/CSS，禁用 JavaScript，不代表登录/后端验收；交互预览明确使用合成 API，模型调用 0。

本地额外启动 Next 生产预览，以及第二次重启交互预览的命令，被自动审批以 `blocked by policy` 拦截，未绕过或重试同一受限操作。改为保留现有进程，直接重编译该进程读取的前端文件，当前预览内容保持；登录视觉使用生产构建静态输出。首次静态截图 CSS 路径包含部署查询参数导致找不到文件，按 URL pathname 修正并重跑。首次 loopback 资源导出遇系统代理 502，设置 NO_PROXY 后编译成功。这些是本地运行/工具问题，没有 CDS 故障证据。

本轮只正常提交新分支，不手动操作 CDS、不合并 main、不改业务数据、内部格式或域名。提交准备时新版本的云端任务尚未执行，不把前一轮 PSD 的云端成功冒称本轮品牌变更验收。

## 生成后自动 PSD 追加开发

帅帅要求把开源复用方案做成可见成果。本轮继续在 `devUpdate1012` 完成后台自动任务、前端入口和实际 PSD 文件出口，三名子智能体分别承担上述部分，小克负责整合、审阅、全量门禁和日志。没有启动目标模式、Computer Use、本机 Docker，未操作 CDS 或 main。

### 已完成行为

- 生图前可勾选“同时准备可编辑PSD”并选择 2–10 层，默认关闭。该选择进入不可变服务端生成记录；普通生成不增加分层调用，修改模式不携带自动 PSD 字段。
- 真实原图归档成功后，复用 Studio 分层队列继续处理。后台 outbox 补发和稳定请求 ID 支持关页、刷新及崩溃恢复；读取进度不提交新任务、不再次付费。
- 结果卡分别显示原图与 PSD 状态，成功后支持下载或展开可编辑图层。自动原图尚未入画布时，原图和全部图层一次性放入，原图隐藏保留；重复展开不覆盖用户已编辑图层。
- PSD 导出保留原画幅、独立像素图层、透明通道、层序与合成预览。下载前校验 HTTP/MIME/签名/尺寸及完整字节，403 等错误不会变成假 PSD 文件。
- 当前预算 256 MiB、单进程单导出、30 秒可终止 Worker。2K 方图四层会超限，在分层模型付费前拒绝，页面给出两层建议；不偷偷缩小图片或减少层数。文本为像素，未承诺 OCR 可编辑文字。

### 实际验证与成果

| 已实际运行 | 结果 |
| --- | --- |
| 完整 L1（串行限单 Worker，无缓存命中） | 契约 1256＋UI 28 全通过 |
| Windows venv 完整 AI pytest（与 `test:ai` 同范围） | 430 全通过；1 条既有 Starlette 弃用警告 |
| Web 类型检查、低内存生产构建 | 均通过 |
| 原自研画布实际浏览器交互 | 49 项通过 |
| 自动 PSD 专属实际 React/headless Chrome 交互 | 12 项通过；模型调用 0、外网请求 0、浏览器错误 0 |
| 真实 PSD 二进制写入、回读、重合成 | 5 项通过；96 × 64、3 层、6346 字节 |

浏览器验证包括提交一次、原图先可用、PENDING/RUNNING/READY 读取、403 不下载、实际浏览器下载双层 PSD 后解析、自动源图片放入/图层重放、刷新恢复、手动分层任务下载及失败保留。该报告是明确的合成交互服务，不是模型或真实数据库验收。格式样例同样明确标为合成 RGBA 图层，没有冒充 AI 生成。

本地成果保存于 `D:/coding/.novart-tmp/devUpdate1012-psd-proof-20261013/`，包括 `Novart-synthetic-editable-layers.psd`、合成预览、独立 PNG 和报告。PSD SHA-256 为 `8fa53fa1a730e2a1a95c7855c678d280e3894eb96cd7a32776fe02ada510a8f4`。浏览器报告为 `devUpdate1012-auto-psd-browser-20261013.json`；四项门禁日志为 `devUpdate1012-auto-psd-{l1,ai,typecheck,build}-20261013.log`，均在 `.novart-tmp` 中。

### 本轮实际云端结果

代码 `f82ed27fc56acdc35c571027d7837554c256e850` 已正常推送并通过 [Actions 38355837716](https://github.com/nickzhang2999-dev/brandai-platform/actions/runs/38355837716)，最终 `completed / success`，后端 job `115158396116`。从实际日志核对两轮各 **Workbench backend 141、Owned studio UI 23** 项通过，API/UI exit 均为 0；源码和构建后 Web/Worker/AI 容器均执行了真实登录、数据库、上传 Worker/S3、画布与知识联调。新增 PSD 权限/作用域和默认开关检查已实际执行。

自动 PSD fixture 及源码格式检查通过，构建后的 Web 容器也实际运行同一 PSD 写入/回读/隐藏层重合成检查，证明 `ag-psd` 与 Worker 打包依赖可用。完整仓库门禁、独立 Garage 存储镜像检查、Web/AI 镜像发布和一次性环境清理通过。镜像发布不等同于 CDS 预览或正式站更新，未操作 CDS。

两轮真实性边界继续保持 `realKnowledge=true`、`realDecomposition=false`、`realGeneration=false`。本轮模型调用 0；不能用新增文件或交互样例宣布真实 AI 分层完成。安全摘录保存于 `D:/coding/.novart-tmp/devUpdate1012-auto-psd-ci-proof-20261013.json`，只含提交、run/job、计数与验证类别，不存凭据或原始业务日志。下文“提交准备时尚待云端”的句子是当时状态，最终执行结果以本节为准。

### 修正与待验收

审阅修正了服务端与浏览器自动源 ID 不一致、导出请求的 workspace query hint、mutable outbox 被纳入不可变生成哈希、生成回执遗漏 PSD 选择核对，以及报错 JSON 被浏览器保存为文件等问题。初始 PSD 回读缺少 ImageData 分配器已补实际 RGBA 分配并重跑；浏览器 fixture CSS 覆盖错误已修且重跑，生产 CSS 未改。

本机默认并行 Vitest 曾发生 Node 内存提交失败，改为单 Worker/串行后通过。pnpm/Turbo 参数转发两次预检报错均未执行测试；最终实际成功命令为 `pnpm run test --concurrency=1 -- -- --maxWorkers=1 --minWorkers=1`。未将失败启动计作验收。

新工作区未找到可用私有分层配置，本轮没有真实模型调用；普通生图 API 不能因加一个工作流就自动变成真实图层模型。成功 AI 分层、私有图层持久化与 PSD 全链路质量仍待真实配置验收。CI 已增加 7 项真实 HTTP/Auth/数据库边界、1 项真实页面开关检查，以及构建后 Web 容器实际 PSD 编码检查；提交准备时本轮云端尚未执行，不能提前标通过。

本轮无新增 CDS 故障证据，无 CDS 配置变更；本地测试的 Node 内存/CSS fixture/PSD reader 问题不能归因于 CDS。

## 迁移后的真实联调追加

用户要求继续联调，工作区和分支仍为 `brandai-devUpdate1012` / `devUpdate1012`。不使用目标模式、Computer Use、本地 Docker，不操作 CDS 或共享业务数据库。

### 本轮最终验收结果

追加代码 `5d2f51c84cf1fc865f29da1f8cda28950f8b3ba0` 已正常推送，实际 [GitHub Actions 38346622593](https://github.com/nickzhang2999-dev/brandai-platform/actions/runs/38346622593) 为 `completed / success`，job `115129442648`。本次真正执行了新增验收，没有以源码审阅或合成浏览器结果代替：

| 实际运行环境 | 后端检查 | 真实页面检查 | 关键结果 |
| --- | --- | --- | --- |
| 源码构建环境，专用 PostgreSQL/Redis/S3 | 134 项通过 | 22 项通过 | 新增知识后端 16、分层原稿保留 23、知识页面 5 均执行 |
| 构建后的 Web/Worker/AI 容器，同一隔离数据库 | 134 项通过 | 22 项通过 | 页面真实性断言、新 AI 分层及单次调用能力版本检查通过 |

品牌知识已完成真实保存、草稿导入、显式确认、编辑、快照恢复/备份逆操作、刷新及新登录恢复、只读角色和跨租户保护。本轮分层检查使用真实上传 Worker/S3、真实画布保存及重开，证明缺分层配置时明确 503、各拒绝请求不改变原图/画布/任务/计量。它仍不是一次成功的模型分层验收，报告保持 `realDecomposition=false`，所有模型调用为 0。

云端两轮日志计数及能力检查的安全摘录已保存至 `D:/coding/.novart-tmp/devUpdate1012-integration-ci-proof-20261013.json`，关联提交与 run/job 均明确。完整源码门禁、存储镜像与容器检查、镜像发布及一次性环境清理也成功。没有将发布镜像误报为 CDS 或正式产品更新。

下文“提交准备时尚待 CI”的句子记录当时的状态；最终状态以上述实际完成结果为准。真实 Fal 配置未得到新的确认，成功分层、私有图层归档/raw 和可编辑结果闭环继续保留为待验收项。

### 迁移版本真实云端结果

核对提交 `7c83011b13488933f9bf8d820873802a5958c63a` 的 GitHub Actions [38344585370](https://github.com/nickzhang2999-dev/brandai-platform/actions/runs/38344585370)：`product / backend` 成功。两份数据库迁移已在一次性 PostgreSQL 实际应用，源码与构建后容器两轮各通过后端 95 项、真实页面 17 项；真实登录、上传 Worker/S3、画布保存恢复均经过原有验收。镜像检查与发布步骤成功，不将镜像发布等同于 CDS 或正式站部署。

该轮原有真实栈脚本尚未覆盖新增知识管理和分层接口；三个新浏览器 fixture 仍是合成服务，不能由这份成功推断真实分层模型完成验收。关联 job 为 `115122902966`，工件 `11788667609`；本地只保存不含凭据的元数据，原日志通过连接器仅提取检查计数。

### 本轮整合修复和追加验收

- **分层服务能力门禁**：原分层客户端虽传单次调用约束，却未要求服务端宣告新版分层能力，可能选中旧 AI 服务。新增 `studioDecompositionRevision=studio-real-layer-single-attempt-r1`，真实分层必须同时满足此能力和 `single-provider-attempt-r1`；覆盖显式地址、共享网络服务发现和缓存。先加回归得到 TS 9 项和 Python health 1 项失败，修复后定向 TS 90 / Python 76 通过；完整 L1 为 1158＋28、AI 421、Web 类型及生产构建通过。
- **品牌知识真实后端**：新增 `verify-studio-brand-knowledge-backend.ts`，接入主 runner，16 组真实 HTTP/Auth.js/Postgres 断言。独立验收品牌、原账号真实邀请，覆盖并发导入幂等、确认/替换、删除后重放、快照恢复及备份逆操作、角色和租户边界。所有业务写入走 API，Prisma 仅读取核验。
- **分层真实后端边界**：新增 `verify-studio-decomposition-backend.ts`，23 项检查经真实 multipart 上传、Worker/S3、raw 字节、原生画布 HTTP 保存，再验证无分层配置时 503 与各拒绝边界；每次拒绝后核对任务、计量、素材及画布不变。任何真实分层配置或密钥都会使零调用验收主动停止，避免意外模型调用。
- **品牌知识真实页面**：在原真实 Next 页面验收中增加 5 组操作：评审入口与草稿保存、中文规则创建/启用/编辑、导入回执、刷新及新登录恢复、VIEWER 只读控件。全部完成才设 `realKnowledge=true`；`realDecomposition=false` 明确保留。
- **CI 门禁**：源码和容器两个阶段均要求真实知识页面报告、独立数据库结果和真实性边界；容器阶段另核对新 AI health 能力。保留原上传、画布与隔离数据库检查，没有假造成功分层任务。

追加代码的本地验证证据为 `D:/coding/.novart-tmp/devUpdate1012-integration-{l1,ai,typecheck,build}-20261013.log`。首次全量类型检查发现 helper 两个数组索引可能为空，保留两份回执数量和内容断言后以显式非空检查修复；重跑通过。工作流 YAML 和内嵌 Python 块均通过解析；首次命令行转义错误改用字面 here-string 后修正。追加的真实 HTTP/页面验收在此提交准备时尚待隔离 CI 实际运行，不能在本节提前标通过。

### 运行环境和真实模型边界

本机没有现成 Postgres/Redis/S3 进程、端口或本地私有运行配置；仅有 docker-desktop WSL，因此采用已有 GitHub Linux 一次性栈，不在 Win10 启动 Docker。存储必须沿用 `prepare-studio-storage.ts` 在专用数据库保存显式 AppSetting；只写 S3 环境变量不能证明分层存储已配置。

分层使用独立 `layerProvider/layerApiKey` 配置。普通生图账号不自动适用于 Fal 分层。本地可用配置不存在，当前远端可用性本轮没有读取；历史配置不能代表今天。已询问配置保存位置，不要求发送密钥。本轮模型调用为 0；真实 Fal 质量、成功图层归档、授权 raw 读取和结果编辑闭环仍需该配置及一次小规模真实验收。

## 工作区切换与两个功能迁移

用户指定 `devUpdate1012` 为后续开发区域，要求将昨天新增的品牌知识管理、AI 分层放入该分支，本轮先不处理 CDS。

实际核对：目标仍是公司仓库 `nickzhang2999-dev/brandai-platform` 的分支，起点 `5499be0fbed5926084ec29892f9a4c23643b6aa4` 与用户截图一致。它已包含 main 的首页/登录进入 Studio 修复、旧评审入口兼容及新提交规则。

新建独立本地 checkout：`D:/coding/公司/brandai-devUpdate1012`。安装 `scripts/install-cds-push-guard.cjs`，保留分支现有规则，普通推送必须通过本地钩子。

从 `D:/coding/公司/brandai-workbench-preview` 的 `74e2db2` 加未提交工作树迁入 77 个限定源代码/测试文件，包括两份 additive migration、知识管理入口、分层任务/Worker/归档、画布结果展开和跨页通知。旧工作区未修改，四个既有脏文件及私有配置未迁入。迁移备份与逐文件 SHA256 清单位于 `D:/coding/.novart-tmp/devUpdate1012-transfer-20261013`。

首次迁移内容核对因 Git CRLF 转换导致字节哈希不一致而停止；核对换行标准化后的内容逐文件相同后，在新目录恢复源文件字节，并重新核对全部 77 文件一致。没有用源文件覆盖不同的功能代码。

新目录离线安装依赖失败：本目录缓存缺少锁文件中的 AWS SDK 包。随后按未修改的锁文件联网安装 434 个包成功，未将旧工作区 node_modules 或账号配置复制到新目录。

## 当前验证与完成边界

三个并行任务分别负责两个旧测试缺口、后端迁移审阅、前端资源与隔离浏览器验收。全仓重型检查由主线程顺序执行，避免并发构建挤占内存。

| 本轮在新 checkout 实际执行的检查 | 结果 | 本地证据 |
| --- | --- | --- |
| L1 全仓，强制执行、无缓存 | 契约/服务 1147 项、UI 28 项通过 | `D:/coding/.novart-tmp/devUpdate1012-l1-20261013.log` |
| AI 服务完整 pytest | 421 项通过 | `D:/coding/.novart-tmp/devUpdate1012-ai-tests-20261013.log` |
| Web 全量类型检查 | 通过 | `D:/coding/.novart-tmp/devUpdate1012-typecheck-20261013.log` |
| Web 生产构建 | 通过，含知识管理与分层路由 | `D:/coding/.novart-tmp/devUpdate1012-build-20261013.log` |
| 原画布完整 Chromium 回归 | 49 项通过，包含画笔、文字、图片、撤销、保存重开、PNG/SVG 及工具栏稳定性 | `D:/coding/.novart-tmp/devUpdate1012-owned-core-20261013.json` |
| 新 AI 分层画布交互 | 10 项通过，含部分下载失败不插入、整组撤销、原图保留、重开 | `D:/coding/.novart-tmp/devUpdate1012-ui-20261013-layers.json` |
| 品牌知识交互 | 14 项通过 | `D:/coding/.novart-tmp/devUpdate1012-ui-20261013-knowledge.json` |
| 分层跨页任务通知 | 16 项通过 | `D:/coding/.novart-tmp/devUpdate1012-ui-20261013-inbox.json` |
| 原资源清单校验 / Studio 导出 | 173 项通过；导出 124 文件、76 外部资源、27,072,925 字节 | `D:/coding/.novart-tmp/devUpdate1012-ui-20261013-source-freeze.json` |
| 原生推送钩子真实 Git 回归 | 14 项通过 | `D:/coding/.novart-tmp/devUpdate1012-push-guard-20261013.log` |
| 旧目录保留复核 | 77 个功能源文件与 4 个既有脏文件的 SHA256 均未变化 | 原迁移清单及保留清单 |

AI 测试在新目录独立创建的 Python 3.12.9 venv 中执行，使用仓库固定的 requirements；Windows 入口为 `apps/ai/.venv/Scripts/python.exe -m pytest -q`，与仓库 `test:ai` 的 pytest 检查范围一致。没有借用旧工作区运行时。仅有一条 Starlette TestClient 的 httpx 弃用警告，不影响通过；本轮不改依赖协议。

浏览器测试运行实际 React 页面及样式，使用隔离 loopback 内存服务；报告明确标记 `realBackend=false`、`realProvider=false`、`realAuthentication=false`、`providerCalls=0`。它们证明交互回归，不能替代真实账号、业务数据库、模型质量或正式环境验收。

## 两个迁入功能及整合修正

- **品牌知识管理**：增加 `/studio-brand-knowledge` 入口，复用七类品牌规则、禁用项、术语与快照接口；支持编辑/确认、草稿导入和快照恢复。草稿导入读取真实保存的草稿 revision，新增幂等导入回执，只写待确认的色彩/字体规则，不直接覆盖已确认品牌规则。
- **AI 分层**：增加持久分层任务、队列与 worker、真实 Fal 协议、私有图层归档和授权 raw 读取。画布可查看任务、显式把结果插入为整组，保留并隐藏原图，支持一次撤销和保存重开；全局任务通知可返回原项目。后台持久记录付费 claim，模型请求不自动重试；归档重试仅使用既有模型结果。
- **旧测试缺口修复**：raw 图层读取测试补齐授权、404/422/500 和私有数据不泄露检查；解构契约测试覆盖可选 `providerRetryPolicy=never` 及非法值。对应 63 项检查通过，没有删断言或放宽验证。
- **收尾修正**：去掉契约入口重复导出；三个迁入 shell 文件统一 LF，移除 HTML 第 55 行 6 个行尾空格，同步资源 SHA256 并重导出；移除知识编辑组件及其测试的文件末尾多余空行。最后的变化只有空白，已保留之前的浏览器报告并记录源文件哈希。
- **后续持续验证**：在现有 GitHub 产品整合工作流中加入分层、知识管理、任务通知三个隔离浏览器检查和报告真实性断言，保留原验证链路及正常推送流程。

后端只读审查未发现本次迁移漏文件或新增越权入口。原识别/手册解析的旧队列、Mock 配置边界及付费幂等与新分层链路不同，是后续真实验收的历史风险，未在本轮扩展修复范围。

## 交付边界与下次起点

两个功能的源码迁移和本地检查已完成，交付目标仅为公司同一仓库的 `devUpdate1012` 分支，按正常 commit / push 流程发布源码。最终提交与远端匹配结果以分支 Git 记录和 `D:/coding/.novart-tmp/devUpdate1012-delivery-20261013.json` 为准；本日志不填写自身提交 SHA。

保留分支已有 `AGENTS.md`、`CLAUDE.md`、普通推送钩子及历史文档策略失效提示。未修改 main、CDS 配置、共享业务数据和旧目录。未复制任何私有配置；生成物、依赖环境和本地验证日志不纳入 Git。

本轮没有运行真实模型、业务数据库迁移或 CDS 操作；自动工作流是否成功不从本地结果推断。下一次从 `D:/coding/公司/brandai-devUpdate1012` 继续，先在批准使用的隔离环境应用两份 additive migration，再用真实账号验收品牌知识持久化和一张图片的真实 AI 分层，随后按用户安排推进管理页、识别/手册解析等后续优先级。
