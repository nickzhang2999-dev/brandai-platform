# devUpdate1012 改图故障与数据库隔离

## 已证实原因

2026-10-15 14:11（上海）的新改图请求 `sgr_68d8ac75a7964ffd83dc4b90814e9af1` 实际进入 Redis 的 `brandai-main:generate`，在图片服务调用前被旧 worker 拒绝。源图片 SHA、尺寸、版本、配方及完整来源快照均匹配，不能归责图片丢失。

`dispatchStudioGenerations()` 及对话恢复代码扫描数据库待处理记录，没有部署分区条件。BullMQ 前缀虽已分开，但 Web/worker 继承同一项目级 DATABASE_URL，main 能扫描新分区记录并加入自己的队列。只改新分支查询，不能阻止旧 main 的扫描器。

## 实际修复

只改 CDS `brandai-platform-devupdate1012` 的 web/worker 分支覆盖，保留原模式、端口、队列前缀、入口及其它配置；未改项目默认值或 main 服务。以下字段须**合并到既有覆盖，不能直接整体替换**：

```json
{
  "dbScope": "per-branch",
  "dbInit": "clone",
  "env": {
    "POSTGRES_DB": "brandai",
    "DATABASE_URL": "${CDS_POSTGRES_URL}/brandai_devupdate1012?schema=public"
  }
}
```

连接凭据继续使用平台变量。POSTGRES_DB 保留原库名供平台推导来源，运行时变为 brandai_devupdate1012。官方 db-init 创建时间点副本，14:46:06 台账确认 39 张表计数全部一致、无缺表。克隆前后只读确认无活跃生图、归档、分层、自动 PSD、可重新受理的对话；12 条历史中间状态消息已有关联任务或已过期。不重置旧收费请求。

## CDS 声明态与运行态的差异

1. 原 DATABASE_URL 来自项目环境，服务未声明库名变量。db-isolation/db-probe 报“不涉及数据库”，Prisma 却实际连接共享 brandai。
2. 声明 POSTGRES_DB 并启用独立库后，平台创建了副本、改写库名变量，但没有把 `${CDS_POSTGRES_URL}/brandai?schema=public` 中的路径一并改写。第一次部署后真实 SQL 仍返回 brandai，不能把配置或部署成功当隔离成功。
3. 将该分支 URL 路径明确指向副本后再部署，14:50 Web 和 worker 的 `SELECT current_database()` 均返回 brandai_devupdate1012。账号登录、Studio、项目编辑器、原图读取通过。部署 dr_fb9d6bb0bc605204900f7400，镜像 ee0f446。

## 新验收揭示的尺寸缺陷

14:51 新请求 `sgr_c546621795334434b17e0de1319626f9` 仅进入 brandai-devupdate1012:generate，图片来源校验通过；AI 服务 `/v1/studio/edit` 返回422。请求目标1024×576低于当前适配器最小655360像素。本地真实端点代码复现：该尺寸422且模型POST为0；1280×720通过且仅一次POST（测试替身，不是真实模型证据）。providerStartedAt只是产品准备调用AI的标记，不能据此断言上游已调用或计费。

新增 worker 传输尺寸适配：普通对话生成/改图使用合法模型尺寸，受理记录和最终输出仍保留用户要求。已有归档先按目标尺寸contain缩放，再合成严格保留素材；不裁掉原内容、不重试、不修改蒙版工具或传统生成任务。补worker实际分派、模型端点、最终PNG像素及边界回归。该补丁发布与真实验收结果另记。

历史04:33内部502没有足够上游日志，不能说已经证明与上述两项同因。

## 边界与回滚

- 副本不追踪main后续更新，dev的新项目也不会自动同步main。
- 对象存储和模型账号仍复用现有配置。本次完成任务数据库隔离，不代表存储、额度等所有资源独立；未删除共享素材。
- 独立库已有新记录后，代码回滚仍应保留独立库连接；直接改回共享库会使新记录不可见。数据合并需要另做迁移核对。
- 未覆盖共享库原有记录、停止/部署main、绕过平台审批或修改CDS源码。

证据保存在ignored `.novart-build/`：task-queue-scope、database-clone-preflight、cds-db-effective-readonly、database-clone-target-check、database-runtime-identity、database-worker-identity、isolated-task-queue-scope、edit-size-preflight-diagnostic，均带20261015日期。不提交私密连接上下文及账号文件。


## 15:26 · 发布及单张真实改图验收通过

产品提交9fde897420de700faa3c729012f6770b0f1ff765已推送devUpdate1012。[Branch Image38696804512](https://github.com/nickzhang2999-dev/brandai-platform/actions/runs/38696804512) completed/success，源码真实UI/SQL/上传和构建后容器验收通过。CDS仍未自动关联工作流，官方dry-run校验成功镜像后认领并部署，dr_8574104b3deda2aabbe794d8 complete/failure=null；公网worker.commit=9fde897420de，Web/AI/worker健康，已有账号及编辑器可访问。

重启后Web/worker实际SQL均为brandai_devupdate1012。新请求sgr_e87d9d13bda246c2bf36f27121dd4e0e的Redis队列为brandai-devupdate1012:generate，已完成无失败。真实产品API结果：message/generation SUCCEEDED、resultState READY、mode modify、结果1张；重新认证读取存储图片SHA一致，实际1024×576、1476944字节。原图仍按原SHA读取，未重放旧失败请求。

本次小规模真实验收通过的是单张整图修改和结果持久读取；不把此前04:33旧502具体原因写成已查明。独立库是时间点副本，不与main自动同步；共享存储、模型账号边界仍见隔离报告。main没有合并或部署。

发布后回执证据：ignored .novart-build/size-fixed-preview-public-20261015.json、ai-edit-size-fixed-real-poll-20261015.json、successful-task-queue-scope-20261015.json，以及cds-size-fix-release-claim-deploy-20261015.json。该段为发布后的本地日志补记，未产生新产品代码。
