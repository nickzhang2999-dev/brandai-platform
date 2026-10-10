# Novart 独立图片存储｜验收环境

本批为独立产品项目 `98cfea6cdcbd` 准备存储，不复用公司素材桶或存储凭据，不修改公司 main。旧导入 `473923091fca` 未创建存储；后续审批 `3d3d941a2c50` 已真实批准，创建了项目 scope 的 `novart-storage`，回读状态为 stopped、映射 15814 → 3900。**服务实体创建不等于存储可用：启动前核对又发现项目密钥变量为空，以及配置相对挂载会错误指向 CDS 自身仓库。当前修正草案改为预构建镜像内置配置，尚待新 CI、平台审批和真实运行验收。** 未创建实际 bucket、应用 key 或业务对象。

旧故障中保存 YAML 有完整 Garage 声明，实际 infra 却没有 novart-storage，Web/Worker 保留其依赖。服务端 lint 未发现遗漏；只读 resync/preview 锁定 expose-only 被忽略，加 ports 能识别 Garage。随后审批创建的实际实体保留了完整启动命令、两命名卷和只读 bind；但读取线上 CDS 提交 `03836f8cb` 的源码后，确认 infra 相对 bind 拼接 `config.repoRoot`，并不使用产品 repoPath 或目标分支 worktree，分支部署还会自动先启动所需 infra。[绑定实现](https://github.com/inernoro/prd_agent/blob/03836f8cbd90da7678cd3f5b0a3f1e09d5a398ec/cds/src/services/container.ts#L2925)、[自动启动依赖](https://github.com/inernoro/prd_agent/blob/03836f8cbd90da7678cd3f5b0a3f1e09d5a398ec/cds/src/routes/branches.ts#L13217)。当前草案移除该主机 bind，通过镜像 COPY 获取配置。详细历史证据见 [CDS 问题](cds-development-issues-2026-10-10.md)。

## 配置范围

- `deploy/novart/storage/Dockerfile` 基于 Garage **v2.4.1** 官方多架构摘要 `sha256:9c96caa2612d3411acc5b0e6701fb238dbfba33e533a6d7d3d811a4b12d0d020`，只 COPY 无密钥 TOML，发布为 `ghcr.io/nickzhang2999-dev/brandai-platform/novart-product-storage:sha-<完整提交 SHA>`。构建上下文仅为 `deploy/novart/storage`，不包含私有控制目录或应用凭据。
- 两份独立 compose 的新草案使用 `NOVART_GARAGE_IMAGE_SHA` 精确镜像引用，移除相对 TOML bind；两个项目专属卷分别存元数据和图片。配置从镜像内 `/etc/garage.toml` 读取，RPC 只监听容器 loopback。新镜像引用尚未导入实际服务。
- S3 声明 `ports: ["3900"]`。CDS 会分配宿主机 TCP 端口；当前不能保证仅容器内部或仅 loopback 可达。管理接口单独监听容器内 `0.0.0.0:3903`，compose 不发布 3903、不设置 CDS HTTP 管理入口。无网站服务或匿名公开桶，**无 HTTP 入口不能等同于没有 S3 TCP 暴露**。部署后须核对真实绑定地址、网络可达性及 3903 未被宿主机映射。应用凭据只计划授权新桶 `novart-product-assets` 的读写，不可管理或创建其他桶，尚未实际创建或验收。
- 两份 compose 的 `NOVART_GARAGE_ADMIN_TOKEN` 仅为空占位符；只有 Garage 的服务环境显式引用为 `GARAGE_ADMIN_TOKEN`，不写入 Web/Worker 的服务环境。实际令牌由独立私有配置提供，与 RPC secret、应用 S3 key 分开。TOML 不含任何令牌；管理请求需 Bearer 鉴权。启动命令固定为 `/garage -c /etc/garage.toml server --single-node`，不使用会创建默认桶或授予额外权限的 default flags。
- 初始内存上限 512 MiB、块缓冲 64 MiB；属于待测预算，不是运行峰值保证。
- Web 与 Worker 设置 `AUTO_COMPLIANCE_V1=0`。用户这次授权一张 1K 普通生图，不额外调用 VLM、分层、改图或 EXACT。

版本、命令与权限按[官方发布记录](https://garagehq.deuxfleurs.fr/_releases.html)、[v2.4.1 CLI 源码](https://raw.githubusercontent.com/deuxfleurs-org/garage/v2.4.1/src/garage/cli/structs.rs)核对。官方镜像没有 shell，不在启动命令中假设有 shell/curl。配置采用单节点；[官方快速开始](https://garagehq.deuxfleurs.fr/documentation/quick-start/)明确该模式没有冗余，因此本批仅称独立验收 / staging，备份恢复实际演练前不能称完整生产存储。

## 已执行检查

以下 compose 校验是**上一份官方镜像 + 主机 bind 草案**的历史证据，不代表新的内置配置镜像已通过运行验收。读取审批后实体时 env 仅返回星号掩码；项目 scope 中 RPC/admin 两变量当时实际为空，因此不能把实体 env 非空当作配置完成。

TOML 解析与配置范围、补丁匹配检查通过。旧 expose 版本两份官方 CLI 本地 verify 为 0 error / 2 warning / 6 info；两条 warning 是原 AI/Worker 命令没有 migration 关键词，没有因此添加并发迁移。本地 parse 保留两个卷、健康检查和内存限额，将存储分类为基础设施。旧版服务端 `/api/compose/lint` 返回 200、findings 为空，却漏过服务转换问题；不能把 lint 通过当作部署成功。

当前端口与管理接口合并草案已重新检查：两份 compose 的官方本地 verify 均为 0 error / 2 warning / 6 info；两次真实 server lint 均 findings=0；两次项目级 resync/preview 均恰好新增 `novart-storage` 一项，containerPort=3900、更新 0、删除 0。预览前后实际 compose、环境、infra 和 profiles 内容一致，未调用 import、execute 或部署。两份 Garage 配置完全相同；除新增管理员变量空占位符、Garage 环境引用和显式配置路径启动命令外，其他配置值与本批修改前严格一致。TOML 仅新增不含凭据的 admin 监听。预览未返回新增项的 scope/projectId，实际对象仍需审批后回读验证；真实管理接口可达性和初始化尚未测试。

官方只读差异预览已核实：原 expose-only 版本新增 0 项；仅改回环端口声明的假设新增 Garage 1 项，更新和删除均为 0；真实 MinIO 镜像的独立假设也能识别，未拿其冒充 Garage。三个预览前后，实际项目 compose、环境、基础设施和 profile 内容没有变化。新增项预览只返回 id/name/image/containerPort，不返回绑定地址、卷、健康检查或内存限制，因此这些仍须部署后验证。

项目真实 infra 实体包含 `projectId`、`scope`、`containerPort`、`hostPort` 和 `volumes`；现有 PG/Redis 为本项目 scope，并保留原命名卷。字段权威接口明确 ports 由平台分配宿主机端口；expose 和 mem_limit 被标为未登记字段。对当前 PG/Redis 宿主机端口的外部 TCP 连接未成功，只能说明该次连接未确认，不能据此证明私有绑定或替 Garage 作保证。

私有控制配置移除本次新增项后，与原配置结构和值严格一致，原数据库、队列、会话加密材料和三个 prebuilt profiles 保留。根公司 `cds-compose.yml` 未纳入本批变更。

## 内置配置镜像的 CI 门禁

新增 `scripts/check-novart-garage-container.cjs`，仅在 Linux CI 显式环境下运行 Docker。`--static-check` 不调用 Docker 或网络。本机已通过 Node 语法、Dockerfile 静态约束及 workflow/TOML 解析；**真实容器检查尚待新的 GitHub CI，当前不标为通过。** 原有 API/UI/数据库/Worker 验收步骤保持原样；这条独立存储门禁不能替代产品真实上传验收，也不掩盖其他门禁的失败。

新增 `Validate Garage storage image and durable permissions` 步骤使用 runner 现有 PostgreSQL service 网络，随机生成新的临时容器、两个有本轮标签的命名卷、独立 RPC/admin token 和应用 key。容器不发布任何端口，runner 通过 Docker bridge 地址读取；日志与报告不输出 token、API 原响应或容器日志。检查顺序：

1. 校验镜像 revision、完整启动命令、官方 binary HEALTHCHECK；确认只有两个命名卷且没有配置 bind。
2. 等待管理 REST 与 binary 健康检查真实通过；确认单节点 layout、空白桶/密钥列表和未鉴权管理请求被拒绝。
3. 创建两个本轮临时桶与单独应用 key，只授权其中一个桶 read/write；回读确认无 owner、不可 createBucket、桶不公开、应用 key 不能用于管理 REST。
4. 使用仓库锁定的真实 AWS SDK 执行 PUT → GET → SHA256 一致；删除一个测试对象并确认 404；对另一个桶的写入/列举及创建桶请求必须真实返回 403。
5. 停止并删除本轮容器，使用相同两个卷重建；确认 layout、权限、保留对象字节和已删除对象状态不变。最后仅清理本轮标签所属的容器和卷。

安全报告固定写到 `apps/web/.novart-ui-artifacts/garage-container.json`，单独进入既有 artifact 白名单。失败保持非零退出；只有本条与原有门禁全部通过，`Publish checked Garage storage image` 才发布对应 SHA 镜像。全程无 provider 调用，不使用公司存储或真实用户对象。

## 审批后接入顺序

1. 等真实 CI 与对应 SHA 存储镜像发布成功后，只向独立项目提交内置配置镜像修正的 pending-import，遵守 CDS 人工审批，明确 S3 宿主机 TCP 端口映射及管理端口不发布。审批后回读 `novart-storage`，确认 `projectId=98cfea6cdcbd`、`scope=project`、精确镜像 SHA、已移除配置 bind、原两命名卷保留；原 PG/Redis 和三个 prebuilt 应用配置不变。
2. 在受保护的独立变量配置中生成或保留独立 RPC secret、管理员 token，回读只核对形态与一致性，不进入 Git/聊天/报告。部署已验证版本后核对镜像内配置、两个数据卷、健康检查、内存约束和端口映射。先从已部署的 Web 容器对 `http://novart-storage:3903` 做只读管理健康请求，确认网络、令牌和实际版本；不能只凭配置声明认定可达。
3. 按 [Garage v2.4.1 官方 Admin API](https://raw.githubusercontent.com/deuxfleurs-org/garage/v2.4.1/doc/api/garage-admin-v2.json) 经容器内管理接口初始化独立 bucket 与应用 key，回执只由私有控制程序捕获，不展示 secret。先 List/Get 确认现有对象与本轮记录；CreateKey 不是按名称幂等，回执不确定时必须先核对唯一对象，不自动重复建 key 或删除旧桶。应用 key 禁止创建桶，只给目标桶 read/write，不授 owner；Allow 的 false 不撤销既有权限，复用时需明确 Deny 后回读确认。管理 REST 的官方协议已核对，CDS 运行时网络与实际初始化尚未验收。Garage 是 infra，不是分支 build profile，不能把 infra ID 当成 branch container-exec 的 profileId。
4. 通过原管理员设置 API 在独立 `AppSetting` 保存完整 storage 字段。当前 `getEffectiveStorage().configured` 不仅看环境变量，单加 `S3_*` 不能启用上传。
5. 用项目现有 AWS SDK 实测 PUT → GET 的字节 SHA → DELETE；验应用 key 拒绝其他桶和管理操作。
6. 真 Worker 上传 → 画布保存 → 新会话恢复 → PNG/SVG，然后一张 1K 真模型 → 归档 → 入画布 → 重开和导出。配置存在或容器健康不代替这条验收。

应用 endpoint 使用 `http://novart-storage:3900`，region `garage`，forcePathStyle=true；URL 前缀为内部 bucket 路径，浏览器继续走同源鉴权 Asset raw 接口，不把内部 URL 当公网链接。生产可用性还需要资源观测、存储重启持久化、独立备份和恢复演练；本批未提前标为通过。
