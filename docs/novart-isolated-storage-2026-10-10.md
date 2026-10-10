# Novart 独立图片存储｜验收环境

本批为独立产品项目 `98cfea6cdcbd` 准备存储，不复用公司素材桶或存储凭据，不修改公司 main。**旧导入473923091fca已批准，但存储服务未被转换创建；本次端口修正仍需新一轮平台人工审批，不能沿用旧批准直接部署。** 未创建存储服务或实际对象。

回读保存 YAML 有完整 Garage 声明，实际 infra 没有 novart-storage，Web/Worker 却保留它的依赖。服务端 lint 未发现遗漏；官方只读 resync/preview 对照锁定 expose-only 被忽略，加 ports 能识别 Garage，排除了镜像白名单阻断，但不能证明监听、卷、命令完整保留。本次只把两份独立 compose 的 `expose: ["3900"]` 改为 `ports: ["3900"]`，明确接受由 CDS 分配宿主机 TCP 端口作为重新审批事项。详细证据与待办见 [CDS 问题](cds-development-issues-2026-10-10.md)，下文为待验证草案，不称已部署存储。

## 配置范围

- `deploy/novart/cds-compose.yml` 与独立私有控制 compose 增加 `novart-storage`，固定 Garage **v2.4.1** 官方多架构摘要 `sha256:9c96caa2612d3411acc5b0e6701fb238dbfba33e533a6d7d3d811a4b12d0d020`。
- `deploy/novart/storage/garage.toml` 为无密钥配置；两个项目专属卷分别存元数据和图片，配置只读挂载，RPC 只监听容器 loopback。
- S3 声明 `ports: ["3900"]`。CDS 会分配宿主机 TCP 端口；当前不能保证仅容器内部或仅 loopback 可达。没有 CDS HTTP 页面入口、Garage 管理监听、网站服务或匿名公开桶，**但这不能等同于没有 TCP 暴露**。部署后须核对真实绑定地址和外部可达性。应用凭据只计划授权新桶 `novart-product-assets` 的读写，不可管理或创建其他桶，尚未实际创建或验收。
- 初始内存上限 512 MiB、块缓冲 64 MiB；属于待测预算，不是运行峰值保证。
- Web 与 Worker 设置 `AUTO_COMPLIANCE_V1=0`。用户这次授权一张 1K 普通生图，不额外调用 VLM、分层、改图或 EXACT。

版本、命令与权限按[官方发布记录](https://garagehq.deuxfleurs.fr/_releases.html)、[v2.4.1 CLI 源码](https://raw.githubusercontent.com/deuxfleurs-org/garage/v2.4.1/src/garage/cli/structs.rs)核对。官方镜像没有 shell，不在启动命令中假设有 shell/curl。配置采用单节点；[官方快速开始](https://garagehq.deuxfleurs.fr/documentation/quick-start/)明确该模式没有冗余，因此本批仅称独立验收 / staging，备份恢复实际演练前不能称完整生产存储。

## 已执行检查

TOML 解析与配置范围、补丁匹配检查通过。旧 expose 版本两份官方 CLI 本地 verify 为 0 error / 2 warning / 6 info；两条 warning 是原 AI/Worker 命令没有 migration 关键词，没有因此添加并发迁移。本地 parse 保留两个卷、健康检查和内存限额，将存储分类为基础设施。旧版服务端 `/api/compose/lint` 返回 200、findings 为空，却漏过服务转换问题；不能把 lint 通过当作部署成功。

官方只读差异预览已核实：原 expose-only 版本新增 0 项；仅改回环端口声明的假设新增 Garage 1 项，更新和删除均为 0；真实 MinIO 镜像的独立假设也能识别，未拿其冒充 Garage。三个预览前后，实际项目 compose、环境、基础设施和 profile 内容没有变化。新增项预览只返回 id/name/image/containerPort，不返回绑定地址、卷、健康检查或内存限制，因此这些仍须部署后验证。

项目真实 infra 实体包含 `projectId`、`scope`、`containerPort`、`hostPort` 和 `volumes`；现有 PG/Redis 为本项目 scope，并保留原命名卷。字段权威接口明确 ports 由平台分配宿主机端口；expose 和 mem_limit 被标为未登记字段。对当前 PG/Redis 宿主机端口的外部 TCP 连接未成功，只能说明该次连接未确认，不能据此证明私有绑定或替 Garage 作保证。

私有控制配置移除本次新增项后，与原配置结构和值严格一致，原数据库、队列、会话加密材料和三个 prebuilt profiles 保留。根公司 `cds-compose.yml` 未纳入本批变更。

## 审批后接入顺序

1. 只向独立项目提交这次端口修正的 pending-import，重新遵守 CDS 人工审批，并明确告知宿主机 TCP 端口映射。审批后回读新 `novart-storage` 对象，必须满足 `projectId=98cfea6cdcbd`、`scope=project`，不能落成 global；核对没有 HTTP 管理入口，原 PG/Redis 卷与加密材料保留，应用仍为 prebuilt。
2. 在受保护的独立变量配置中生成新的 RPC secret，不进入 Git/聊天/报告。部署精确通过 CI 的 SHA 后核对实际镜像与挂载。
3. 用已经证实支持项目 infra 的官方容器执行方式初始化独立 bucket 与应用 key，回执只由私有控制程序捕获，不展示 secret。Garage 是 infra，不是分支 build profile；不能直接把 infra ID 当成 branch container-exec 的 profileId。当前官方文档/页面只确认了 infra 启停、日志、健康接口，初始化传输仍需核实。先核对是否已存在，不自动重复建 key 或删除旧桶。
4. 通过原管理员设置 API 在独立 `AppSetting` 保存完整 storage 字段。当前 `getEffectiveStorage().configured` 不仅看环境变量，单加 `S3_*` 不能启用上传。
5. 用项目现有 AWS SDK 实测 PUT → GET 的字节 SHA → DELETE；验应用 key 拒绝其他桶和管理操作。
6. 真 Worker 上传 → 画布保存 → 新会话恢复 → PNG/SVG，然后一张 1K 真模型 → 归档 → 入画布 → 重开和导出。配置存在或容器健康不代替这条验收。

应用 endpoint 使用 `http://novart-storage:3900`，region `garage`，forcePathStyle=true；URL 前缀为内部 bucket 路径，浏览器继续走同源鉴权 Asset raw 接口，不把内部 URL 当公网链接。生产可用性还需要资源观测、存储重启持久化、独立备份和恢复演练；本批未提前标为通过。
