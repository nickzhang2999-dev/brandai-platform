# Novart 开发日志 · 2026-10-11

## 请求最新版CDS预览：补齐遗漏的真实UI图片检查

本轮实际读回确认f97/run38144791349已失败，未生成发布镜像。真实后端95项通过；首页真实上传/新会话恢复、空项目、指针中文历史入库和草稿离页恢复通过。确切失败在verify-studio-ui.ts:353仍用filter内的`img[src]`，期望1却找到0。诊断显示上传SUCCEEDED、jobcompleted、原素材存在、文档PUT200，network/browser errors为空；此次原错误已正确记录，不能归成上传后端故障。

上一轮只修直接img locator，漏了模板字符串中的353、362、420三处。现已统一改为对象wrapper内SVG image/href精确身份，插入后真实解码；原撤销重做0/1、离页不重复插图、48×32、bytes/SHA、120秒和provider次数检查全部保留。全文件/AST排查无旧图片选择器，本机Chrome提取实际源码选择器的匹配/尺寸/撤销/返页/错误href拒绝检查通过；此局部仍不是新版本真实后端验收，不调用provider。

重复本地L1 989、Windows同项目AI365通过。首次普通类型检查因本机Node内存分配失败退出134，随后以现有jitless/768MiB/小semi-space方式完整typecheck退出0，保留首次失败；没有修改系统内存/网络设置或启动Docker。生产构建现已exit0，运行画布16源码冻结保持一致；待新SHA云端真实栈与镜像验收。公司main/共享资源及四处原dirty保持，当前独立公网仍为55e。

## 用户要求再次推送：已成功，云端验收进行中

最新修正提交 `f97ecb6a8b26bc353b14f16905f899f1b7925d79` 已经成功推送，包含同一批新增工具和SVG图片/诊断生命周期验收修正。新[Branch Image38144791349](https://github.com/nickzhang2999-dev/brandai-platform/actions/runs/38144791349)自动开始，backend job114485769853；适配、页面协议已通过，实际React交互进行中。线上仍为55e，尚未更新应用镜像；失败的38143196104保留，不重新标为通过。

f97实际CDS签名回执 `965d5a45-0192-4def-a680-ba8a17cb30d9` 已确认signatureValid=true、dispatchAction=skipped、skipMarkerConfirmed=true；新before/after dry-run和公司3分支/最近部署对照通过，引用新SHA的公司部署0。第一次只读回执查询安静退出1，安全HTTP状态重读后通过，未重新推送或部署；结果文件`product-real-push-receipt-f97ecb6-retry.json`保留。

用户在外部浏览器打开GitHub后要求重试。检查发现Windows系统代理启用，而Git未配置或继承代理；仅为本次Git命令使用现有本机系统代理，未修改全局Git/网络设置、证书校验或浏览器凭据。推送退出0：远端整合分支由55e07ac前进到 `1d6754dbf8620db0671dd1b2387a2438549eb3e1`，GitHub连接GET已核对相同HEAD。旧失败和备用连接403记录保留，浏览器登录本身不等同于Git写权限。

推送前后官方push/workflow dry-run均通过，实际CDS签名投递回执 `d3b17c1c-533f-44ec-aa31-5cfb9f839d11` 为signatureValid=true、dispatchAction=skipped，skip marker确认。公司三分支注册/CI快照保持一致，最近部署记录无本次SHA；独立产品仍运行55e，未因推送自动发布。

GitHub Branch Image精确SHA流水线[38143196104](https://github.com/nickzhang2999-dev/brandai-platform/actions/runs/38143196104)，product/backend job114481081872，最终失败在真实UI阶段。owned适配、工作台/protocol、实际React画布交互、DB迁移、独立临时存储和完整仓库门禁均通过；真实后端95项通过。镜像构建、复验与发布全部skipped，没有部署候选或付费模型调用。

日志首个可见错误为BullMQ初始化Redis时的 `Stream isn't writeable and enableOfflineQueue options is false`。源码另确认真实UI脚本255/271/272/411仍寻找旧img/src/HTMLImageElement尺寸，而新画布已使用SVG image/href；失败诊断助手在可能为空的上传集合上创建Queue后先disconnect Redis，可能让未完成的INFO初始化错误覆盖原UI断言。该关联链是源码推断，不把它冒充日志已确认的唯一根因；目前修验收的图片选择器/真实解码和诊断生命周期，保留SHA/尺寸/重开/上传120秒门禁，不修改生产queue。

修正完成：`apps/web/scripts/verify-studio-ui.ts`对SVG image的href检查后，以相同href真实decode并核对自然尺寸；首页及全新会话继续48×32，最终重开所有图片都解码。纯数据模型只接受认识的v1/v2并通过可写验证；未知版本/关系不放行。空上传诊断不创建Redis，非空诊断先awaitQueue.waitUntilReady，再查询，Queue关闭后才disconnectRedis，原2秒连接/命令及120秒上传期限不变。

修正本地验证：隔离实际Chrome的SVG解码/错误尺寸拒绝/新页面重开3项通过，AST抽取诊断的空集合/正常生命周期/ready失败记录3项通过；这些不是实际后端验收。L1再次989、同项目WindowsAI365、完整Web类型检查、生产构建exit0。运行画布16个源码与先前49项实际交互冻结完全一致，仅修验收脚本，尚需新SHA重新执行真实栈及镜像门禁。

本段是最新状态，后面“推送失败”保留此前时点事实。恢复的是代码上传通道；新增工具是否上线仍以该SHA完整CI、独立部署和公网实际验收为准。

## 自研画布工具补齐（本地完成，发布待执行）

用户明确授权补齐对象复制、右键操作、文字排版、图片裁切翻转、对齐组合、图层显隐锁定排序、橡皮擦和直线箭头，以及画框联动和局部导出。三个子智能体分工实现数据模型／纯操作、渲染导出和交互 UI；主任务接通真实图片替换、后端效果边界和浏览器检查。

当前确认：基础对象保持旧版兼容，只有使用扩展工具的对象升级 owned v2。裁切使用原图归一化区域，图片身份与鉴权素材 URL 保留；翻转、文字属性、逻辑分组、平面坐标画框关系、显隐锁定随文档保存。屏幕与导出共用字体／图像／箭头计算；隐藏图层排除，锁定图层仍可导出。已有裁切与翻转、旋转画框裁边的真实像素检查。

新增隐藏图层／隐藏画框祖先检查接在服务端工作流和 EXACT／整图修改守卫；旧引用保留并显示不可用原因。现有后端尚未合并裁切效果的 AI 操作继续明确拒绝，不把显示裁切静默当成完整原图。图片替换通过真实上传任务和解码回执返回，不在前端伪造持久素材。

最终检查结果：

| 检查 | 结果 | 证明范围 |
| --- | --- | --- |
| 仓库 `pnpm test` | 989通过（contracts965 + UI24） | 模型、服务守卫、操作和导出回归 |
| AI完整pytest | 365通过 | Windows同一项目虚拟环境；没有模型调用 |
| Web typecheck | exit0 | 完整类型检查 |
| Web生产build | exit0 | 实际Next生产构建；不是运行后端验收 |
| 独立实际Chromium | 49项通过，pageerror/外部请求0 | 真实React/指针/键盘/拖拽/上传选择/菜单/下载；loopback合成API |
| 最终源码冻结 | 16个源码/测试文件哈希未变化 | 最后门禁与最终浏览器对应相同源码 |

Windows的 `pnpm test:ai` 因POSIX `.venv/bin/python` 被cmd拒绝，保留首次失败；使用同一项目 `.venv/Scripts/python.exe -m pytest -q` 完整365项通过，不宣称原命令通过。build使用已存在的显式低内存模式（每Node old-space768MiB），依然警告本机Redis不可用和url.parse弃用；独立类型检查已执行，构建成功不证明真实DB/Redis可用。

### 工具检查与修正

- 增加13项新工具交互，在原36项之上合计49项。覆盖连续两次粘贴ID不冲突、图片替换及撤销、中文排版、裁切翻转、组框联动、对齐、整笔擦除、图层拖放显隐锁定、保存刷新以及选区/画框导出。
- 实际修正连续粘贴沿用旧ID和画框背景盖住内容的风险；画框导出除PNG/SVG像素一致还必须有非空内部像素，避免两份空图误通过。
- 第一次默认Playwright浏览器文件不存在，改用本机已安装Chrome独立headless运行，不下载浏览器、不调用Computer Use。原失败报告保留。
- 最终强化轮曾在“撤销粘贴已清空选中”后直接CtrlD，属于测试前提遗漏；补显式重新选择原对象后13项和全49项均通过，未删除断言。相关false报告保留，不把它说成重复粘贴产品失败。
- 模型补极小裁切值造成除法Infinity/过大尺寸的保护，并增加两项边界回归。图片替换保留持久上传任务及原图身份，成功后单次可撤销应用；待确认时不会静默换图。
- 橡皮擦当前删除整条笔迹；字体为三种本机族。高级旧容器/未知效果仍只读保护，裁切AI语义未支持时仍明确拒绝。这些边界不能算全部复杂编辑能力已恢复。

最终报告：`D:/coding/.novart-tmp/owned-canvas-full-tools-20261011-final2.json`，`passed=true`、checks49、`realBackend=false`、`realProvider=false`。冻结证明：`owned-canvas-tools-source-final-freeze-20261011.json`。原环境失败及测试前提失败报告原样保留。

本批尚未推送或发布，没有模型调用或公司共享资源写入。线上仍是之前已验证的55e核心版。CDS本轮GET-only回读确认独立project98的Web/AI/Worker均为预构建镜像，Garage及两块卷、PG/Redis独立卷可沿用，effective入口为/studio、readiness为/login。只更新应用镜像不需要重新导入存储配置或复制模型密钥。

距CDS交付仍有三道检查：1）准确新提交带 `[skip cds]`，先跑官方push/workflow dry-run，再核对实际签名投递和公司分支快照；2）该SHA云端一次性DB/S3/Worker/实际页面、构建镜像复验通过并发布已验证镜像；3）只部署独立项目98，回读运行SHA后实际登录验新工具、保存重开和局部导出。此记录不是新批次上线证明，不重复之前唯一一次付费生图。

### 提交与推送实际状态

工具及日志已形成本地提交 `1d6754dbf8620db0671dd1b2387a2438549eb3e1`（`[skip cds] Complete owned canvas tools and scoped exports`）。提交前16个测试源码与冻结哈希一致，四处原有共享dirty字节不变；需求归因表只提交新增70行，既有63行仍未暂存。

官方新SHA push/workflow self-test通过：push为ignored-skip-marker，workflow为workflow-acknowledged，deploy/stop/comment副作用均false；公司三分支快照保持原状态。实际Git推送连续三次失败，两次Recv failure: Connection was reset，第三次无法连接github.com:443；已读回远端分支仍为55e07ac。备用GitHub连接的Git tree写请求返回HTTP403 Resource not accessible by integration，未更新远端分支。此为本机网络和备用连接写权限问题，尚未进入CDS部署，不能记为CDS平台构建故障。

当前云端新SHA流水线数量0、部署0、付费调用0；没有实际新push回执可验。恢复Git传输或提供具备仓库contents写权限的连接后，仍须先重新确认新提交与skip隔离，再执行云端镜像/真实栈门禁和独立发布。旧可用核心版保持运行。失败记录不作成功发布凭据。

## 新版产品入口纠正

用户打开交付链接后看到公司原版页面，反馈属实。此前发出的链接是裸 `/login`，而 `apps/web/src/app/login/page.tsx` 在缺少 callback 时默认返回 `/`；根页面仍保留公司原版首页。已评审的新工作台在 `/studio`，此前的交付链接没有进入它。

正确入口：[新版 Novart Studio](https://novart-product-integration-claude-novart-product-integration.geole.me/studio#/home)。匿名访问 `/studio` 的登录 callback 由 middleware 保留；不要把缺少 callback 的裸登录页当作新版产品入口。

已完成的修正：

- 官方 CDS 分支 `web-entry-config` 已将独立项目 `98cfea6cdcbd` 的 Web 入口从 `/login` 改为 `/studio`，读回的 effective path 和 URL 一致。AI/Worker 入口配置不变。
- 本机 `deploy/novart/cds-compose.yml` 的 `cds.web-entry-path` 改为 `/studio`；readiness 探针仍为 `/login`。只改入口标签，不修改服务环境、启动命令、图片模型或共享资源。
- README 与整合进度补充当前正确入口；较早日志保留历史状态。

配置前后回执保存在受保护控制目录的 `studio-entry-fix-20261010.json`，原始 recordedAt 为 `2026-10-10T18:26:58+08:00`，不改写该时间或历史证据。本日志按当前客户端日期记录。

本次没有应用部署、业务写入或模型调用，线上仍为已验证的 `55e07ac`。源码标签及文档修改仅保存在本机，未新增推送。裸 `/login` 的默认跳转行为未被修改；当前修正依靠独立 CDS 入口和明确的 `/studio` 链接。

### 验证与边界

官方入口配置本轮只读回查为 HTTP 200，effective path 和 URL 仍为 `/studio`。独立 compose 与 HEAD 的结构化比较已通过，确认只改变入口标签，readiness、环境和启动命令不变。

独立 Chromium 的实际入口检查已确认：输入 `/login?callbackUrl=%2Fstudio`，不固定 workspace 参数；实际密码登录 HTTP 200，跳转 `/studio` HTTP 200。工作台随后将服务端选定的品牌写入 URL；新版 `NovartStudio.snapshot().homeStart.loaded` 为 true，`#ns-home-brief`、`#ns-create` 均可见。记录四项检查通过，只有一次认证 POST，业务写入、模型调用、外部请求、pageerror 均为 0。

报告：`D:/coding/.novart-tmp/studio-entry-readonly-report-v2-20261011.json`。该报告在最后一个额外 session 读取阶段记录 `READONLY_ENTRY_CHECK_FAILED`，整体 `passed=false` 保留不改。前四项支持“实际登录回跳和新版首页可见”的限定结论，不能把整份报告写成全部通过；额外 session 检查的失败另留待定位。入口修正不替代之前的核心业务验收。

归因：交付链接和独立项目入口配置错误。此项不属于已记录的四项 CDS 平台源码故障，也不说明已验收的上传、生成、保存恢复链路失效。
