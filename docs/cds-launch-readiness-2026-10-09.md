# 独立整合环境上线依赖与 CDS 问题 · 2026-10-09

## 本轮结论

独立整合项目的 Web、Worker、AI 和独立 PostgreSQL/Redis 正在运行，但**尚未配置真实生图服务或对象存储**。这属于部署配置缺口，不能把服务健康、默认模型名或连接测试的绿色状态当作完整产品已经可上线。

本轮只读核查了独立项目，未复制公司凭据或用户数据、未调用付费模型、未写入远端对象存储、未导入 compose、未审批或部署。常规工作可按用户授权推进；平台要求人工签署的配置审批仍需遵守。

生成批次收尾复核：公司 main `e99919a/running`、公司整合分支 `f968f1a/idle`、独立整合分支 `8474347/running`；公司原项目 `githubAutoDeploy=true` 且 push 策略为 true。此次使用官方 CLI 只读项目/分支状态，未重新执行配置、容器健康或供应商检查；下方服务配置证据仍以原核查时间为准。本地生成新代码通过四项门禁，也不能绕过尚未解决的分支发布隔离直接推送。此轮未发现新的 CDS 平台故障。

## 1. 当前实测状态

核查时间：`2026-10-09T03:10:29.555Z`（北京时间 11:10）。项目 `98cfea6cdcbd`，分支 `novart-product-integration-claude-novart-product-integration`，运行提交 `8474347`。CDS CLI 本地及远端均为 `0.16.6`，版本检查返回 `latest`。

| 检查项 | 实测结果 | 解释 |
| --- | --- | --- |
| Web / Worker / AI | 均 running | 不等于外部业务依赖已接通 |
| 数据库查询模式 | `transaction_read_only=on` | 只读事务，无业务写入 |
| `AppSetting` 单例 | 不存在 | 独立库尚未保存管理员上游配置 |
| 设置加密材料 | 存在 | 当前没有密文可验证解密；不能写成“密钥解密通过” |
| image / vlm / layer 的 DB key | 均不存在 | 没有复制公司设置 |
| image / vlm / layer 的 env key | 均不存在 | 运行容器核实，与 CDS 元数据一致 |
| image 生效 provider / model | `mock` / `gpt-image-2` | 均为配置缺失后的源码默认，不证明模型可用 |
| 对象存储 DB 字段、`S3_*` env | 均未配置 | `getEffectiveStorage().configured=false` |
| 独立基础设施 | PostgreSQL、Redis | 未发现独立 MinIO |
| 内部 AI `/health` | 可达 | 只验证内部服务，不验证外部 provider |
| 外部存储/provider 可达性 | 未测 | 没有配置目标地址，不猜地址或调用默认外部服务 |

取证入口：CDS 的项目级 env metadata、live branches、infra GET，以及运行中的独立 Web 容器执行只读 `AppSetting` 查询和内部健康请求。输出仅保留字段存在性、状态、非敏感 provider/model；不保留密钥、邮箱、私有地址、请求正文或用户数据。

## 2. 配置语义：保持已有保护，不靠默认值“变绿”

依据 [settings.ts](../apps/web/src/lib/settings.ts)：

1. AI 每个字段按 `AppSetting > env > 默认` 解析；密文通过 `SETTINGS_ENC_KEY`，缺省回退 `AUTH_SECRET` 解密。没有可用 key 时落到占位 provider。仅有 `gpt-image-2` 字符串不能说明真实服务已接通。
2. 存储 endpoint/bucket/key 等也会回退 env，但 `configured` **故意只认管理员写入的 DB 字段**。源码注释记录了历史上内部 MinIO 地址不可解析/浏览器不可访问的问题；不能把任意 `S3_*` 默认值当作可用存储。
3. `configured=true` 仅说明管理员明确配置过部分字段，**不证明配置完整、密钥能解密、桶存在、读写权限正常**。这些必须另行实测。
4. `uploadBuffer()` 在未配置时明确报错；生成图 helper 在未配置时仍可能保留 `data:` URL。这是原产品的兼容路径，不能当作新画布图片持久化验收。
5. 真正的管理员页面是 `/admin/settings`，提交到 `/api/admin/settings/ai`。旧说明中的 `/admin/settings/storage`、`/admin/settings/ai` 不应直接当作已存在的页面路由。

本轮没有修改共享配置默认行为。入口及字段来源见 [管理员设置页](../apps/web/src/app/(admin)/admin/settings/page.tsx)、[管理员设置接口](../apps/web/src/app/api/admin/settings/ai/route.ts)、[S3 读写封装](../apps/web/src/lib/s3.ts)。

## 3. 最短可用配置路径

优先使用经授权的 S3 兼容存储，为整合环境分配独立 bucket 和应用凭据，再通过独立部署的管理员页面保存。此路径复用现有存储实现，不必给 CDS 新增基础设施，也不要求修改公司项目。

| 配置部分 | 要确认的内容 | 完成判据 |
| --- | --- | --- |
| 存储 | endpoint、region、bucket、访问 ID、secret、forcePathStyle；必要时设置稳定的 URL 基址 | Web/Worker 可达；同一探针 PUT→GET 字节一致→DELETE；真实上传重开后可读 |
| image provider | 经授权服务的 provider、baseUrl、实际 model ID、独立或明确授权使用的 key | 密钥解密成功；认证/模型检查；一次真实异步生成、持久化、进画布 |
| VLM / 分层 | 按实际首版暴露功能分别配置 | 未接通时明确不可用；不得把占位实现标为真实能力 |
| 加密材料 | Web 与 Worker 持续使用同一独立设置加密材料 | 重启、重部署后已有设置仍可解密 |

浏览器展示上传图片应走同源、鉴权的 Asset `/raw` 路由；无需为了显示图片把整个 bucket 公开。现有生成、AI 引用、导出中仍有 URL 消费路径，使用私有存储时必须逐一验收，不能仅凭上传显示正常宣布所有图片链路通过。

不在聊天或 Markdown 中粘贴任何配置值；管理员在独立后台填写。若公司授权复用已有 provider，先确定允许的账号/配额边界，再接入，不能自行从公司库复制密文到独立库；两套加密材料也不保证通用。

## 4. 独立 MinIO 备选审阅片段

以下是**评估环境的备选设计，尚未导入、验证镜像或部署**。仅应合并到独立控制目录的 compose，不覆盖仓库根公司 compose。单节点存储不是生产高可用方案；MinIO 官方也将 standalone 定位为早期开发/评估，生产建议使用分布式部署。启动参数、持久化 `/data` 以及凭据变量依据 [MinIO 官方容器说明](https://github.com/minio/minio/blob/master/docs/docker/README.md)。

**维护状态已复核：**截至本次查询，MinIO 官方仓库显示于 `2026-04-25` 归档；latest release 指向 `RELEASE.2025-10-15T17-29-55Z`，修复 service-account/STS 会话策略绕过，并要求容器用户从源码构建。旧官方 Compose 示例仍列更早的 tag，不能直接拿来做新生产部署。以下镜像刻意保留审核占位，只有确认维护责任、修复版本、镜像来源和 digest 后才能替换并验证；优先使用独立托管 S3 bucket，或公司存储中新建 bucket 并授予独立权限。[MinIO 官方安全发布说明](https://github.com/minio/minio/releases/tag/RELEASE.2025-10-15T17-29-55Z)

```yaml
# Merge into the INDEPENDENT deployment project's existing compose.
x-cds-env:
  CDS_NOVART_MINIO_ROOT_USER: "${CDS_NOVART_MINIO_ROOT_USER:-}"
  CDS_NOVART_MINIO_ROOT_PASSWORD: "${CDS_NOVART_MINIO_ROOT_PASSWORD:-}"
x-cds-env-meta:
  CDS_NOVART_MINIO_ROOT_USER:
    kind: auto
    hint: "Dedicated integration storage administrator"
  CDS_NOVART_MINIO_ROOT_PASSWORD:
    kind: auto
    hint: "Dedicated integration storage administrator secret"

services:
  minio:
    # Deliberately non-deployable until maintenance and the patched build
    # are reviewed. Do not replace this with a legacy image or :latest.
    image: REVIEWED_REGISTRY/minio@sha256:REVIEWED_DIGEST
    command: server /data --console-address ":9001"
    ports: ["9000"]
    environment:
      MINIO_ROOT_USER: "${CDS_NOVART_MINIO_ROOT_USER}"
      MINIO_ROOT_PASSWORD: "${CDS_NOVART_MINIO_ROOT_PASSWORD}"
    volumes: ["novart_integration_objects:/data"]

volumes:
  novart_integration_objects:
```

这是配置结构审阅件，不是可直接导入的安装成品。没有构建或发布 MinIO 镜像，未改变本机 Docker 或 CDS 基础设施。

实施前必须补齐的具体事项：

- 把片段合并进现有 `x-cds-env`、`services`、`volumes`，保留独立 PG/Redis 和所有 prebuilt 应用配置；先 `cdscli verify`，集中一次提交配置变更。
- 核对 CDS 实际生成的独立 storage 地址、网络和端口；从 Web、Worker 验证，不能假定 `http://minio:9000` 就能解析。不要新增 MinIO 控制台/AI 公网路由。
- 创建独立私有 bucket 和限制到该 bucket 的应用凭据；通过管理员设置写入 `AppSetting`。MinIO 根凭据只用于初始化/管理，不作为应用长期凭据；评审 CDS 项目环境是否会向无关容器注入根凭据。
- 不把自动建桶脚本作为每次 Web 启动步骤；幂等初始化和日常部署分开，避免再次出现 seed 改共享数据的问题。
- 建立持久卷备份、恢复演练、空间告警及独立环境回滚。正式上线应选择已落实容灾/备份的存储方案。
- 如果 CDS 将导入标记为人工审批，准备好具体 diff 与目标项目再由有权限的人审批。用户的“自动审批”授权不等于可以伪造平台人工身份。

## 5. 本轮问题分类与修复

| 编号 | 归类 | 证据 / 影响 | 处理状态 |
| --- | --- | --- | --- |
| E-LAUNCH-01 | 环境配置缺口 | 独立库无 AppSetting，运行容器也无 AI/S3 key | 已核实；等待授权配置来源，开发仍可继续 |
| E-CDS-01 | CDS 发布控制问题 | 同一提交先 skipped 后又 deployDispatched；项目级 push 开关恢复不能确保单分支隔离 | 已有实证，沿用 [10-09 日志](development-log-2026-10-09.md)；本轮未改公司开关、未重新触发 |
| E-CDS-02 | CDS 能力待确认 | 独立分支排除/冻结、投递排空界限尚无可验证方案 | 不把“没找到”写成平台永不支持；隔离明确前不推送触发公司部署 |
| E-CDS-03 | CDS 配置流程 | compose 新增基础设施需人工导入审批；这是现有权限流程 | 已准备审阅片段，尚未导入；并非服务故障 |
| E-DEPENDENCY-01 | 第三方依赖维护 | MinIO 官方仓库归档；旧示例镜像早于已公告的安全修复 | 不默认部署旧镜像；托管 S3 优先，备选片段等待维护方案确认；不归因于 CDS |
| O-STORAGE-01 | 应用诊断误报 | 旧存储测试在未配置时 `ok:true`，配置后仅 PUT/DELETE 却声称读写正常 | 已修本地代码与 12 项回归，待整体验证/部署 |
| O-STORAGE-02 | 应用诊断边界 | 旧探针无独立超时/异常清理保证；原始 upstream error 可能带私有地址 | 同批修复：有界读写与独立清理、字节校验、脱敏错误 |

本轮存储诊断修改位于 [连接测试接口](../apps/web/src/app/api/admin/settings/ai/test/route.ts)，未改 `settings.ts`。未配置返回 `ok:false, unverified:true`；配置后随机小对象执行 PUT→GET 内容一致→DELETE。读写总窗口 8 秒，清理窗口 4 秒。即使 PUT 未收到成功回包也尝试清理；版本化 bucket 使用已确认的 VersionId。清理失败明确报错，不给绿色结果。若写入超时且未返回 VersionId，不能证明版本化 bucket 中完全无遗留，失败后仍需按探针前缀排查。

12 项 [专属回归测试](../packages/contracts/tests/storage-diagnostics-route.test.ts)已通过，覆盖未配置、管理员门禁、正常读写清理、版本化对象、缺失/错误/超限内容、PUT 失败清理、错误脱敏、读取及清理双失败、读流超时、清理超时。这是本地隔离单测，未执行远端存储写入或真实 provider 调用；全仓门禁与部署验收由主任务统一执行。

## 6. 后续上线验收顺序

1. 先解决发布分支隔离，确保测试失败不会导致公司共享库启动迁移或 seed。
2. 素材适配代码跑完 CI：真实登录、隔离数据库、上传与权限、原生画布保存重开；确认精确 SHA 的镜像。
3. 配置独立对象存储，在实际部署验证探针、单张上传、鉴权读取、刷新/重登恢复、混合画布和导出。
4. 接入经授权的真实 image provider：请求迅速受理、Worker 执行、状态轮询、失败原因、产物持久化和画布引用。先完成一次可复现的小规模真实验收，再扩大使用。
5. 补上线运维项：注册/管理员边界、配额和付费调用限额、备份恢复、失败任务处理、监控、回滚；最后与公司源码做前后端差异评估并更新日志。

当前不能标记“完整上线已完成”。本报告把配置缺口、应用诊断缺陷和 CDS 发布控制问题分开记录，避免把所有失败笼统归咎于 CDS。

## 7. 分支命令覆盖能否用作发布隔离：只读短核查

核查时间：`2026-10-09T03:31–03:33Z`。**结论：存在分支级 command 覆盖入口，但尚不能证明它能阻止公司整合分支启动迁移/seed，因此本轮不采用，也未设置任何远端覆盖。**

已证实：

- 官方 `GET /api/branches/brandai-platform-claude-novart-product-integration/profile-overrides` 返回 Web、Worker、AI 的 `baseline`、`override`、`effective`。当前三个 override 仅含 `activeDeployMode` 与 `updatedAt`；Web 为 `dev`，Worker/AI 为 `release`，没有 command 覆盖样本可观察冲突优先级。
- 当前三者 `effective.command`、baseline command 与所选模式的 command 都相同。Web 命令及它的 `dev/release` 模式命令都包含 `db:push`、`db:seed`。这表明旧危险启动配置仍存在，不能把当前 idle 状态当作永久隔离。
- 已缓存的官方页面脚本 `BranchDetailPage-CfQ-1xM_.js` 与 `BranchListPage-CKTFpzMd.js` 明确提供 command 覆盖 UI；清洗函数允许 `command`、`activeDeployMode`、`dbScope` 等字段，并通过官方 profile-overrides PUT 保存，页面说明需重新部署生效。
- 官方 CLI `cmd_branch_set_mode` 明确记载该 PUT **整体替换覆盖对象**，设置模式前必须合并已有覆盖，不能只发一个字段而丢掉已有 command/env/image 配置。

仍未知，不能作安全假设：

1. 当 `override.command` 与 `deployModes[activeDeployMode].command` 不同时，运行时到底谁最后生效。GET 的 `effective` 名称与当前没有冲突的样本都不足以证明优先级。
2. CDS 是否会在执行用户 command 之前进行数据库初始化、迁移、seed，或由镜像 ENTRYPOINT / executor 初始化触发其他副作用。本次没有服务端源码或能证明完整执行顺序的接口。
3. 是否存在可供该项目使用的分支 profile 禁用、webhook 分支排除或暂停派发能力。已见公开覆盖字段没有 enabled/disabled；未发现有文档支持的能力查询路径，因此未猜测隐藏接口。这里记录的是尚未核实，不是断言平台永远不支持。

可审阅的候选方案是：若后续取得运行时顺序的权威证据，对公司旧整合分支的三个 profile 设置独立、立即失败的启动命令，使自动触发不能启动应用；同时保留其他已存在的分支覆盖。**仅替换 command 目前不够构成发布放行条件**：必须先在完全隔离的一次性项目验证所选模式、镜像 ENTRYPOINT、平台前置步骤和失败后重试，证明没有数据库/队列/存储副作用。优先采用 CDS 明确支持的分支派发禁用/排除能力，而不是用命令覆盖猜测平台行为。

本轮未调用任何 PUT/DELETE/deploy/stop/approval，未改公司 push 开关、未启动旧分支、未推送。分支级隔离仍未通过验收，继续推送仍受此项阻断；不会恢复“关 push→推送→立即开 push”的旧做法。


## 整图修改批次补记

本批未访问或变更 CDS，没有新的平台故障实证；上文现场状态仍按各自核查时间理解。当时本地生产构建被 Windows 内存提交上限阻断（Next worker 退出 134），这是开发机资源问题，不归因于 CDS。单元测试、类型检查与隔离交互通过不能替代完整构建/CI，也不作为发布放行条件。独立模型/对象存储配置、可靠分支隔离和真实端到端验收仍未完成。

## 后续：开发机低内存构建通过

本地 `0c84f4f` 基础上的可选低内存构建实际退出 0，资源限制及边界见同日开发日志。系统后台占用同时下降，未做严格前后内存峰值对照。这解除本地编译阻塞，不解除真实业务验收或发布隔离门禁。

本批官方 CLI 只读复查独立整合分支仍运行 `8474347`，Web/Worker/AI 三服务 running，尚未更新本地候选。返回信息同时包含显式版本镜像与 `deployRuntime.kind=source`，需完整核对当前实际运行模式；仅凭镜像名称不能重新确认 `prebuilt=true`。未重新探测上游配置、付费生成或对象存储，没有操作公司项目设置或业务数据。本次没有新增已证实的 CDS 平台故障。
