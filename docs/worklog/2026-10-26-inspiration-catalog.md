# 2026-10-26 · 灵感独立开发：审核标签与同步状态

## 范围

用户要求继续灵感部分，保持与主产品分开。沿用 `claude/nova-inspiration` / `devUpdate1012`，本轮不合并 main、不发布正式站。

既有自有 TEST 技术链路继续作为验收材料；28 张第三方候选仍待用途确认，不因本轮开发获得发布权限。额度看板保持暂缓。

## 计划

- [x] 读取现有实施与试点准备记录，确认工程缺口。
- [x] A 端：人工审核 industry/medium/task 标签、版本绑定、严格字典和发布门禁。
- [x] B 端：广告/设计参考类型、中文标签、行业/媒介/任务筛选和分享链接。
- [x] 同步：内容与撤回分别记录成功、失败和摘要，页面提供简洁状态与按需详情。
- [x] 两端协议/服务测试、真实浏览器交互、跨端发布包消费验证。
- [ ] 本地完整门禁、独立审查、开发分支交付与记录实际运行结果。

## 分工与文件边界

- A 端标签代理：Omni 工作台存储/审核/发布/API/UI 与测试；保留现有 POTW 未提交改动。
- B 端同步代理：Nova replica/worker/service 状态、Prisma 增量迁移、TS/Python 状态契约与测试。
- 主任务：Nova 目录检索纯函数、页面筛选和状态展示、整合与验证。

## 已确认问题

旧 A 端发布将行业/媒介固定为 other/digital，不能解释为真实分类。旧 `legacy_medium_fallback` 必须在 B 端明确识别，避免误命中数字界面筛选。内容同步与独立撤回检查共用 lastError，不能据一次成功抹掉另一通道故障。

## 验证与限制

离线合成交互、真实服务只读检查、真实模型调用分别记录，不将单 TEST 案例命中当作业务检索成绩。没有正式素材与审核人时，本轮不作正式内容验收结论。

### 已完成实现与审查

- A 的 `nova-1` 标签绑定图片哈希、当前 revision、审核人和时间；新发布必须重新确认分类，旧不可变发布包不修改。A 独立提交 `246a1e83d8bc45a5b297d169b8cdf8efceef2c15`。
- B 识别广告/设计参考；行业、媒介、任务使用中文标签并支持中文关键词。四维条件共同提交，链接与刷新恢复保留 workspace / conversation 范围。
- 历史 `legacy_medium_fallback` 在投影层清除默认分类，显示待补审；不作为筛选或模型证据。引用 legacy 案例的旧回答不再进入模型 history，界面历史与序号引用保留。
- 内容与撤回分别记录尝试、成功、失败时间与安全错误；基于单调尝试时间避免旧请求覆盖新状态。相同版本的有效检查也刷新成功时间；撤回失败不允许推进内容。
- 审查补修停用旁路：服务端不读/返回案例，客户端关闭详情与选图并清缓存，停用后历史/详情不继续请求。
- 增量迁移 `20261026130000_inspiration_sync_channels` 仅增加七个可空状态字段，不重写案例、签名或旧成功记录。

### 本地验证（部署前）

- A：全库 659 通过；9 个失败在原 HEAD 干净快照同样复现，为已有 httpx/Pydantic 版本与缺失 Scrapy 的环境基线。本轮分类 30 项和原审核/发布/安全 60 项通过。
- A 真实 API + Chrome 离线素材交互 27 项；B 真实 Chrome 28 组，覆盖桌面/390px、筛选恢复、独立状态、停用与缓存，不产生业务写入、外网或模型请求。
- B 第一轮完整 L1：2,349 项通过；AI：677 项通过，只有现有依赖弃用警告。追加 legacy history 定向 7 项通过，最终交付门禁结果另记。
- `pnpm -F web typecheck`、低内存模式 `pnpm -F web build`、`bash cds-release.sh check`、`node --test scripts/test-project-release.mjs` 通过。首次并发运行因 Windows 提交内存不足导致 esbuild/Next worker 退出；限制测试并发与启用现有 `NOVART_LOW_MEMORY_BUILD=1` 后通过，未关闭检查。
- 服务器只读预检：Omni 健康，31 个素材，SQLite integrity=ok；POTW 两模块和 collection 的 SHA-256 与本地原有变更一致。本轮保留这些运行代码，不把未提交用户文件随意纳入 Git 提交。
- 未调用新的付费模型；真实 PostgreSQL、跨 A/B 发布包和开发部署回执继续补录。
- 最终包含停用与历史上下文修复的完整 L1 **2,354 项通过**（web 2,003 + contracts 312 + UI 39）；最终 typecheck 与低内存生产 build 通过。部署前门禁全绿，既有非阻断 lint/依赖警告保留。

### 隔离 PostgreSQL 与跨端发布包验收

- 本机 Docker 引擎不可用，改用 [PostgreSQL 官方 Windows 页](https://www.postgresql.org/download/windows/) 指向的 [EDB 二进制发行包](https://www.enterprisedb.com/download-postgresql-binaries)：PostgreSQL 16.15。程序与数据仅保存在仓库忽略目录 `.novart-build/postgres-isolated/`，未安装系统服务或修改全局配置。
- 新建独立数据库 `nova_inspiration_isolated`，仅监听 `127.0.0.1:55432`。48 个 Prisma 迁移全部执行成功，包含本轮七字段增量迁移；未连接远程或共享数据库。
- `scripts/test-inspiration-db.ts` 实测 **28 PASS**。使用当前 `D:/coding/OmniSignal-ad-workbench` 的真实 Python 审核适配器和 Ed25519 发布器生成合成测试包，再由 Nova 真实协议校验、事务和数据库消费。新增覆盖人工分类贯通、中文检索、广告/参考筛选、旧默认标签不污染检索且原始签名记录保持不变，以及两通道错误隔离、相同撤回版本刷新、摘要核验、租户隔离和恢复检查。
- 机器可读结果：`.novart-build/inspiration-integration/cc74526c-82db-4d5f-8616-c5f72a0b62e5/result.json`。这些素材均为合成技术测试样本，付费模型调用为 0，不代表正式案例质量或模型效果验收。
- 测试脚本清理本轮精确创建的用户与工作空间后，SQL 核验 `User`、`BrandWorkspace`、`InspirationState` 均为 0；48 条迁移记录保留。临时 Postgres 已正常关闭，55432 端口已关闭，为兼容 Windows 中文路径建立的临时 ASCII junction 已核对目标后移除。发行包和空测试库保留在忽略目录，未加入 Git。

## 本轮体验范围

本轮只更新灵感独立开发版，主产品 main 与正式站不随之发布。使用已有账号打开灵感页，先查看“内容更新 / 撤回检查”，再按案例类型、行业、媒介、设计任务和关键词查找；筛选链接可以刷新恢复。需要追踪版本时展开“查看更新详情”。

现有正式用途仍未确认，Nova 保留的是一个自有 TEST 包装参考案例。它的历史发布包没有人工分类，应显示“分类待补审”，不会命中行业/媒介/任务筛选；这是刻意拒绝使用旧默认标签。Omni 以后审核素材时需确认真实分类，必要时同时复核因 revision 变化而过期的设计分析，再发布新不可变版本。不会为了演示筛选而修改旧签名包或放行第三方候选。

广告与设计参考两类的技术筛选已用合成包完整验收；真实业务内容质量、20 个以上案例评测和持续运行验收仍需要后续正式试点材料，不把本轮工程结果替代为业务结论。

## 开发版部署回执

- Nova 代码 `75e5f2a9a819c2703331bae2964d9ade25d12f79` 已推至 `devUpdate1012`，未并入 main。
- 同 SHA 的 [CI 40278124891](https://github.com/nickzhang2999-dev/brandai-platform/actions/runs/40278124891) 与 [Branch Image 40278077378](https://github.com/nickzhang2999-dev/brandai-platform/actions/runs/40278077378) 均成功后，通过 CDS canonical deploy 执行；部署运行 `dr_d250d70d1981b90f80459637` 到达 deployed。
- web、worker、ai 的实际运行 SHA 与提交文件 hash 均已核对；七字段迁移成功、无回滚；web 和 worker 的 `/knowledge/v1/latest` 与 `/withdrawals/latest` 均为 200。保持 prebuilt=true，分支 profileOverrides 与 extraProfiles 不变。
- canonical 预览地址：[灵感独立开发版](https://devupdate1012-brandai-platform.geole.me/inspiration?workspaceId=cmvg9rcdg0008o22loor14oln)。公网真实账号浏览器结果另记下方。
- Omni 使用 `omnisignal-ad-workbench:20261026-reviewed-taxonomy-246a1e8`。第一次切换被验收脚本把构建专用文件误列为运行文件而触发回退；旧版健康恢复后，修正检查为 Docker 实际复制的 143 个运行文件，用同一镜像重试成功，未修改运行代码规避检查。
- Omni 新版 healthy，认证 taxonomy API、新前端资源、POTW 可用；31 个素材与 assets/releases/plans/analysis_jobs、图片、发布目录、账号、签名密钥及四个挂载核对保持一致。缺分类/过期分类的发布 409 使用同镜像隔离合成库验收，没有改真实素材审核。
- Omni 回退备份：`/opt/omnisignal/backups/reviewed-taxonomy-20261026-246a1e8-retry1`；首轮自动回退证据单独保留。部署产物及私密运维记录未加入 Git。
- CDS 镜像事件关联曾显示 `timed_out_no_run`，但同 SHA GitHub 实际成功。通过 canonical `claim-prebuilt` 的服务端 dry-run 验证后正式认领，状态恢复 ready/success；没有手工改写状态、重复部署或切换模式。

## 真实登录验收追加修复

真实 Chrome 正常登录发现早期 SSR 表单缺少 method 且输入/提交按钮已可用，React 的 submit handler 尚未接管时会按浏览器默认 GET 导航。只读复核确认：首屏 nativeMethod=get、控件未禁用、handler 未附着，约 3.8 秒后 handler 附着；没有脚本加载错误。CDS 的常驻 EventSource 使 networkidle 不适合作为页面就绪条件。

该问题按真实缺陷处理，未以测试等待或 API 直登绕过：登录表单设置 `method=post`，客户端就绪之前禁止输入/提交，显示准备状态与无 JavaScript 提示；原有正常鉴权与 callback 范围规则保持。新增真实 SSR→延迟 hydration 浏览器回归，使用合成账号；真实验收失败记录中的导航字段已脱敏，未在日志保存凭据。修复交付回执待下方补录。

- 新增 `scripts/test-login-hydration-browser.cjs`：真实组件 SSR 与 hydrateRoot 同节点接管、脚本延迟/关闭、正常提交、失败重试、callback 保留、原生 POST 后备共 13 项通过；4 次合成登录 POST、1 次强制原生 POST、0 凭据 GET、0 外网/浏览器异常/React hydration 告警。接入已有 CI 交互步骤。
- 登录修复后的完整门禁再次通过：L1 2,354、AI 677、typecheck、生产 build、两个发布检查。
- 初版 75e5f2a 的真实账号灵感页子集检查 106 项通过（1440/390px，30 业务 GET、0 业务写）。登录早期提交失败单独保留，不能被这次子集通过覆盖；中途一次健康检查超时后恢复，未推断网络根因。
