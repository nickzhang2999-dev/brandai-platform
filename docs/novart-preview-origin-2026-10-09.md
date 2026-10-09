# Novart 独立评审同源写入 403 · 2026-10-09

本记录针对独立 CDS 前端评审项目，不代表产品集成分支、公司 `main` 或正式站已修改。2026-10-09 15:45（Asia/Shanghai）确认线上运行 `2db9229f03e0262e66ac7ff8c7465111d9cb166d`，当时只验收了独立项目的标准域名。16:55 补查发现用户从公司 CDS 卡片进入的是另一别名，仍被 Origin 守卫拒绝；下文保留第一次发布记录，并在末尾记录本轮修复。真实鼠标/键盘操作仍未验收。

## 线上证据与归因

官方 CLI `branch list --project cd9d15b4c592` 返回独立评审分支处于 `running`，服务映射端口为 `15526`。官方 `previewUrl` 为 `https://novart-workbench-preview-claude-novart-workbench-preview.geole.me`，与既有私密评审入口的 origin 一致。评审入口 GET 返回 302 并签发评审 Cookie；本文不记录入口凭证或 Cookie。

在既有独立评审授权下，对不存在的 `/api/canva/project/__readonly_origin_probe__` 发送空 JSON POST。探针不创建、修改或删除业务数据，结果如下：

| 请求 Origin | HTTP 状态 | 应用结果 |
| --- | --- | --- |
| 不发送 | 503 | 通过访问和 Origin 检查，进入未知接口兜底 |
| 上述实际公网 origin | 403 | `Cross-origin write rejected` |
| `https://unrelated.invalid` | 403 | `Cross-origin write rejected` |
| `http://127.0.0.1:15526` | 503 | 通过 Origin 检查，进入未知接口兜底 |
| `http://localhost:15526` | 403 | `Cross-origin write rejected` |
| `http://127.0.0.1:8769` | 403 | `Cross-origin write rejected` |

503 在此只用于判定请求已越过 Origin 守卫，不代表业务 API 正常。官方 CLI 容器只读检查确认，线上 `harness/share_runtime.py` 仍执行以下判断：

```python
if origin and urlsplit(origin).netloc != self.headers.get('Host'):
    return self.send({'error': 'Cross-origin write rejected'}, 403)
```

这条严格比较与探针结果共同证明：代理传给应用的 `Host` 为 `127.0.0.1:15526`，正常浏览器却发送公开 HTTPS origin，于是同源写入被误拒。现有证据说明应用对反向代理的假设不成立，**没有证明 CDS 违反其平台契约，不能直接归因为 CDS 平台 bug**。

原正向 HTTP 检查不携带 `Origin`，只验证恶意跨域请求会被拒绝，未覆盖正常浏览器经过代理的请求。归因记为 **I（应用实现缺口）叠 O（验收覆盖缺口）**；接口检查通过也不能替代真实用户操作。

## 修复与配置要求

运行时通过 `NOVART_REVIEW_PUBLIC_ORIGIN` 或 `--public-origin` 接收唯一可信公开 origin，解析并比较协议、主机及有效端口。默认端口进行规范化；格式错误、重复 Origin、`null`、路径、通配符等输入不得扩展信任范围。配置来自服务端，不从 `Forwarded` 或 `X-Forwarded-*` 请求头自动建立信任。未携带 Origin 的既有 CLI/CI 请求仍须先通过评审访问鉴权。

未配置时保留直连 Host 校验。对当前 CDS 代理，**必须把修复镜像与 `NOVART_REVIEW_PUBLIC_ORIGIN` 一起部署并验证生效**；不能只修改源码或只设置变量就宣布修复。发布时从官方 `preview-url` 获取实际入口，环境变量只填其 origin，不带路径、尾部斜杠或凭证。若公开域名变更，应重新核对配置并部署。

本次改动只服务于 `claude/novart-workbench-preview` 的独立评审运行时，与后端产品集成分支分开。不导入根产品 compose，不更新公司 main，不修改共享数据库、共享 profile 或公司业务数据；继续复用独立评审持久卷，保留既有项目、图片和访问空间。

## 当前验证状态

| 检查 | 本轮结果与边界 |
| --- | --- |
| 本地真实 HTTP 回归 | 12 项通过；热修复 worktree 重跑退出码 0，耗时 8.79 秒；包含可信公开 Origin、反代 Host 和拒绝边界，不等同公网用户路径验收 |
| 包校验和 | 172 项通过 |
| L1 | 254 项通过 |
| AI pytest | 155 项通过 |
| Web typecheck | 退出码 0 |
| Web production build | 退出码 0 |
| Branch Image 回归接入 | CI 37899305284 成功；12 项 Origin 回归、172 项校验和、Linux 启动/鉴权/反代写入/持久卷重建通过后发布镜像 |
| CDS webhook self-test dry-run | 精确 SHA 的 push 为 ignored-skip-marker，workflow_run 为 workflow-acknowledged，全部部署副作用字段为 false |
| 实际 push 与 CI | GitHub push 成功；CDS 真实签名有效投递 b3ed84bf-02dc-4832-a17c-d9a35e3c7691 为 skipped，原因明确为 [skip cds]；公司三个分支回读未变 |
| 修复镜像及公开 Origin 配置部署 | dr_3483c099da752e5cf5fc1451 完成，运行提交 2db9229、prebuilt=true，1/1 服务健康且无 drift；容器内提交、包指纹及 Origin 回读一致 |
| 公网 HTTP 验收 | 76 项通过；实际 Origin 创建/上传/保存/重开、恶意 Origin 拒绝、57 个资源响应（含 CSS import 链）均已检查 |
| 公网浏览器用户路径 | 浏览器连接失败，未验收 |

镜像 digest 为 `sha256:76b263f16626016ac4bb0e9110bd9443262816a0536b4cfcb6d711f3b9590de3`；运行包 SHA-256 为 `35170856540ae75f374245271876e28c472e23f3096074a496a0ab0ac83bbadc`，公网 `/healthz` 与 [CI 37899305284](https://github.com/nickzhang2999-dev/brandai-platform/actions/runs/37899305284) 一致。只更新独立项目环境变量并按精确 SHA 部署，没有更改公司自动部署开关或导入根 compose。

公网脚本 `check_origin_online.py` 的正常 POST 均带真实 Origin，以稳定 requestId 幂等创建自己的 `HTTP origin check` 项目及 PNG，保存明确标注的原生格式存储样本；重跑读取同一项目，不重复创建或覆盖用户编辑。本轮样本保留，未删用户数据。10 月 8 日旧样本部署前已不存在（与历史清理记录一致），已明确 skipped，不能声称本轮验证了旧样本跨重建保留；新镜像的重建持久化由本轮 Linux CI 验证。

验收脚本首次误把合法的 32 字节 CSS `@import` 入口判为失败，已改为验证非空内容并递归检查导入样式，完整重跑通过；不是页面缺失。项目环境变量 PUT 后首次回读出现 WinError 10054，重新 GET 确认已生效，再部署，没有重复盲写。单次连接中断不归因为平台服务缺陷；浏览器插件连接失败也单独保留为验收限制。

## 后续验收判据

1. 从 CDS 右侧分支“预览”重新进入，复核创建画布、中文输入、拖拽、编辑、刷新重开及归档恢复。浏览器连通性未恢复前，不能把 HTTP 结果升级成鼠标/键盘验收。
2. 产品集成分支继续独立联调真实账号、DB、存储和 worker/provider；本评审版不是该后端的验收环境。

## 16:55 · 用户实际入口的别名遗漏

用户从公司 CDS 预览卡片进入 `https://novart-workbench-preview-claude-brandai-platform.geole.me`，而先前配置和验收的是 `https://novart-workbench-preview-claude-novart-workbench-preview.geole.me`。官方分支元数据及两个入口的 `/healthz` 确认它们服务同一评审包，指纹均为 `35170856540ae75f374245271876e28c472e23f3096074a496a0ab0ac83bbadc`。

使用既有评审能力建立会话后，在用户实际域名下携带该 Origin 调用原生 `/api/canva/project/queryProject`，返回 **403 / Cross-origin write rejected**；标准域名可正常读取。读取对象是脚本自己的既有 `HTTP origin check` 样本，未修改项目或图片。图片交接记录仍为 pending、0/1 确认；这证明画布初始化被阻断，但不是图片导入、编辑及重开已经通过的证据。

归因为 **I（应用配置只支持一个公开入口）+ O（验收遗漏用户实际入口）**。CDS 提供两个入口不能直接等同为 CDS 平台 bug；需要把平台入口与应用信任配置对齐。

修复增加 `NOVART_REVIEW_ADDITIONAL_ORIGINS`：严格 JSON 数组，默认空，最多 8 个精确 origin、4096 字符。非空数组必须有主 Origin；拒绝非法、重复、与主域名等价的项，启动前失败。不信任客户端的 Host/Forwarded 头来扩大放行范围，不更改既有评审鉴权。仅给独立项目配置已核实别名：

```json
["https://novart-workbench-preview-claude-brandai-platform.geole.me"]
```

`home-start-attachments.js` 增加原编辑器错误边界识别：画布启动失败时明确显示“画布暂时无法打开”，保留原始需求、图片和重新打开入口。此逻辑有纯 Node 回归，未以真实页面操作验收。

本地 Origin 真实 HTTP/配置回归 18 项和首页交接边界 5 项通过。CI 容器检查新增第二入口读取及重建后重开同一文档；四项仓库门禁、精确提交 CI、独立 CDS 发布和两个公网入口复查按结果继续追加。用户要求不使用 Computer Use，后续不再操作其浏览器；接口证据与人工页面验收分开记录。

本轮四项门禁通过：L1 254（Turbo 使用未变源码的有效缓存）、AI pytest 155、Web typecheck、Web production build。Windows 的 AI 命令使用已有 Python 虚拟环境对本 worktree 的 `apps/ai` 运行 `-m pytest -q`，没有启动 Docker/数据库。包校验和 172 项通过。CI 及线上状态尚不能由这些本地结果代替。

## 17:05 · 别名修复镜像发布

- 修复提交：`70a07dd273749413a70cf3bcec22b9ddd9dcb9dc`，提交含 `[skip cds]`。精确 SHA 的 push/workflow webhook dry-run 均无部署副作用；推送后、CI 后、独立部署后，公司三个分支的运行状态及提交均与发布前一致。本轮没有单独取得真实 webhook 投递日志，不把 dry-run 称为真实投递证据。
- [Branch Image 37908433383](https://github.com/nickzhang2999-dev/brandai-platform/actions/runs/37908433383) 成功：18 项 HTTP/配置、5 项交接边界、172 项包哈希及 Linux 容器双入口/保存/重建检查通过后才发布镜像。
- 镜像 digest：`sha256:8b4ac111128ebcdbfd7e105ed32b757b65d7d6bb11d96eb67e5ca03b4fb03bed`；包 SHA-256：`fbf5d92b6905737e6be70e4c64dd0548552bf4f0d9c3918c64d0ab7312d8d009`。
- 仅修改独立项目 `cd9d15b4c592` 的 `NOVART_REVIEW_ADDITIONAL_ORIGINS`，主 Origin 保持原值；未导入新 compose。官方 CLI 按精确提交部署，运行 `dr_36df0dee2745b8fc16d76247` 完成，服务 1/1 健康、无 drift。容器内提交、包指纹及两个 Origin 均回读匹配。
- CDS 元数据的 `deployRuntime.prebuilt=true`，但 `kind/label/title` 同时显示“源码/待生效”。这是本轮观察到的平台状态展示不一致；实际镜像与运行包已核对，不能因此断言 CDS 运行了未验证源码。尚未修改平台配置或服务。
- 公网双入口只读验收通过：每个入口 34 项检查、22 个资源响应（含 CSS import 链）；`queryProject` 都返回成功，用户实际入口由 403 恢复为 200。既有样本的项目内容、名称、版本均未改动，附件字节哈希一致；两个入口的新版交接脚本与已测试源码逐字节相同。未认证请求仍为 401，陌生 Origin 仍为 403。
- 首页交接任务仍为 pending，只有 1 张附件；本轮只读验证不会模拟浏览器将其放入画布或确认交接。已请用户刷新后从项目库重开原项目，反馈图片能否显示、选中。未使用 Computer Use 操作页面，尚不能声称上传到画布、编辑、重开整条用户路径通过。
- 脱敏 HTTP 报告保存在独立部署目录 `alias-readonly-acceptance.json`；不包含访问能力、Cookie、图片内容或画布文档内容。该部署控制目录不作为产品源码入库。

## 17:10 · 用户确认图片入画布，服务端保存回读通过

用户按提示刷新、从项目库打开原项目后明确反馈：“图片已经进入画布，可以选中”。本轮没有使用 Computer Use 执行页面操作。

随后从用户实际入口只读核验原项目：交接状态由 pending 变成 **complete**；附件 1、已完成 1、已确认 1、待处理 0。原生画布的持久化文档包含导入回执对应的 shapeId，版本相对旧样本已推进，原图片字节仍可读取且哈希一致。没有通过脚本写入图形、强制确认或覆盖用户编辑。脱敏结果保存在 `alias-user-handoff-verified.json`。

据此可确认本次“首页图片交接卡住”的阻断已解除，图片入画布/可选中有用户实测，保存有服务端证据。再次刷新后的显示、后续变换和导出仍需分别验收；本结论不扩展为真实 AI 或完整产品已经上线。

## 17:12 起 · 用户复核发现原生画布仍会空白

后续用户反馈：刷新原项目和新建空白项目“两个都是”，且“只有外层页面，底部工具栏完全没有”。因此上节首次导入成功不能升级为刷新恢复通过；该用户路径重新标记为未通过。

服务端只读回查仍有 c-image 原生对象、complete 交接及 1/1 确认，没有数据丢失证据。用户实际别名下，原生启动需要的用户信息、时间、queryProject 均 HTTP 200/code 0；原生入口 31 个 JS/CSS 响应、异步编辑器的 9 个 JS/2 个 CSS 都可读取。这些只证明传输和数据，不证明浏览器已执行脚本。

已在真实桥接脚本的 Node VM 回归中复现确定缺口：`m8-canvas.js` 仅看到自定义外壳就发送 ready，父页面立即撤掉加载提示；已完成交接项目和空白项目又不会等待 native mount，因而原编辑器未出现时呈现静默空白。新增修复要求原生 canvas、底部工具栏和上传入口齐备才 ready；捕获原生错误边界，并提供 22 秒后的重开/返回出口，重开只替换当前失败 iframe，不丢弃其他缓存编辑器。

独立本地 headless Chrome、一个上下文/标签、loopback 服务和合成测试数据验证了“首次空白→同项目刷新→新建另一项目”：三次当前 active iframe 都有原生画布和上传工具、Service Worker controller，路径为 `/canvas`。没有连接或控制用户浏览器。出现的第三方 FingerprintError 与正常挂载并存，不能认定为白屏原因。本地未复现线上用户故障，故不宣称根因已完全解决。

为下一次用户刷新提供精简运行证据，增加鉴权后的 `/review/startup-diagnostics`：只收挂载布尔值、视口尺寸、固定状态、错误类型和 JS 文件名/行列。拒绝错误正文、完整堆栈、URL、项目标识、文档和图片内容；单次 4 KiB，单页面最多 8 条、内存最多 32 条，不写业务数据。该机制不执行用户操作，也不发送到外部诊断服务。服务端 HTTP 9 项与 Origin 18 项回归通过；发送端隐私/去重/上限/卸载检查及桥接/父页面 14 项通过。发布后仍需用户复核和实际诊断证据，不能用状态提示改进代替根因修复。

最终工作树已重新完成 L1 254（有效缓存）、AI pytest 155、Web typecheck、Web production build；172 项包哈希校验通过。独立本地 headless 再验三条流程均有原生 canvas 和 bottom-toolbar。认证读取的两条 ready 均为 canvas/toolbar=true、boundary=false；第三次同文档 hash 导航的相同状态按设计去重。合成 TypeError 的隐私占位文本、完整 URL 和参数均未进入诊断，只保留类型和文件名/行列。测试上下文、服务器及临时测试目录已清理。此处只记本地行为证据，用户线上空白仍未验收。
