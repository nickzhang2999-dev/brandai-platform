# Novart 独立图片存储｜验收环境

本批为独立产品项目 `98cfea6cdcbd` 准备存储，不复用公司素材桶或存储凭据，不修改公司 main。当前仅完成配置和检查，未创建远端服务或实际对象。

## 配置范围

- `deploy/novart/cds-compose.yml` 与独立私有控制 compose 增加 `novart-storage`，固定 Garage **v2.4.1** 官方多架构摘要 `sha256:9c96caa2612d3411acc5b0e6701fb238dbfba33e533a6d7d3d811a4b12d0d020`。
- `deploy/novart/storage/garage.toml` 为无密钥配置；两个项目专属卷分别存元数据和图片，配置只读挂载，RPC 只监听容器 loopback。
- S3 端口仅容器网络可达，无主机端口、管理入口、网站服务或公网桶。应用凭据仅授权新桶 `novart-product-assets` 的读写，不可管理或创建其他桶。
- 初始内存上限 512 MiB、块缓冲 64 MiB；属于待测预算，不是运行峰值保证。
- Web 与 Worker 设置 `AUTO_COMPLIANCE_V1=0`。用户这次授权一张 1K 普通生图，不额外调用 VLM、分层、改图或 EXACT。

版本、命令与权限按[官方发布记录](https://garagehq.deuxfleurs.fr/_releases.html)、[v2.4.1 CLI 源码](https://raw.githubusercontent.com/deuxfleurs-org/garage/v2.4.1/src/garage/cli/structs.rs)核对。官方镜像没有 shell，不在启动命令中假设有 shell/curl。配置采用单节点；[官方快速开始](https://garagehq.deuxfleurs.fr/documentation/quick-start/)明确该模式没有冗余，因此本批仅称独立验收 / staging，备份恢复实际演练前不能称完整生产存储。

## 已执行检查

TOML 解析与监听范围、补丁匹配检查通过。两份官方 CLI 本地 verify 为 0 error / 2 warning / 6 info；两条 warning 是原 AI/Worker 命令没有 migration 关键词，没有因此添加并发迁移。本地 parse 保留 expose、两个卷、健康检查和内存限额，将存储分类为基础设施。**服务端 `/api/compose/lint` 已实际返回 200，findings 为空。** 这只证明拓扑检查，不证明导入转换和真实容器行为。

私有控制配置移除本次新增项后，与原配置结构和值严格一致，原数据库、队列、会话加密材料和三个 prebuilt profiles 保留。根公司 `cds-compose.yml` 未纳入本批变更。

## 审批后接入顺序

1. 只向独立项目提交本批 pending-import，遵守 CDS 的人工审批。审批后回读服务与 profile，核对无公网存储入口、原 PG/Redis 卷与加密材料保留、应用仍为 prebuilt。
2. 在受保护的独立变量配置中生成新的 RPC secret，不进入 Git/聊天/报告。部署精确通过 CI 的 SHA 后核对实际镜像与挂载。
3. 容器内初始化独立 bucket 与应用 key，回执只由私有控制程序捕获，不展示 secret。先核对是否已存在，不自动重复建 key 或删除旧桶。
4. 通过原管理员设置 API 在独立 `AppSetting` 保存完整 storage 字段。当前 `getEffectiveStorage().configured` 不仅看环境变量，单加 `S3_*` 不能启用上传。
5. 用项目现有 AWS SDK 实测 PUT → GET 的字节 SHA → DELETE；验应用 key 拒绝其他桶和管理操作。
6. 真 Worker 上传 → 画布保存 → 新会话恢复 → PNG/SVG，然后一张 1K 真模型 → 归档 → 入画布 → 重开和导出。配置存在或容器健康不代替这条验收。

应用 endpoint 使用 `http://novart-storage:3900`，region `garage`，forcePathStyle=true；URL 前缀为内部 bucket 路径，浏览器继续走同源鉴权 Asset raw 接口，不把内部 URL 当公网链接。生产可用性还需要资源观测、存储重启持久化、独立备份和恢复演练；本批未提前标为通过。
