> **历史隔离策略已失效（2026-10-12）**：本文涉及跳过 CDS 部署的隔离做法仅用于追溯，现已停止使用，不作为当前提交或部署指令。正常开发按现行 [CDS 提交规则](cds-push-policy.md) 与 [CLAUDE.md](../CLAUDE.md) 执行；原始记录保留。

# CDS 开发部署问题具体原因报告

记录时间：2026-10-10；最新更新18:13（北京时间），以下保留各阶段历史状态，并单列最新结果。

项目：Novart / BrandAI 产品整合

开发分支：`claude/novart-product-integration`

## 结论

18:13 实际产品结果：独立55e的真实上传、单张真实生图和归档已通过，同一项目的后续7项检查完成实际插入、revision2保存、新登录恢复和PNG/SVG一致。原付费尝试因误解上传专用列表而停止的报告保持原样，续验读取同一任务，未再次生成。当前接受首版核心可用性，不将尚未验收的复杂功能或备份可靠性算作完成；下文17点期间的“待验收”是当时状态。该结果不改变四项CDS源码根因及原c38现场未定的边界。

本次已确认四项 CDS 配置处理问题。它们发生在独立图片存储的导入、配置应用及健康检查过程中；不是下面记录的 `c38d476` 容器上传失败的已证实根因。

| 问题 | 已证实行为 | 当前处理结果 |
| --- | --- | --- |
| 仅声明内部端口的服务被遗漏 | `expose` 未被转换，服务未创建却保留了对它的依赖 | 改用平台支持的端口声明，独立服务已创建 |
| 相对配置挂载基准错误 | 按 CDS 自身 `repoRoot` 展开，而非产品项目目录 | 无密钥配置已装入固定镜像，移除宿主机配置绑定 |
| 审批不更新既有基础设施 | 已存在服务 ID 被直接跳过，批准后镜像和卷仍为旧定义 | 使用正式 resync 应用已批准配置，保留命名数据卷 |
| 健康检查执行方式丢失 | `CMD` 被转换成 shell 检查，覆盖无 shell 镜像的原检查；单独修改健康检查还会被差异计算漏掉 | 清除运行时重复覆盖并保留卷重建，实际健康状态恢复为 `healthy` |

最新状态：独立产品和 Garage 已使用验证过的 `55e07ac`；Garage 当前运行且健康，单桶应用权限及应用存储配置已完成。**线上产品真实上传、保存恢复及付费模型验收仍待主线程执行**，不能把 CI 存储测试或初始化成功等同于完整上线验收。

另外一次容器上传失败仍在排查，当前不能归因于 CDS。旧评审画布约5秒后消失是旧编辑器许可检查与入口版本问题，也不能归为 CDS 关闭了画布。

## 1. 审批通过，但存储服务没有创建

### 现象与证据

首次配置导入 `473923091fca` 获批后，保存的 Compose 有 `novart-storage`、两个独立数据卷及配置挂载；实际基础设施却只有原 PostgreSQL 和 Redis。与此同时，Web、Worker 的依赖列表已加入 `novart-storage`。

导入前官方 `/api/compose/lint` 实际返回200、findings为空。导入回执的 addedInfra为空。**平台保存了配置和依赖，却没有创建依赖指向的服务，也没有阻断或明确提示。**

### 具体原因

这一导入路径没有承接原来的 `expose: ["3900"]` 声明。官方 `infra/resync/preview` 只读对照结果如下；没有执行同步：

| 输入 | 新增服务 | 更新 / 删除 |
| --- | --- | --- |
| 原 Garage 镜像 + expose3900 | 0 | 0 / 0 |
| 同一 Garage 镜像，仅改为 ports声明 | 1 | 0 / 0 |
| 独立 MinIO 镜像 + ports对照 | 1 | 0 / 0 |

因此，可以把遗漏定位到 **expose-only 的服务识别/转换路径**；不能说 Garage 被镜像白名单禁止。后续已锁到当前版本 [compose-parser.ts:614–617](https://github.com/inernoro/prd_agent/blob/03836f8cbd90da7678cd3f5b0a3f1e09d5a398ec/cds/src/services/compose-parser.ts#L614)：基础设施分支仅调用 `extractContainerPort(entry.ports)`，取不到端口就跳过，没有读取 `entry.expose`。这与上述实际差异预览一致。

平台侧还有一个独立缺口：配置校验没有核对“每个 dependsOn 是否对应实际创建的服务”，导致出现悬空依赖。

### 影响与处理状态

在首次导入后的阶段，图片存储不存在，上传和生图结果无法在这个独立环境完成持久化。此时即便应用配置显示正常，也不能开始真实模型验收。

修正配置 `3d3d941a2c50` 实际获批后，16:13 的回读确认 Garage 实体已创建，归属独立项目 `98cfea6cdcbd`、scope=project，命令和两个命名卷保留；**当时服务为 stopped，没有把配置创建算作运行成功。** S3端口由CDS映射到宿主机；管理端口没有声明宿主机发布。此后镜像应用及健康恢复的过程见第3、4节，最新状态已为运行且健康。

### 建议 CDS 修复

1. 支持仅内部端口的服务，或在导入时明确拒绝并说明原因。
2. 对转换后的真实实体再次校验依赖；缺失依赖必须阻断，不能只保存 YAML。
3. 审批结果逐项显示“已创建、未支持、已忽略”，不能让“批准成功”被理解为完整配置已经生效。

## 2. 基础设施相对挂载指向了 CDS 自身目录

### 具体原因与源码位置

当前线上 CDS 版本经 `/api/self-status` 核对为 `03836f8cb`，对应完整构建SHA为 `03836f8cbd90da7678cd3f5b0a3f1e09d5a398ec`。该版本基础设施启动代码对相对 bind 路径使用：

```ts
const hostPath = v.name.startsWith('/') ? v.name : `${this.config.repoRoot}/${v.name}`;
```

其中 `this.config.repoRoot` 是 CDS 自身仓库根目录，不是当前项目的 repoPath，也不是目标分支工作目录。见[当前版本 container.ts:2925](https://github.com/inernoro/prd_agent/blob/03836f8cbd90da7678cd3f5b0a3f1e09d5a398ec/cds/src/services/container.ts#L2925)。源码行号已用原始文件重新核对。

我们声明的 `./deploy/novart/storage/garage.toml` 因此会按 CDS 自身目录展开。把文件提交到产品分支，不会自动使这个挂载读到该文件。

分支部署还会先启动显式依赖的基础设施，见[branches.ts:13217](https://github.com/inernoro/prd_agent/blob/03836f8cbd90da7678cd3f5b0a3f1e09d5a398ec/cds/src/routes/branches.ts#L13217)。所以直接部署应用，也不能绕过错误的存储挂载。

### 证据边界

当时的真实 Garage 实体确实保留了该相对挂载；路径展开规则由当前版本源码确认。我们在启动前发现并移除了这一挂载，**没有实际触发由该相对路径造成的 Garage 启动失败，不把预测的容器报错写成已发生事故。** 后续实际发生的健康检查异常是第4节的另一问题。

### 项目修复方案

新增固定官方 Garage 基础镜像的预构建镜像，把无密钥 TOML 配置在构建时装入 `/etc/garage.toml`，移除宿主机相对配置挂载。运行时仍使用独立密钥和原两个命名数据卷。

镜像发布前新增真实容器验收：管理鉴权、应用key仅一桶读写、实际S3写入/读取SHA、越权拒绝，以及同卷重建后的数据恢复。本机没有启动Docker；上述检查已在 `55e07ac` 的隔离 CI 中真实通过，14项检查全部为 true，随后存储镜像发布成功。该验收使用临时容器和卷，不能代替线上产品上传验收。

### 建议 CDS 修复

明确项目级相对路径的基准，解析到对应项目/版本目录；启动前检查文件存在与类型，并在审批页显示最终解析路径。预构建模式也应明确哪些仓库文件会被准备到挂载位置。

## 3. 新配置已批准，但既有 Garage 仍保留旧定义

### 现象与源码原因

固定镜像配置的导入 `771ff364a32e` 实际获批，批准内容包含 `55e07ac` 存储镜像并移除旧配置 bind；但实际 Garage 实体仍为原始镜像和三个挂载。两个命名数据卷一直存在，不能将残留的配置挂载描述为数据卷丢失。

当前版本 [pending-import.ts:411–418](https://github.com/inernoro/prd_agent/blob/03836f8cbd90da7678cd3f5b0a3f1e09d5a398ec/cds/src/routes/pending-import.ts#L411) 按项目收集已存在的基础设施 ID，并在遍历导入服务时直接跳过这些 ID。因而“已批准”只证明审批完成，不证明既有服务的镜像、卷或启动参数已经更新。

### 实际处理及边界

使用官方 `POST /api/projects/:id/infra/resync/preview` 确认只更新 Garage，再对完整、已批准且摘要一致的 Compose 单次调用 `infra/resync/execute`，明确 `deleteVolumes:false`。不能只传 Garage 片段，否则未列出的 PostgreSQL、Redis 会被识别为删除项。

更新实现见 [project-infra-resync.ts:324–358](https://github.com/inernoro/prd_agent/blob/03836f8cbd90da7678cd3f5b0a3f1e09d5a398ec/cds/src/routes/project-infra-resync.ts#L324)：它会重建变更服务，保留宿主端口、容器名称和命名卷，并用项目现有环境变量启动。执行不是单纯保存配置，必须同时核对返回错误及实际实体。

本次单次执行已成功确认：镜像精确匹配 `55e07ac`，两个命名卷保留，旧配置 bind 消失；PostgreSQL、Redis、应用 profiles 及项目环境值在 resync 前后均未改变。该一致性证据覆盖本次 resync 前后，不追溯宣称没有完整快照的审批前后环境值也完全一致。

该版本接口没有预览令牌或 `expectedState` 原子比较门禁；执行前后回读和独占操作只能缩短竞态窗口。建议平台在审批页明确“已批准、已保存、既有服务待应用”的区别，并提供带状态版本校验的应用操作。

## 4. 健康检查被改成 shell 执行，且健康配置变化未被同步识别

### 实际故障及源码链路

`55e07ac` 镜像自带直接调用 `/garage` 的 exec 健康检查，在真实 CI 中通过。CDS 启动后服务状态仍为 `running`，但官方健康接口实际返回 `unhealthy`。已确认 `novart-storage` ID 唯一并属于独立项目，排除了健康接口按裸 ID 查找时误读其他项目的可能。

原因链路有两段：

1. [compose-parser.ts:1337–1346](https://github.com/inernoro/prd_agent/blob/03836f8cbd90da7678cd3f5b0a3f1e09d5a398ec/cds/src/services/compose-parser.ts#L1337) 把 `CMD` 和 `CMD-SHELL` 都转换成同一个命令字符串，丢失原始执行形式。
2. [container.ts:2941–2946](https://github.com/inernoro/prd_agent/blob/03836f8cbd90da7678cd3f5b0a3f1e09d5a398ec/cds/src/services/container.ts#L2941) 将该字符串传给 Docker `--health-cmd`，用 shell 形式覆盖镜像原有检查。Garage 的固定基础镜像没有 shell，因此这一转换不兼容。

可见的运行时证据是健康接口的 `unhealthy`，随后移除覆盖并重建后变为 `healthy`。现有官方健康接口和诊断摘要没有提供 Docker `Health.Log`，因此本报告不声称亲自读到了 `/bin/sh not found` 等具体 stderr，也不把健康检查失败写成 Garage 主进程崩溃。

### 同步遗漏与实际修正

另一个相关缺口在 [project-infra-resync.ts:53–76](https://github.com/inernoro/prd_agent/blob/03836f8cbd90da7678cd3f5b0a3f1e09d5a398ec/cds/src/routes/project-infra-resync.ts#L53)：用于比较的 `dockerRunSignature` 不含 `healthCheck`。[第173–175行](https://github.com/inernoro/prd_agent/blob/03836f8cbd90da7678cd3f5b0a3f1e09d5a398ec/cds/src/routes/project-infra-resync.ts#L173) 据此将仅修改健康检查的服务判为 `noChange`。所以只改 Compose 的健康检查，不能假定同步已经应用。

本次主线程通过官方项目限定的 `PUT /api/infra/:id?project=98cfea6cdcbd` 仅清除运行时 `healthCheck`，再重建该服务，使镜像自带的 exec 检查生效。接口依据为 [branches.ts:20645–20660](https://github.com/inernoro/prd_agent/blob/03836f8cbd90da7678cd3f5b0a3f1e09d5a398ec/cds/src/routes/branches.ts#L20645) 及 [restart:20739–20754](https://github.com/inernoro/prd_agent/blob/03836f8cbd90da7678cd3f5b0a3f1e09d5a398ec/cds/src/routes/branches.ts#L20739)；底层 [container.ts:3126–3127](https://github.com/inernoro/prd_agent/blob/03836f8cbd90da7678cd3f5b0a3f1e09d5a398ec/cds/src/services/container.ts#L3126) 删除容器时不删除命名卷。

回读确认当前 `running / healthy`，原镜像、两命名卷、端口、命令和环境均保留。**原审批 `771ff364a32e` 记录没有被改写，仍包含旧健康检查；当前运行时定义已清除该覆盖。两者存在已记录的差异，不能声称完全一致。** 后续若从旧批准配置重建，可能再次引入覆盖，需同步维护后续配置配方。

建议平台保留 exec 与 shell 两种健康检查的原始语义，并将健康检查配置纳入差异计算。当前两卷和端口检查来自实际服务实体及操作前后比较；没有官方完整 Docker inspect 的字段，不扩大声明为已逐项读取真实 `Mounts`、`PortBindings`。

## 5. 先前自动部署与共享数据库问题

这是10月8日发生、10月9日审计确认的历史问题，不是本日新故障。

原因是 Git 分支推送仍被公司原 CDS 项目的 webhook 接收，而部署 profile 沿用共享数据库。此前临时恢复自动部署开关后，还出现延迟派发，因此“推送结束”和“当前分支已停止”不能证明后续不会启动。

意外启动的是公司CDS项目里的整合分支，不是合并或部署main；影响共享库的关键是该分支仍使用了同一数据库。

这里是平台触发机制与项目配置、启动脚本叠加产生的事故：CDS 接收并派发了推送事件，应用启动流程执行迁移和seed，部署配置又指向共享数据库。不能将数据库变化单独归因于 CDS，也不能将“没有合并main”理解为“不会影响共享数据”。

只读审计确认最后一次意外部署执行了迁移和seed：增加四张工作台状态表、新建演示品牌及关联合规词，并执行套餐upsert。缺少变更前快照的套餐字段，无法判断前后业务值；没有擅自删除或回滚。详见[共享库审计](cds-shared-audit-2026-10-09.md)。

当前采用独立部署项目、独立PG/Redis，并为每次提交保留 `[skip cds]`；推送前后做精确SHA自检，另核对真实签名webhook回执、公司分支及近期部署记录。`b778553`、`c38d476`、`55e07ac` 的实际派发均为skipped。最新按相同非live接口口径核对，公司三个分支登记基线未变，最近部署仍为此前记录，没有本次提交的新派发。本日未部署公司main或写入共享业务数据。

登记信息与实际运行信息必须分开：公司预览分支非live登记为 `52e95a5`，live回读为 `f720c44`，后者与10月8日最后部署记录相符。这是已存在的两种口径差异，不是本轮修改；不能把登记 SHA 当作当前容器版本。公司 main 为 `e99919a`，整合分支保持停止，登记为 `f968f1a`。

平台长期应提供可核验的项目/分支触发范围和延迟任务排除机制；不能依赖临时关开webhook实现隔离。

## 6. 当前不能归为 CDS 故障的事项

| 事项 | 已确认原因或现状 | 归因 |
| --- | --- | --- |
| 旧评审画布与工具栏约5秒后消失 | 右侧入口仍运行旧捕获编辑器；其许可检查延迟卸载画布。新版自研编辑器尚未替换该入口 | 旧编辑器集成与入口版本问题 |
| `Cross-origin write rejected` | 代理后的Host与浏览器Origin不同，应用原来源判断误拦；已增加公开Origin配置修复 | 应用对代理的适配问题 |
| 匿名裸 `/workflow` 返回登录307 | 应用中间件原先只匹配 `/workflow/`，漏了裸接口；已修正为JSON401并实测 | 应用路由边界问题 |
| 权限验收匹配到两个alert | Next隐藏announcer与真实权限错误同时匹配；已给真实提示专属定位，拒绝和404断言保留 | 测试定位问题 |
| `c38d476` 构建后容器中一次上传任务FAILED | 首页及第一张画布上传成功，第二张上传202后进入FAILED；日志没有保留该任务原因，清理后证据不足 | 原因未定；已补清理前脱敏诊断，`55e07ac` 后续CI通过，但不能据此倒推旧失败原因 |
| 独立存储初始化第一次在版本门禁停止 | Garage 实际返回 `v2.4.1`，本地操作脚本只接受 `2.4.1`；集群健康、单节点及布局均正常，当时桶和密钥数量均为0 | 操作脚本协议假设过窄；已精确兼容这两个版本值，非CDS故障 |

其中上传FAILED不是120秒等待耗尽，也没有浏览器错误证据。不能只凭“发生在容器验收”就断言是CDS、S3或用户关闭页面造成。本文四项CDS原因均有独立证据，但没有证据将它们与该次CI上传失败建立因果关系。

## 7. 验证结果与当前发布边界

- `b778553` / CI `38036388613`：完整success，真实后端95项、实际页面15项及构建后容器复验通过，Web/AI镜像已发布；未调用真实AI模型。
- `c38d476` / CI `38037077233`：源运行95项后端/15项UI通过，构建后API通过，但UI出现上述上传FAILED；该候选未完整通过，不部署。
- 上传诊断19项定向测试、本地全量L1 958项、AI 365项、Web类型检查及生产构建通过。
- `55e07ac` / CI `38039517128`：完整success，原应用验收、构建后容器验收及新增Garage真实存储门禁通过，Web/AI/Storage镜像已发布。Garage临时容器的14项检查全部通过；该证据明确 `realProvider=false`、`realProductUpload=false`，不冒充线上AI或产品上传结果。
- 独立线上产品已部署精确 `55e07ac`。Garage已切换同版固定镜像并恢复健康；旧独立评审入口 `9e5e2af` 不属于此次产品部署，不能混用两个入口判断进度。
- 新存储独立RPC和管理员密钥已生成，回读确认只有两项新字段发生变化；密钥不进入报告/Git/聊天。
- 17:47 的初始化回执确认：独立单桶应用key仅可读写目标桶，无owner或创建桶权限；应用存储配置保存成功，其他模型/VLM/图层及注册设置保持不变，自动合规关闭。此回执明确线上S3字节验收尚未执行、`productionReady=false`，不能直接标为完整上线。
- 真实模型已获准小规模复用，截至上述回执实际调用次数仍为0。下一步由主线程完成线上真实上传、保存重开及持久化验证，再执行单张1K普通生成；这些结果尚不包含在本报告的通过项内。

## 8. 本地脱敏证据索引

以下均为元数据、布尔验证或固定错误分类，不含凭据和业务正文：

| 证据文件（相对 `D:/coding/.novart-tmp/`） | 证明内容 |
| --- | --- |
| `garage-staging-review/admin-compose-review-proof.json` | 官方verify、serverlint、只读差异预览及候选摘要 |
| `garage-staging-review/approval-3d3d941a2c50-postapproval-proof.json` | 实际审批、project scope、服务/卷/命令回读 |
| `garage-staging-review/garage-start-prerequisites-proof.json` | 当前CDS版本、真实相对挂载及源码位置；早期密钥空值为历史快照 |
| `garage-private-env-proof.json` | 后续独立两项密钥设置成功、其他环境值不变 |
| `product-real-push-receipt-b778553.json` | 实际签名投递被跳过，公司基线不变 |
| `product-real-push-receipt-c38d476.json` | 后续实际签名投递被跳过，公司基线不变 |
| `product-real-push-receipt-55e07ac.json` | 最新提交实际派发被跳过，以及当时公司分支登记基线 |
| `garage-ci-55e07ac-proof.json` | 真实CI存储14项通过；没有真实模型调用 |
| `garage-resync-55e07ac-result.json` | 已批准镜像配置单次应用、两卷及其他服务保留 |
| `garage-runtime-health-55e07ac-proof.json` | 修正前真实unhealthy、health覆盖及官方源码依据 |
| `garage-runtime-health-result.json` | 清除运行时覆盖后healthy，镜像/卷/端口/环境不变 |
| `garage-cluster-response-proof.json` | 实际版本含v前缀、单节点健康、诊断时桶/密钥均空 |
| `garage-bootstrap-55e07ac-result.json` | 独立存储初始化及设置保存完成，仍未做线上字节/模型验收 |
| `novart-runtime-final-readonly-55e07ac.json` | 最新健康回读、公司登记/live两口径和旧部署记录、批准配方与运行时health差异 |

GitHub真实验收记录：[早先已通过批次](https://github.com/nickzhang2999-dev/brandai-platform/actions/runs/38036388613)、[出现容器上传失败的批次](https://github.com/nickzhang2999-dev/brandai-platform/actions/runs/38037077233)、[新增Garage真实验收通过的55e07ac批次](https://github.com/nickzhang2999-dev/brandai-platform/actions/runs/38039517128)。后续修复和实测结果继续追加至[当日开发日志](development-log-2026-10-10.md)。
