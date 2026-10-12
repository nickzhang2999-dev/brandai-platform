## 本次产品整合分支检查

用户确认最新工作分支是 `claude/novart-product-integration`，要求检查代码、与main的冲突，并在可合并时合并推送，不再使用跳过CDS标记。fresh fetch：main `0fbdfd2cbce4e427bf0901fe9a6b35ce160a4e63`，integration `74e2db2513406027328e7bd13985791f112134e1`，共同祖先 `4b88be6fd340bc090e02ca9bec1f562bb0ba42a0`。

integration独有的 `a88bb58`、`ace6d71`、`74e2db2` 均为文档提交，合计4文件84行新增/6行删除；没有新的应用、迁移、依赖或构建代码。其全部业务实现已包含在main中。本轮实际合并只有README的进度说明冲突；两边历史证据保留，当前自动预览配置和本轮检查放在最前。其余3文件自动合并。代码内容保持当前已验证版本，历史提交中的跳过标记不改写，新合并提交不加该标记。

## 当前构建结果与 CDS 回执

`0fbdfd2cbce4e427bf0901fe9a6b35ce160a4e63` 的基础 CI `38226429370`、完整镜像流水线 `38226429393` 均 completed/success；后者于09:03:35Z完成。实际日志确认源码与构建后容器两轮各后端95、真实页面17项通过，AI365通过，镜像发布完成。本次整合仅修改文档，应用、依赖、迁移与工作流和该已验证提交相同。

CDS 已收到0fb的真实签名push，但仍在等待构建通知。GitHub公开 App API实际返回 `cds-geole-preview`（4096637）的订阅为 check_run、delete、issue_comment、pull_request、push、release、repository，没有 workflow_run；权限也没有 Actions。CDS回执记录仅见push，没有对应构建完成事件。恢复后续全自动预览需要该App管理员配置 Actions只读权限及workflow_run订阅。本轮没有修改全局App或CDS平台代码，没有伪造webhook。

官方 `branch claim-prebuilt --dry-run` 验证完整0fb和成功流水线后，通过同一命令的 `--deploy` 完成本次预览恢复。运行 `dr_7778a5ecbd870c5300eca7ed` 于09:10:51Z进入complete/running；三服务全部running，实际镜像均为完整0fb标签。公网 `/studio` 返回307到带正确callback的登录页，`/api/health` 返回200，Web/AI/Worker均ok，Worker报告提交0fbdfd2cbce4、原队列brandai-main和12消费者。日志确认原33迁移全部已应用，没有待执行迁移。首次Python公网读请求超时，后续独立curl实际入口和健康检查通过；不掩盖原网络失败，也不将配置成功或单次恢复写成全自动链路已恢复。Worker仍有原镜像内缺少git导致的源码轮询日志，当前队列健康，未为此改变镜像构建。

## 本次 main 推送与云端验收补充

合并提交 `449979caa3cfcc4dda3031bd6b6a282c2a5a70d6` 已推送 main，父提交为 `4b88be6` 与 `d82e7c2`；CDS 自动收到推送并将 CI 目标设为同一 SHA。普通 CI `38225525918` 成功，产品构建 `38225525967` 在真实 UI 检查中失败，未发布新镜像，旧预览继续运行。

失败证据：后端95项通过，UI前12项（登录、首页带图、服务端恢复、画布编辑、上传、用途持久化和导出）通过；新浏览器登录时停留裸 `/login`，邮箱为空且未发出认证 POST。原测试只等待 DOMContentLoaded，在冷页面 React 接管表单之前即可填写/原生提交，丢失受控输入和 callback。修正仅让测试先等待页面 useEffect 发起的 `/api/auth/providers` 返回200，再经原密码表单登录；没有复用 cookie、跳过权限或删除恢复/导出断言。后续完整流水线结果另记，不将该失败宣称为自动预览已完成。

# 2026-10-12 · 预览分支合并验证

用户明确要求将 `claude/novart-workbench-preview` 合并到 main。父版本为 main `4b88be6fd340bc090e02ca9bec1f562bb0ba42a0` 与预览 `d82e7c2843f417fde73558ebc2df493b21d732f6`。处理工作流、网关、包清单及历史文档共八处文本冲突，以用户指定的预览分支功能为准。独立评审网关使用预览侧完整来源校验、诊断和入口桥接；main 已有产品后端及自研画布保持兼容，工作流保留 main 自动构建入口并纳入预览新增检查。

共享运行时存在无文本冲突的兼容问题：预览侧新增原生授权改写后，产品导出会再次改写同一模块并提前注入空配置。本次新增显式编译选项，独立评审默认行为不变；产品导出保留单次改写及认证启动配置，并增加真实 loopback 资源回归。

已完成验证：L1 1000（contracts 976 + UI 24）、AI pytest 365、Web typecheck、生产 build；产品资源导出124项；预览 Origin 18、启动诊断10、许可配置13、入口跳转9、产品许可4；包清单173项；首页11、画布就绪24、产品启动18、归档6、首页交接11及诊断/许可JS检查。构建有本机Redis未运行的连接提示，最终退出码0，不将此结果视作业务环境验收。

首次自研画布浏览器回归通过前36项，在复制图片检查失败；既有测试固定使用 Control+C/V，本次执行平台为 macOS，未产生原生剪贴板事件。产品画布代码与 main 完全一致。测试快捷键改为 Playwright 的 ControlOrMeta，保持所有断言和测试步骤，重跑49项全部通过；原失败报告保留于本机 /tmp/novart-merge-owned-browser.json。

浏览器实测：自研画布49项重跑通过，预览画布本地HTTP及两种HTTPS授权拒绝场景共3项通过。收到用户关于CDS原生构建和以新分区为准的补充要求后暂停提交与推送；本地仍为合并草稿，远程main未修改。本次无生产数据库操作、真实模型调用或正式站发布。


## CDS 自动预览检查与修复

用户进一步明确，“构建交给 CDS”是保留原有使用方式：推送后自动构建/预览，正式站仍在 CDS 点击发布；不是删除仓库标准构建命令、启动脚本或测试流水线。本轮没有更换根 compose、Web/Worker 启动脚本或原有源码构建模式。

实际只读检查：公司项目 `a8a098f7193a` 的 `githubAutoDeploy=true`、push 事件启用；近期历史提交带 `[skip cds]`，main 的 Web、Worker、AI 模式与分支镜像覆盖固定在 `4b88be6`，因此即便新 CI 成功也不能靠现有固定配置更新到新镜像。用户明确批准一次性恢复自动预览。

配置修复：保留 main 选中的预构建模式及启动命令，把模式镜像改为 `sha-${CDS_COMMIT_SHA}`，由 CDS 按成功构建的 `ciTargetSha` 解析；删除重复固定镜像覆盖。CDS 分支覆盖字段不支持模板，模板放在支持该能力的部署模式中。更新分支覆盖时接口丢弃传入的 `webEntry`，已通过正式 `web-entry-config` 接口恢复原入口并回读一致。三服务命令、环境、dev/release 模式与修改前相同；无新部署、业务数据写入或正式发布。非敏感变更证据见 `cds-main-auto-preview-2026-10-12.json`。本次合并提交不带跳过 CDS 标记，后续记录实际自动流水线与预览结果。

---

# Novart 开发日志 · 2026-10-12

## 最新收尾：main 专用账号与画布真实验收完成；正式发布仍被目录校验阻断

用户随后明确要求“帮我搞个账号”。通过已授权项目级操作一次性创建 main 预览专用普通用户，`isAdmin=false`，并在真实登录后通过正式工作区 API 创建其独立测试品牌；没有重置旧账号、开放注册或修改管理员名单。凭据仅在 Git ignored 的 `.cds` 本地私密文件中，不写入日志、提交或公开回复。

首次公司 main 的新建项目操作未通过，原失败报告保留。只读检查确认新品牌 `Project=0`、`WorkbenchProjectState=0`、受理 creationKey=0，并发现运行配置的 `AUTH_URL` 与 main 公网 origin 不一致。这是环境适配问题，不是密码错误或项目被吞。仅修改 Web 新增的 `novart-verified-4b88` 启动命令，在启动 Next 时显式设置真实 main 的公开 origin；旧 dev/release、项目环境桶、镜像、登录密钥与其他分支未改。来源验证仍然严格执行，没有接受任意 Origin。

同一固定4b88镜像于 **07:04:51Z** 再部署完成，run `dr_df058efa5e47ab986436e9c3`。三容器完整 SHA 与 CI digest 保持；实际 Next 进程的 AUTH_URL 匹配 main，原六项环境指纹保持，可信资源清单及 bootstrap/worker bytes 未变。初次以 Docker exec 新进程读取 AUTH_URL 的 false 留档；exec 不继承 Next 启动时的 export，后续按 `/proc` 核实际唯一 Next 服务进程，不能将测量口径差异误报为修复失败。

**公司 main 的真实 UI 验收现已通过13项。** 使用隔离 headless Chrome 和真实账号/API：新建1项目、中文文字与笔迹、文字样式/重复粘贴、对齐/组合/移动/取消组合、线条/箭头、笔迹擦除与撤销重做、画框内容随动、图层隐藏显示/锁定解锁、自动保存、重新登录恢复、真实 SVG/PNG 下载及恢复前后像素一致。工具栏同一DOM连续15.304秒未消失，revision20的7对象与checksum重开后相同；真实受理创建1、文档保存20，页面错误/异常阻断/外域请求均0。不是独立98测试项目，也没有替换页面源码。

最终只读数据审计通过：明确排除本次新作用域后原12核心表数量及内容 checksum 全等部署前；新增 User/BrandWorkspace/Membership/Project 各1及 EditorDocument1，非管理员账号不在实际 admin allowlist。AppSetting整行和原六项环境指纹保持；本次新品牌素材、生成记录、上传任务和生成请求全0。原公司业务数据没有被覆盖。

**main 主列表看到旧版仍是入口按钮问题。** 当前 CDS 真实 `BranchListPage-CKTFpzMd.js` 主按钮链不读取 `previewUrl/previewEntries`，使用 `previewUrl-Cu1wGG_9.js` 的 m/s 导出拼裸域名，丢弃 `/studio`；此前“drawer/helper会保留路径”不证明主按钮正确。原生命令和详情入口返回完整 `https://main-brandai-platform.geole.me/studio`。产品 `/` 的旧首页仍保留，新工作台在 `/studio`；本轮没有发布CDS平台代码或改产品默认根路由，交付应明确使用完整链接。

正式预检仍认出完整4b88产物，但生产 target 的非Git目录尚未纠正；未调用正式release。真实AI修改、main环境新上传/付费生成、P0/P1/P2未在本轮提前验收。产品源码与冻结16文件未变，本批补日志及运行适配，测试调用模型0、本机Docker0。

最新证据：`company-main-review-account-1791788272614270500.json`、`company-main-session-1791788325002.json`、`company-main-create-origin-1791788570090420900.json`、`company-main-origin-fix-1791788693680726000.json`、`trusted-manifest-main-4b88-origin-fixed-proc-1791788889346287800.json`、`company-main-owned-tools-20261012-2c2b3ca0-a8d3-4bfc-9602-2718a54e076a.json`、`company-main-core-after-review-execute-1791788963189945600.json`，均在本机 `.novart-tmp`。下节“账号UI待补”为开账号前的实际历史状态，以本节更新。

## 最新：公司 main 已部署新版；账号验收与正式发布仍有配置阻塞

用户授权“更新一下，然后正式发布”，并询问能否使用本地源码。本地源码已经正常合入 main，并使用 main 完整 CI `38209036689` 发布的不可变镜像；不需要 CDS 平台源码。主分支于 **2026-10-12 06:40:25Z** 完成部署，run `dr_e4915a56693c53a5c4d379c3`，完整提交 `4b88be6fd340bc090e02ca9bec1f562bb0ba42a0`。

- 公司三个 profile 保留原 dev/release 模式及其他设置，新增 `novart-verified-4b88`；仅 main 分支切换到该模式。Web/Worker 使用同一经 CI 验证的 Web digest，AI 使用对应 AI digest。没有执行旧 Web 的 seed/db push。Worker 在启动消费者前执行受 advisory lock 保护的 migrate deploy。
- 部署后 Web/Worker/AI 镜像及容器环境完整 SHA 均匹配。原 30 份迁移 checksum 全部核对后，只应用 3 份尚未执行的增量；最终 33 份逐一匹配该提交的 SQL，全部完成且无回滚记录。
- 在任何业务写入前，12 张原核心表数量及内容 checksum 均与部署前一致。数据库身份、登录与设置加密材料、Redis 等六项环境指纹保持；Worker 实际队列前缀仍为 `brandai-main`。不使用独立产品环境的队列或测试项目。
- 主分支 Web 入口使用已验证原生 PUT 合同改为 `/studio`，分支作用域，其他服务入口不变，不需再部署。官方读回地址为 `https://main-brandai-platform.geole.me/studio`；入口配置不等于裸根 `/` 自动跳转，也不冒称实际按钮点击验收完成。
- 公网 bootstrap/worker 实际文件与本次容器 manifest 匹配；bootstrap 主体匹配 Git 4b88 源码，未替换浏览器源文件。匿名 `/studio` 正确 307 到登录页。

**公司 main 的登录后 UI 验收没有通过。** 两次使用此前提供资料的诊断及一次按用户新提供密码大小写修正后的实际登录均被拒绝，失败报告保留。只读检查证明该用户在 main 预览数据库不存在，注册关闭、管理员 allowlist 已配置；不能将此归因于新密码不正确或自动创建管理员。没有重置密码、开放注册、绕过登录或搬运独立98账号/项目。画布操作、保存重开和导出在 main 的真实账号验收仍待补，独立产品已通过的记录不代替本环境。

**正式站没有发布新版。** 新预检 `pfl_487c80edc6a34a84`，HTTP200/4.797秒，artifact 已绑定完整4b88和真实 `/studio` 地址；branch/commit/artifact/SSH/脚本存在/历史回滚均 pass。唯一 blocking 仍是正式 target `brandai-novartlab-local-prod` 的 `/opt/brandai-platform-prod` 不是 Git 仓库。脚本存在不代表已核对其内容和镜像消费/数据卷合同。项目当前无可证实已注册的本机产物正式发布策略，不能把 CDS 克隆目录猜成生产目录或跳过校验；没有修改正式 target 或调用正式 release。

本批产品源码没有变化，无业务写、额外模型调用或本机 Docker。真实待办：提供/开通合法 main 预览账号完成 UI 验收；维护人确认生产 Git 根及发布脚本、保留生产资源和回滚方案，再通过正式预检后发布。

本机脱敏证据均在 `.novart-tmp`：`company-main-runtime-execute-4b88-1791787395706999800.json`、`trusted-manifest-main-4b88-1791787494235542100.json`、`company-main-studio-entry-1791787524967618500.json`、`company-main-public-sources-1791787909887.json`、`company-main-session-1791787813108.json`、`company-main-auth-capabilities-1791787760282042700.json`、`formal-main-4b88-preflight-current-1791787734698477300.json`。早前“公司运行未变”属于源码合并时状态，由本节实际获权部署结果更新。

## 实际合并 main：4b88，保留原运行环境

2026-10-12 05:41Z，通过一次正常、非force的原子push，将main从 `e99919a64cd212d5d1b083fd7210842a1962d935` 快进至 `4b88be6fd340bc090e02ca9bec1f562bb0ba42a0`，同时推进整合分支55ff→4b88。实际 `git ls-remote` 两固定refs均读回完整4b88。提交前完整SHA的main/integration push与workflow_run共四项官方dry-run均200，deploy/stop/comment副作用均false；真实两条签名push回执分别于05:41:20.943Z及05:41:19.929Z记录skipped和skip marker。

公司三分支lastDeploymentRunId、运行服务状态/镜像/模式、profile overrides、profiles及共享infra配置均保持。CDS非live视图的githubCommitSha仍为旧缓存值；不能将该字段误当Git远端未推进，也不为刷新它触发公司部署。初版报告因要求CDS缓存值推进而false，保持原文件；最终报告分别引用真实远端GET与signed skip/运行配置GET，所有对应断言通过。

main基础CI `38209036645` 已整轮completed/success，实际日志L1 1000（UI24+contracts976）、AI365、完整Web类型和生产构建通过。main镜像流水线 `38209036689` 与product job `114678852637` 也已整轮completed/success：步骤16–23及post42–47全成功，preview按分支条件skipped。原始日志确认源码及构建后容器两轮各API95/UI17，摘要检查及禁用Service Worker恢复两轮通过，启动回归18通过；React步骤成功但未打印数量，不编造计数。web/ai/storage三镜像以完整sha-4b88发布且实际digest已记录，额外provider调用0。integration对照 `38209035926` 成功单列，不替代main终态。下列早前“main尚未push”记录保留为当时状态。

55ff→4b88精确仅2份workflow和4份文档，产品运行源码、迁移、镜像构建源码未变。四项受保护文件与16项冻结文件实际哈希全部保持；独立预览仍运行已验收55ff，不冒称运行镜像已变4b88。正式目标目录非Git的实际阻断仍保留，没有正式release请求，也没有把GitHub仓库URL当远端Git目录。仅将后续验收事实写入整合分支文档，main保持核心不可变版本。

本机安全证据：`.novart-tmp/main-core-push-selftests-1791783595594751700.json`、`main-core-push-final-evidence-4b88-1791783859324228400.json`、`main-source-runtime-correspondence-4b88be6-20261012.json`、`main-ci-4b88be6-20261012.json`、`product-startup-ci-main-4b88be6-20261012.json`。主干镜像CI报告SHA256 `da0f72da367a11a2c893f7f198b6a8679e107a0fc345de601391a31dde07e94a`。没有额外模型调用；CDS旧false及历史文档差异原记录均保留。

## 后续实际更新：公网启动六项通过，核心准备合并

独立55ff部署后，三种真实浏览器模式共6项通过：普通首次进入、暖启动、旧CDS入口3项；完全禁用Service Worker 1项；已有activated Worker但controller为空时强制刷新、网络旁路2项。每项工具栏持续稳定10.302–10.315秒，实际加载bootstrap均严格匹配部署容器摘要、55ff源码与76项资源映射。应用未注册或等待Service Worker；没有替换线上源码。三模式各实际登录一次，业务写入、额外模型调用、页面异常均为0。

文档验收范围是当前revision28、8条记录、7个图形、6个ownedV2对象，打开前后revision及checksum不变。旧revision20基线首次检查因文档内容已变化而保留失败；当前文档更新时间04:32:47Z早于55ff部署完成05:10:25Z，不据此推断是谁修改或为何修改。原私密基线未覆盖，另建只读当前基线，也不宣称历史文档保持不变。

本机C盘可用空间实测为0，导致部分隔离Chromium启动失败。仅把验收进程TEMP/TMP设到已核对的D盘临时目录后完成检查，未删除用户文件、修改系统环境或控制用户浏览器。这是本机测试环境问题，不记为CDS服务器故障。

安全汇总：本机 `.novart-tmp/public-bootstrap-55ffda3-acceptance-summary-20261012.json`，SHA256 `82e49e3187219bc6400a02a199ef568d3eabf53d977dc836340047af42126b50`。源码、工作流和已完成本地四项必需门禁未变；本批只补文档，最终核心提交的main推送、签名跳过回执及云端CI待实际完成后追加。正式站仍受非Git目录阻断，没有触发正式发布。下段保留早前逐项待验状态，最新公网结果以本节为准。

## 后续实际更新：55ff独立部署与预检归因纠正

精确 `55ffda3e29f40fba14e7fd78d4bddf39302e5d6f` 的独立部署 run `dr_748b9d7e343e16a9efc616ff` 于 **2026-10-12 05:10:25.528Z** 完成。`runtime-receipt.json` 的 `ok=true`，Web/AI/Worker三镜像及环境 fullSHA已核对；Garage保留固定55e镜像和原双卷，healthy，公司部署前后七字段不变，providerCalls=0。实际 runtime/入口通过，不等于三种公网浏览器场景已通过；普通、暖启动和禁用worker仍待逐项实测。

实际容器 manifest 的 bootstrap SHA256 为 `4cd3d71103631a1a4405d5c3dcfa5f85615fcb2481bf66a347ab2a65b4456456`，本地编译值为 `7881b04b01d1cc951f2c5f29ddbb9aa4fbc28cd823894d46f1b315fa8d6dbf7d`。差异来自资产映射对象key顺序；公网资源正文、源码主体及语义映射已严格匹配真实部署来源，并以部署容器manifest作摘要权威，未替换公网源脚本。不能以本地整文件摘要不同直接认定旧代码仍在运行，也不能跳过实际manifest/正文验证。

连接卡住归因已纠正：诊断/发布helper的 `ProxyHandler({})` 强制直连，绕过用户已启用的Windows代理。复用已有代理且保留HTTPS Host/SNI/TLS后，公司GET实测2.25秒，项目/配置GET约2.5/2.9秒，main与feature共四项dry-run成功；未改系统代理、hosts或全局设置。此前直连/H2超时记录保留，不能再笼统记成CDS服务器bug。公网runtime首次urllib默认UA403/CF1010，后续curl UA200并完成新runtime报告；原failure未覆盖，不据此判断所有浏览器访问均失败。

正式预检最初artifact fail来自小克诊断请求遗漏previewUrl，非已证明的镜像缺失。补入官方branch preview URL后，最新正式preflight HTTP200（5.062秒）：artifact pass，SSH/脚本/health/rollback pass，唯一blocking为remote-repository fail（`/opt/brandai-platform-prod`不是Git根目录），project-identity为旧target身份快照warn。公司gitRepoUrl/githubRepoFullName绑定核对正确。未更改target或触发正式release。

公司Web profile的release命令包含明确seed与db push，源码配置如实记录；本轮未改也未执行。该CDS profile命令不能等同于尚未读到内容的正式SSH `./cds-release-novartlab.sh`，不据此宣称正式脚本已确认安全迁移/资源生成。正式脚本及远端目录仍需后续核对。

main流水线候选 `9dcc11ad403c36cb7f6f896faa0222ddb8231c94` 已准备且本地L1 1000（Turbo缓存重放）/Windows AI365/完整typecheck/production build退出0，原preview job与backend全部21steps保持，四dirty与16冻结文件哈希不变。此时尚未push main，未正式发布；后续main精确SHA云端CI与公网三模式按真实结果再追加，不提前勾完成。

本段证据来自本机 `.novart-tmp/release-product-startup-55ffda3e29f40fba14e7fd78d4bddf39302e5d6f/runtime-receipt.json`、`deploy-receipt.json`、`runtime-bootstrap-55ffda3-20261012.json`、`cds-existing-proxy-read-1791781506232204200.json`、`company-proxy-release-audit-1791781814409663800.json`、`formal-preflight-1791781862871253400.json`。旧timeout、UA403及浏览器false报告保持；下列记录为早前冻结状态。

## 核心 main 合并准备与正式发布预检

用户确认先合并已验证核心，后续 P0 依次为完整品牌知识、识别/手册解析、用户管理；采用同域 `/manage/login` 独立管理入口。P1 蒙版/分层，P2 Campaign Kit、模板素材库，审核运营待排期。范围和验收见 `novart-main-release-plan-2026-10-12.md`，本批没有实现或提前计入这些 P0。

`55ffda3e29f40fba14e7fd78d4bddf39302e5d6f` 已推至整合分支。[完整CI38203197224](https://github.com/nickzhang2999-dev/brandai-platform/actions/runs/38203197224)成功，job114660880889 所有门禁、源码及镜像内API95/UI17、启动生命周期18、镜像发布通过，真实模型调用0。此前“尚未推送/云验收未运行”为历史状态，由本节更新；55ff未部署。

fresh fetch main仍 `e99919a64cd212d5d1b083fd7210842a1962d935`，为55ff共同祖先，38/0可快进。审查发现原公司启动链不生成新Studio manifest，专用CI两层条件也排除main。本批只改两个workflow：允许main运行原完整编译、源码及镜像验收和完整SHA镜像发布，补Novart脚本/`.npmrc`的触发路径。原preview job、backend全部设置及21步骤保持，未改公司compose/profile、数据库、Worker或模型配置。docs-only不自动构建；手动选择main可构建当时HEAD，未支持任意历史SHA。

本批顺序门禁全部退出0：L1 1000（976+24，Turbo缓存重放）、现有Windows venv AI365/1warning实跑、完整typecheck、productionbuild。四项原dirty和16个冻结文件前后SHA256相同，证据 `main-pipeline-gates-20261012-summary.json`。五个新增迁移为增表/增列/索引，但仍须核对正式迁移账本，避免旧P3005逻辑把新增表误登记已应用；新Worker不能先于迁移就绪。

正式控制面确认项目a8、目标 `brandai-novartlab-local-prod`、目录 `/opt/brandai-platform-prod`、命令 `./cds-release-novartlab.sh` 与正式health地址。实际preflight HTTP200/9.328秒、ok=false：branch/commit/target/deploy-command/healthcheck/ssh/scripts/rollback-version通过，project-identity警告，artifact和remote-repository阻塞。补读细节48.281秒超时，原成功和失败保留；暂无足够信息解释两项阻塞根因。未执行正式发布，旧目标rollbackCommand为空不等于没有历史回滚版本。

CDS profiles恰好3个且指纹与68成功发布相同；Garage仍固定55e及原双卷。一次no-cache typed产品分支GET2.797秒成功，三个运行镜像仍68cb。审批列表和实际55ff签名投递仍未确认，不把超时写成审批通过。55ff deploy POST、正式部署、付费调用均0。本节为合并前冻结记录，实际合并及新SHA main CI另行登记。

## 新反馈：正常打开时资源初始化超时 · 修复中

### 本轮收尾：内容版本修复已本地通过，发布未触发

现有公网启动脚本实测 `Cache-Control: max-age=14400, must-revalidate`，正文仍匹配68cb。带新摘要参数的诊断请求虽为缓存MISS，正文也是68cb；这是新版本尚未部署的事实，不能据此判断CDN不支持参数缓存。固定脚本地址存在用户打开新版HTML却继续用4小时旧脚本的风险，因此在认证后的HTML中输出 `/novart-product-bootstrap.js?v=<编译内容SHA256>`。摘要来自资源清单，不用提交标签猜正文；缺失或非法值返回503，认证、许可及脚本顺序保持。

缓存修复本地完整检查通过：contracts976+UI24共1000，AI365，Web类型检查、生产构建、124资源导出，启动生命周期18及已有许可/首页/归档协议检查。第一次L1调用误加 `--jitless` 导致Vite依赖的WebAssembly不存在，未进入测试；原失败日志保留，取消该进程参数后正式L1退出0，不改断言或源码。类型检查仍可用低内存参数。四个既有脏文件与16个冻结画布文件完整哈希未变。

真实云验收脚本新增认证HTML的版本参数与实际GET响应体SHA256比对，预期总UI17；本轮新增检查尚未在云端执行，不能引用旧7b的API95/UI16来替代。公开验收脚本也按同一manifest摘要请求版本化资源，仅静态检查，不在未部署版本上运行成功验收。

CDS最后一次公司项目状态读取保留正式CLI鉴权、TLS和响应处理，经一次HTTP/2 GET等待120.062秒仍未取得完整响应（`H2_DEADLINE_EXCEEDED`，不是HTTP错误状态）。记录 `h2-company-final-20261012.json` 保留。根因仍不能归为某个网络或平台源码环节；停止替代连接重试，发布保护门在部署POST/intent之前阻塞。未部署7b或本轮缓存修复；当前已验证运行产品仍68cb，不宣称用户正常打开超时已在线解决。

检查日志位于本机 `.novart-tmp/product-cache-version-*20261012.log`；本轮付费模型、业务写、公司部署和本机Docker均为0。用户随后要求后端融合功能调查，由一个子智能体本地源码核对，报告另存 `novart-backend-reuse-and-additions-report-2026-10-12.md`，完成后根智能体审阅。

用户提出CDS预览服务器可能造成启动慢，作为待核实假设追加问题报告。现有控制台API超时和页面worker等待属于不同证据，尚无服务器负载/逐层时延证据；不据此断言CDS机器性能根因，后续按HTML/脚本/编辑器就绪分段验证。

单智能体后端功能调查已完成并经根智能体复核，报告为 `novart-backend-reuse-and-additions-report-2026-10-12.md`。对照本地main e999、调查时HEAD7b及五文件缓存增量，明确原Auth/权限/Asset/S3/普通生成/配额复用，知识识别/手册/模板/Campaign Kit/审核运营等原功能在新界面未全部接入，新增九个持久模型和工作台可靠协议、自有编辑工具。特别指出 `WorkbenchBrandDraft` 不直接确认 `BrandRule`，品牌草稿保存不能当作生成约束生效。报告不新增功能或真实模型验收；缓存源码、报告和日志选择性保存在整合分支，本轮不push或部署，待正式实时隔离校验恢复后继续精确SHA云端检查与发布。

用户确认正常打开新版 `/studio?workspaceId=…` 也会出现“资源初始化超时，请重新打开”。源码唯一对应 `novart-product-bootstrap.js` 等待 service worker controller 的12秒超时，尚不能断言用户浏览器一定使用强制刷新。独立真实浏览器6种正常冷/热场景通过；两种单列的Chrome受控绕过场景精确复现：registration已activated、ready已完成，当前页面controller为null且无controllerchange。原失败报告保留。

进一步核对源码和真实流量：`/canvas` 在成员和文档校验后已经302到自有 `/studio-editor`；新版首页→项目库→原自有画布97条HTTP请求全部同源，页面及画布ResourceTiming同源，当前链路无需外域资源映射。因此采用最小修复：`/studio`、`/studio/` 完全不检查、注册或等待service worker；仅显式旧 `/canvas` 的兼容分支保留原逻辑。没有加无限等待、跳过鉴权或改许可校验。

本地源码启动回归18项通过，覆盖worker缺失/拒绝/永不ready/未接管/旧worker时首页继续，以及旧画布/品牌创建门保持；许可检查、首页协议和外层归档检查通过。CI真实账号和数据库UI恢复流程增加 `serviceWorkers:block`，要求无controller仍打开首页、恢复原画布并保持原文档。此处源码回归是生命周期单测，不充当真实模型或真实持久化验收。

L1 989（缓存的同源965 contracts+24 UI）、AI365、类型检查及生产构建通过。导出124文件/76外域映射，编译后的bootstrap与当前源码一致。精确新提交的CI/镜像发布、独立产品发布和公网正常/热/禁用worker回归仍按实际后续结果登记，不提前算通过。公司 main、旧共享服务及数据卷保留，付费调用0。

“最近推送3天前”已核对：公司旧右卡52e的lastPushAt是10月8日13:41:30北京时间；其时间戳属于旧环境。GitHub实际已有d82/68两次新提交，CDS签名有效投递均被 `[skip cds]` 跳过公司原部署；独立旧入口d82在10月12日00:12完成，新产品68在10月11日23:12完成。不会伪造旧卡commit/date；后续应从真实独立产品卡查看其运行版本。

现场报告：`studio-sw-diagnostic-20261012-de5cfb6e-2405-44de-afc0-0cb570857ee1.json`、`studio-resource-origin-audit-20261012-29d88989-96a7-4a95-b05e-f59c973009f5.json`，存于本机 `.novart-tmp`；均无业务写/模型调用，原文档保持。

修复已提交并推送 `7b3c51c940a58d56c804f8865e7c18571f4d07e3`；[实际云端流水线38196332671](https://github.com/nickzhang2999-dev/brandai-platform/actions/runs/38196332671) 开始，完成结果及部署另记。选择性提交没有包含4个既有无关修改；原16个画布源码/测试文件哈希仍保持。推送前一次正式push self-test通过全部断言并进入workflow_run，但后续连接被远端断开，原helper未保存完整结果；其他30/60秒尝试超时。workflow_run dry-run不记作成功。公司三分支七字段另用正式GET取到完整基线，随后git push成功；真实签名投递由独立取证核对。

CDS连接观测：公司branches接口数次45秒内未响应；健康接口间歇成功或超时。两个当前DNS IPv4的健康检查分别5.062秒和1.437秒；仅在诊断进程选择较快地址，保持原HTTPS主机、SNI、证书校验及鉴权，未改hosts/全局代理。沿同地址的公司branches仍出现一次超时，最后一次120秒deadline实际16.453秒返回200；因此不能把DNS选路认定为根因，也不能把未响应的请求当作成功。该间歇连接问题与Novart页面的12秒worker等待故障分别记录。

新提交的云端run38196332671/product job114639693233完整success；源码和实际镜像内两轮均API95/UI16，均含“禁用worker后首页与原画布恢复”，退出0；源码启动18、隔离React交互49通过，镜像发布与清理全部成功，模型调用0。

真实push签名回执已由repo/ref小页查询取得：`451f0405-b36a-4db0-95d3-e8f8914394a7`，北京时间10:34:44接收，signatureValid=true、skipped、理由含skip marker、原记录snippet包含完整7b3c51c SHA。此前带branchId的小页未找到，不能据此断言push未接收，也尚未核对服务端过滤实现。原失败报告与后续partial均保留；公司七字段有实际推送前后相等证据，但后续fresh读取再次超时。发布器使用两份已观察证据的明确联合报告，仍在任何部署POST前重新实时核对公司七字段及同一签名回执，未降低guard；附加历史部署审计尚不完整。

## CDS 右侧旧评审分支无法预览新版产品：已修复

用户打开公司项目右侧前端评审分支，点击“预览”时看到“请使用管理员提供的完整评审链接进入”。实际发布的 CDS 主列表代码只打开裸域名，丢弃配置的入口路径；详情页使用完整入口，两处实现不一致。不是用户操作问题，也不是新版产品服务未启动。

在 `claude/novart-workbench-preview` 的旧独立网关增加固定跳转，提交 `d82e7c2843f417fde73558ebc2df493b21d732f6`。启用 `NOVART_REVIEW_PRODUCT_ENTRY` 后 GET/HEAD `/`、`/product` 固定跳转到已验证的新产品 `/studio`；合法旧分享入口保留原能力码和 cookie 校验，再跳转。不会传递旧访问码、cookie、参数或旧项目编号。新版独立产品仍使用自己的账号及自有画布，不绕过旧引擎许可。

公司右側旧分支只修改分支级入口名称“Novart 最新产品”和 `/product` 路径，其他入口不变，正式接口返回无需重部署。公司 main、共享业务数据和三分支运行版本/最近部署记录保持。新产品整合分支仍运行已验证的 `68cb239732641b324c27058b69c22c12b9ab8ada`，本次不重启应用或图片存储。

通过正式 CDS `preview-url` 命令取得 [可操作预览入口](https://novart-workbench-preview-claude-brandai-platform.geole.me/product)。主列表即使丢弃 `/product`，裸根也能跳转。

## 验证和发布结果

| 检查 | 实际结果 |
| --- | --- |
| 旧预览源码门禁 | L1 254、AI pytest155、web typecheck、生产构建通过 |
| 网关回归 | 桥接9、来源18、诊断10、许可13及包哈希173项通过 |
| 实际镜像 | [CI38154006162](https://github.com/nickzhang2999-dev/brandai-platform/actions/runs/38154006162) 默认模式重建持久化、桥接模式及发布全部成功 |
| 推送隔离 | `[skip cds]` 正式 dry-run及实际签名回执 skipped，公司未触发部署 |
| 独立旧入口部署 | `dr_378f629c2beff24596ce41dc` complete/running，镜像为完整 d82e 提交 |
| 公网路由 | 两旧域12组固定跳转通过，新产品匿名 studio307→login200 |
| 数据保留 | `/app/sharing` 原命名卷保留，30文件及完整内容哈希一致 |
| 真实浏览器入口验收 | 5/5：跳转、实际登录、新首页、可见项目库打开既有项目、自有编辑器 |
| 工具栏稳定 | 连续10.310秒/106采样，无消失、隐藏或替换 |
| 原项目保护 | revision20及checksum未变，登录POST1/业务写0/模型0/页面错误0 |

验收使用单独 headless Chrome，通过代码启动，不控制用户浏览器、不使用 Computer Use，也未启动本机 Docker。未重新生成付费图片。已有真实单张1K模型证据及其他未验收边界仍按原记录保留。

私有本机回执位于 `D:\coding\.novart-tmp`：`novart-bridge-actual-push-receipt.json`、`novart-bridge-ci-d82e7c2.json`、`novart-bridge-deploy-result.json`、`novart-bridge-public-verification.json`、`novart-bridge-company-entry-result.json`、`novart-bridge-final-isolation.json`、`public-cds-product-entry-report-20261012-f33ced83-91af-4a39-9af6-eceead32081c.json`。

## 源码差异和交付边界

本次产品前后端和自有画布没有变化。改动来自旧评审分支的网关兼容和发布检查；不是把旧评审镜像当作新版产品，也没有把旧项目自动迁移到新数据库。新产品登录后显示该账号在新项目中的内容。

入口问题已完成；CDS 平台的通用路径丢失仍应由维护方统一主列表/详情页解析函数。日志、问题报告及整合进度已本地补记，不为仅文档改动再部署。


---

# Novart 开发日志 · 2026-10-12 · CDS 产品预览入口

## 用户问题与定位

用户点击公司项目右侧前端评审分支“预览”，看到旧网关说明页，不能直接进入新版产品。已核对 CDS 实际发布的 BranchListPage 与 previewUrl 模块：主列表按钮只构造根域名，不使用带路径的 primaryEntry；详情页使用完整入口路径。之前仅解释为缺少完整评审链接不够准确，主列表按钮确实丢失了路径。

CDS 的 web-entry-config 正式接口只支持当前分支的路径、名称和子域，不能直接配置外部产品地址。本次采用独立旧评审服务的固定跳转兼容该按钮，不修改 CDS 平台代码。

## 实现范围

- `share_runtime.py` 增加可选 `NOVART_REVIEW_PRODUCT_ENTRY` / `--product-entry`，严格接受固定 HTTPS origin 加 `/studio`，非法配置在创建数据和启动内层服务前失败。
- 配置启用时公开 GET/HEAD `/`、`/product` 固定跳转；合法旧分享链接继续校验 capability、设置原 cookie，在已鉴权的 `/share-start`、`/studio` 跳转。
- 不带入原查询、项目编号、访问码、cookie 或任意 next 地址。关闭配置时保留原行为。旧写入来源校验、许可配置、健康检查保持。
- 新产品仍使用自己的账号登录及自有画布；不是用跳转规避原画布许可。
- 新增 9 组真实 loopback HTTP 回归和 CI 实际镜像桥接检查，保留原镜像默认模式的重建持久化检查。

## 发布前验证

旧预览分支同源门禁：L1 254（contracts 248 + UI 6）、AI pytest 155、web typecheck、生产构建通过。新桥接 loopback 9 组、来源保护 18 组、启动诊断 10 组通过；许可配置 13 组及包哈希 173 项检查通过。独立只读审查无阻塞。

镜像构建和 Linux 容器检查在 GitHub CI 执行，本机未启动 Docker。发布必须使用完整提交 SHA 和 `[skip cds]`，核对正式 dry-run 与实际签名推送回执，再手动部署独立旧评审项目。CI、部署和公网结果另记实际回执，不能提前算通过。

## 隔离与数据

公司 main、共享业务数据及公司原服务不部署。本次仅允许右侧旧评审卡片的分支入口名称/路径调整。旧独立项目沿用 `novart_workbench_preview_data_v1` → `/app/sharing`，不重建、删除或迁移数据卷。新产品已验证版本 `68cb239732641b324c27058b69c22c12b9ab8ada` 保持运行，不因入口桥接重启其数据库、存储或应用。

部署前读取旧数据卷：30 个文件，挂载存在，JSON 数据内容哈希已保存到本机私有回执。部署后必须核对内容哈希一致。没有新增付费模型调用。

## 源码差异与验收界限

修改的是旧评审网关和发布检查，新产品前后端、原生自有画布及生成服务未改。兼容层解决预览入口，不等于修复 CDS 主列表的通用路径处理。CDS 平台的源代码修复应让主列表采用与详情页相同的完整入口解析；本仓库不能代替平台维护者发布该修复。
