# CDS 问题报告 · 2026-10-12 · 主列表预览丢失入口路径

## 当前新增：构建成功通知未订阅

main `0fbdfd2` 的基础 CI `38226429370` 与 Branch Image `38226429393` 均成功。CDS收到有效签名push并等待该SHA镜像，但未收到workflow_run。GitHub公开App API核对 `cds-geole-preview`（4096637）的events没有workflow_run，permissions没有Actions。需CDS App管理员启用Actions只读和workflow_run订阅，才能让构建完成后自动更新预览；移除跳过标记和固定镜像只解决前半段。当前镜像模板已使用完整成功提交，保留原启动命令、环境和入口。官方claim-prebuilt可恢复单次预览，不能代替订阅修复。

本节对应当前整合检查，以下4b88账号、部署及生产阻塞属于此前阶段的保留记录。

## 最新收尾：账号/写入适配已完成，主列表按钮丢路径与正式目录仍待平台处理

用户授权开普通预览账号后，main真实登录和画布13项操作/保存恢复/导出验收通过；原账号不存在的诊断属于环境差异，没有重置正式站账户或开放注册。排除新增专用用户/品牌/项目后，原12核心表保持；本轮实际新增User/品牌/成员关系/项目各1及EditorDocument1，模型调用0。

部署后的 main 创建失败另有明确环境原因：Next 服务的 AUTH_URL 与主预览域不一致，`workbench-origin.ts` 按配置严格拒绝写入；失败请求没有落项目。修复只在 main 专用新模式的 Web 启动命令中配置可信公开 origin，不改共享项目环境桶或其他分支旧模式，不放宽来源校验。同固定镜像再部署run `dr_df058efa5e47ab986436e9c3` 后实际HTTP创建/20次文档保存通过。Docker exec 的环境与启动后 Next 进程 export 不同，原错误测量false保留，实际进程补核通过；不是新的CDS服务端故障。

用户仍从 main 主列表“预览”看到旧首页，现已核对**主按钮**而非仅drawer：主列表调用 onPreview → openPreview → `$e`，使用 tr/er（分别导入helper的m/s）构造裸域名，未读取完整发布入口。配置已是 `/studio`、官方原生命令也返回完整地址，按钮仍可剥掉路径。产品裸根 `/` 保留旧首页，新工作台由 `/studio`提供。使用完整链接可进入已验新版；本轮未改CDS平台代码，不能把只修改入口配置报成按钮通用修复。

正式发布唯一blocking仍是生产target的 `/opt/brandai-platform-prod` 非Git；完整4b88产物已被正式预检认可。没有强行发布、猜生产目录或切换到不匹配的源码Compose。下节账号尚待验收是历史快照，正式目录阻塞仍有效。

## 最新：main 更新完成后的两个真实阻塞

**新版 main 部署已完成，不再沿用旧 e999 运行状态。** run `dr_e4915a56693c53a5c4d379c3` 已于06:40:25Z完成，三个服务固定镜像/容器完整 SHA 为4b88；33份迁移和原12核心表保持检查通过。原生分支级 Web 入口改为 `/studio`，官方读回完整地址，公网实际脚本匹配部署 manifest。此前 signed skip 保持运行不变与本次获权部署是不同阶段。

1. **预览账号环境差异，非已证明的 CDS 登录故障。** 用户正式站账号在 main 预览库不存在；main 注册关闭且管理员 allowlist 已配置。按用户修正后的密码实际登录仍被拒绝，没有改密码或开放注册。main 登录后的画布保存恢复/导出尚待合法账号实测，不以独立98的 UI 通过代替。无需、也不能通过重置原用户或无密码身份伪造来通过验收。
2. **正式发布 target 配置仍不完整。** 当前预检 `pfl_487c80edc6a34a84` 已认可 main4b88 产物及 `/studio` 地址，SSH/脚本存在/回滚可定位均通过，唯一阻断为 `/opt/brandai-platform-prod` 不是 Git 根。GitHub URL、本地 D盘源码、CDS 的 Project.repoPath 都不能证明生产 SSH 目录的身份。现有正式 UI 仅提供 existing-script/generated-compose/generated-static，未找到已注册给本项目的内置本机产物策略；不能据此宣称整个 CDS 服务端绝无该能力。

正式 target 没有变更，也没有执行正式 release；正式健康接口仍 HTTP200，只代表旧环境可达。下一步应取得真实远端 Git 根、可信脚本内容及资源/回滚合同后重新预检。推荐扫描出的旧源码 Compose 会挂载源目录并使用 Node20，与已验 immutable topology 不同，不能直接替换生产配置。

操作回执 `main-preview-rollout-deploy-1791787089900604500.json` 的旧顶层断言因为 branch detail 的 commitSha 为 null 而 `ok=false`，原记录保留；官方 CLI 本次 exit0，后续独立 deployment run/fullSHA、实际镜像与容器环境均通过。此类诊断字段缺失不是重复部署的理由，没有再次发 deploy POST。

证据见当日日志最新节及本机 `formal-main-4b88-preflight-current-1791787734698477300.json`。主列表路径是否仍被不同回调丢弃，需要以实际按钮目标确认；仅配置读回不能替代点击验收，不把不同 helper 导出函数的行为混为一谈。

## 最新验收与归因边界

核心已真实快进main至4b88，main基础CI38209036645与完整镜像CI38209036689均整轮成功。两真实签名push均skipped，公司旧运行记录、profiles和共享infra不变；CDS非live githubCommitSha仍旧缓存值。真实Git refs应以实际ls-remote核对，不以卡片旧时间或缓存值推断没有push，也不为刷新显示触发旧seed/db push部署链。源码合并与部署状态须分开呈现，正式站没有更新。

55ff独立产品部署后的公网启动已完成普通3项、禁用Service Worker 1项、已有激活Worker但未控制页面2项，共6项全部通过。实际资源正文绑定部署摘要与源码，首页进入已有画布后工具栏稳定至少10秒，当前revision28文档不变；业务写入、额外模型调用、页面异常均为0。旧revision20基线与失败记录保留，此次不宣称历史文档内容未变。

另一本机障碍是C盘可用空间为0，影响隔离Chromium启动；仅测试进程临时目录切换至D盘后完成验收，未改系统设置或清理用户文件。应与已核实的CDS主列表路径丢失、正式target非Git目录、测试helper绕过既有代理分别记录，不能混成CDS服务器性能问题。

公网汇总 `.novart-tmp/public-bootstrap-55ffda3-acceptance-summary-20261012.json`；独立预览可用不代表公司main运行版本或正式站已经更新。正式发布仍需正确远端Git目录和实际脚本，不能用GitHub仓库URL替代服务器路径。

## 后续纠正：本机代理绕过、诊断请求完整性与正式目标阻断

此前“CDS接口长时间未响应”不应笼统归为CDS服务器bug。已查明诊断/发布helper强制 `ProxyHandler({})`，绕过用户已启用的Windows系统代理；复用已有代理后公司GET为2.25秒，项目/配置GET约2.5/2.9秒，main/feature四项dry-run通过。系统代理、hosts和全局设置均未改，HTTPS Host/SNI/TLS校验保留。这解释本轮主要访问路径问题；原直连/H2超时记录保留，不把所有历史网络现象归成同一原因，也未取得服务器负载证据。

公网runtime第一次urllib默认UA收到403/Cloudflare1010，curl UA请求为200并取得新runtime成功；两个结果分别保留。这与CDS控制面helper绕过代理是不同事实，不能用UA拒绝代替产品部署失败或浏览器实测。普通/暖启动/禁用worker三种公网浏览器验收此时仍pending。

正式artifact首次fail是小克诊断POST遗漏previewUrl；补入官方branch preview URL后的最新preflight HTTP200，artifact pass。唯一blocking是remote-repository：`/opt/brandai-platform-prod`不是Git根目录；project-identity为旧target身份快照warn。公司项目gitRepoUrl/githubRepoFullName正确，SSH、deploy-command、scripts、health和rollback检查pass，不能说整个SSH或repository绑定失败。没有更改正式target或触发release，远端目录修正仍须走实际流程。

公司Web profile的release命令实际含seed、db push和Next build，本轮未改、未执行。CDS profile与正式SSH脚本 `./cds-release-novartlab.sh` 不是同一份已确认内容；正式脚本尚待读取，不能从profile推定其迁移/备份/资源构建行为。

独立55ff已于05:10:25Z完成部署，三应用镜像/环境fullSHA、Garage固定55e双卷healthy及公司七字段不变已核对。manifest bootstrap实际4cd3…与本地7881…因map key顺序不同；公网源码主体和语义映射严格匹配，以实际部署manifest校验，不再把字节顺序差异当旧版本证据。源码合并main提交9dcc此时尚未push，正式发布仍受远端目录阻断。

证据：`.novart-tmp/cds-existing-proxy-read-1791781506232204200.json`、`company-proxy-release-audit-1791781814409663800.json`、`formal-preflight-1791781862871253400.json`、`release-product-startup-55ffda3e29f40fba14e7fd78d4bddf39302e5d6f/runtime-receipt.json`。以下段落保留早前状态，读最新结果应以本节及当日日志为准。

## 早前核心合并预检记录（已由后续完整请求补核）

独立产品55ff整条云端CI已成功，不能与CDS控制面查询未响应混成同一个构建故障。固定profiles与infra读取200，3个应用profile及Garage55e固定镜像、原双卷正确；typed产品分支一轮超时，随后加no-cache的一轮2.797秒200，仍运行68cb。这只能说明读取间歇成功，不能断言缓存或服务器CPU为根因。公司列表、审批列表和55ff实际签名投递多次未确认；timeout不是HTTP拒绝，也不等于审批通过。

正式目标 `brandai-novartlab-local-prod` 读取200，确认原SSH脚本/目录/正式health；首次实际preflight200、ok=false。artifact、remote-repository为blocking fail，project-identity为warn；SSH、脚本、健康检查与历史回滚版本检查pass。为补读检查细节的第二次preflight48.281秒超时，失败保留，尚不能解释阻塞的具体原因或声称公司SSH坏了。未调用发布runs或修改目标。

应用发布衔接另列：原公司source启动链只有Next build，没有Studio资源导出；这是仓库发布适配缺口，不能直接算CDS平台故障。本批已让main可以运行专用完整镜像流水线，但正式脚本如何消费该镜像、迁移顺序和真实schema仍须核对。源码合并、独立预览部署和正式站发布分别取证，不互相替代。平台强制审批与失败项保持阻断。

## 后续资源初始化超时与卡片时间：单独归因

新版产品截图的“资源初始化超时”来自 Novart bootstrap 强等 service worker controller；它不是 CDS 主列表丢路径的同一故障。当前首页/项目库/自有画布实测97请求全部同源，去掉首页多余资源代理依赖是本项目可修复的产品初始化问题。独立Chrome六种正常场景未复现用户常态，两种明确受控绕过场景复现相同超时，不能把后者当作用户具体操作。修复及新发布验收见当日日志。

公司旧右卡52e“最近推送3天前”取其 `lastPushAt`（10月8日13:41北京时间）。CDS已收到d82/68的新签名push，但 `[skip cds]` 按隔离要求不部署公司原分支；按钮现在跳到独立产品，卡片时间不会跟随跳转目标更新。这是不同环境的元数据展示，不应伪写commit/date。真实独立产品卡路由为 `/branches/98cfea6cdcbd?branch=novart-product-integration-claude-novart-product-integration`，来自已发布CDS路由代码。应明确区分“入口”和“实际产品部署”。

## 现象及复现

### 追加：10月12日发布校验接口间歇未响应

最后一次只读诊断以原正式CLI请求的鉴权、Host和TLS语义，通过Node HTTP/2读取公司branches，120.062秒仍无可确认完整响应，`H2_DEADLINE_EXCEEDED`。此前HTTP/2独立产品branches200、公司branches25秒超时；因此不能断言仅Python/urllib造成故障。诊断结果及初次失败文件保留，不关闭TLS、不改全局代理/hosts、不重复任何写请求。发布器未发部署POST，fresh公司状态校验继续阻塞；不以旧成功读取或HTTP200本身代替当下内容验证。

另一个产品自身更新风险：公网bootstrap固定URL有4小时缓存。已在新产品源码按编译内容摘要生成script版本参数，并完成本地检查；这属于Novart资源发布适配，不是已确认CDS缓存实现故障。新脚本尚未部署，公开资源正文仍68cb，不能归因到CDN忽略query。CDS通用入口丢路径、当前API未响应、Novart的worker等待与资源版本问题应分别追踪。

用户提出“启动慢可能来自CDS预览服务器”。保留为合理待核实假设：控制台状态API未响应不能单独证明产品预览服务器CPU/内存不足，也无法区分代理、网络、应用处理或静态资源等待。现有证据未取得服务器负载或逐层追踪。本次先修复已确定的页面启动前置条件；后续在实际新版本发布后分别记录HTML首字节、脚本下载和画布可编辑耗时，关联预览服务日志再判断，不把延长页面超时当成性能修复。

正式self-test POST先后30/60秒超时，另一次push断言已通过后workflow_run连接被远端断开，后者没有确认结果。公司branches GET多次45秒内未响应；最终120秒请求deadline下实际16.453秒返回200。健康GET也出现快速200与超时交替。当前DNS两个IPv4健康检查分别5.062/1.437秒，进程内选择较快地址后公司branches仍有一次超时；无足够证据确定是CDS应用、上游、网络或哪一层造成间歇延迟。

没有改全局代理/hosts，没有取消TLS校验，没有将超时写请求重复解释为成功或绕过审批。发布推送的隔离断言和公司七字段基线分别取得，真实push投递继续单独核对。平台维护方可按请求时间查询入口、鉴权、branches及webhook self-test耗时，明确请求是否抵达以及在哪层等待；本记录不把当前证据推成已确认源码根因。

追加实测：company metadata数次200时前后三分支七字段相等；带长过滤的delivery查询130秒未响应，缩小为repo/ref的5条查询5.843秒200并取得真实签名skipped推送。只有branchId的两页未找到目标，不代表没有投递，尚不能确定过滤规则或超时具体层。后续公司fresh GET120秒仍未确认，integration最新1条run读取1.234秒200但字段未完整审计；保留失败/partial，不把HTTP200本身充当内容核验。单纯换DNS地址并未解决全部间歇问题。

公司项目 `a8a098f7193a` 右侧 `claude/novart-workbench-preview` 的入口配置原为带路径的完整评审入口。点击主分支列表中的“预览”，实际只打开该入口域名的 `/`，因此看到“请使用管理员提供的完整评审链接进入”；详情页入口解析则保留完整路径。

## 已核对的具体原因

已读取 CDS 实际发布的 `BranchListPage-CKTFpzMd.js` 和 `previewUrl-Cu1wGG_9.js`。主列表回调调用后者 export `m=c`，仅用 protocol、previewSlug/id 与域名组装根地址，未使用配置的 `primaryEntry.url`/路径；详情页使用 `resolvePreviewEntryTargets`（export `r=w`），保留完整入口。两处行为不一致，主列表即使配置了 `/product` 等路径也会丢弃。

来源是 CDS 当时线上实际 bundle，不把推测的源码行号当作已确认位置。正式 `GET /api/branches/:id/web-entry-config` 同时证明旧卡片入口存在带路径的 URL。

正式 web-entry-config 只允许当前分支的 `/` 开头路径、名称和子域，不接受完整外部产品 URL。这是接口约束，不是另一项故障；不能靠直接写外部 URL 修复主列表。

## 本次可完成的兼容修复

在独立旧评审网关增加可选固定 HTTPS `/studio` 目标，公开 GET/HEAD `/` 和 `/product` 跳转，原分享入口保留鉴权链再跳转。目标仅由可信部署配置给定，旧参数、访问码、cookie 不传递，新产品继续登录。公司卡片仅改分支入口名称/路径，不部署公司项目，不修改平台或共享服务。

提交 `d82e7c2843f417fde73558ebc2df493b21d732f6`；[CI38154006162](https://github.com/nickzhang2999-dev/brandai-platform/actions/runs/38154006162) 实際 Linux 镜像两种模式及发布通过。独立部署 `dr_378f629c2beff24596ce41dc` 完成；旧卷全文件哈希保持。正式 CDS 命令返回 [现已发布的产品入口](https://novart-workbench-preview-claude-brandai-platform.geole.me/product)。

公网两旧域共12个固定跳转检查通过。真实浏览器从旧裸根进入新域登录，登录后首页及项目库打开既有自有画布；工具栏10.310秒稳定，文档不变，业务写/模型调用/页面错误均为0。此次问题已对 Novart 用户闭环。

## CDS 平台应如何修复

主列表应与详情页共用完整入口解析，优先打开服务端已发布的 primaryEntry URL；没有完整入口时才回退裸域名。需要覆盖带路径、多个服务入口、未部署分支和旧格式配置。发布时对照两个按钮最终地址，不能只检查按钮可点击或分支状态 running。

本次兼容修复没有发布 CDS 平台源代码；其他仍使用主列表按钮的产品也可能受路径丢失影响。本项目先保证用户能正常预览，平台通用修复由其维护方完成。
