# 分层 180 秒超时：诊断与修复

日期：2026-10-19。目标分支：`devUpdate1012`；本地工作区：`brandai-layer-ux`。本次不改 main、正式环境、数据库结构和模型配置。

## 确认的原因

用户截图中的两次 7 层任务：内容分析成功约 6 秒，分解调用分别约 180.414 秒、180.619 秒后失败；原图为 1024×1024。实际 AI 容器 `AI_HTTP_TIMEOUT_SECONDS=180`，访问日志两次 `/v1/decompose` 返回 504；安全错误日志是 `AI_REQUEST_FAILED / unknown / upstream=None`。尚无可归档模型结果。

因此本次是同步等待分解请求超时，未进入图层尺寸校验或保存阶段。旧 Fal 适配器没有标记异常发生阶段，导致已知超时显示成“具体原因尚未确认”。不能从客户端超时推断上游已停止或未计费。

另一个独立问题：GitHub `84fa5e4` 的 Branch Image run `39220851878` 成功，CDS 却标记 `timed_out_no_run`；实际三服务仍运行 `2492b43`。尚不能细分为 webhook 丢失或配置匹配问题。源码更新不等于实际部署更新。

## 最终实现

1. Studio Worker 改用 Fal 官方持久队列：单次 POST 提交后保存任务编号，再用 GET 查询状态和读取结果。
2. 返回的编号立即存入既有私有 `outputJson`，兼容旧模型结果格式；没有数据库迁移。浏览器只看到产品任务，不暴露上游编号和结果地址。
3. 原子提交认领保持不变；响应丢失且未取得编号时禁止自动重发。查询失败只恢复原任务的只读请求，不产生新推理请求。
4. Worker 每次只做一次有界查询，现有 15 秒扫描继续调度。35 秒查询预算覆盖最多两次各 15 秒上游 GET；40 秒 CAS 租约防止并发查询，旧响应不得覆盖新恢复过程。
5. 产品仍有 6 分钟处理期限，超时后保留编号至首次提交起 24 小时。用户可点“检查并保存已有结果”；该操作只查原任务、取结果并保存，不重新提交模型。
6. 原图、成员权限、资产归属、透明图层检查、整组发布、PSD 和原图保留规则不变。
7. 真实错误分类覆盖超时、限流、鉴权、网络和无效响应；增加脱敏任务关联 ID。服务发现要求 `studio-layer-queue-r1`，防止新 Worker 调到旧 AI 容器。
8. 只使用当前实际配置的官方 Fal owner/model 路径，拒绝将自定义网关凭据转发给 Fal；不跟随上游返回的 URL 或重定向。提交带 `X-Fal-No-Retry: 1`，明确禁止供应商自动重试。

## 验证与边界

- 全量 contracts/UI/Web、AI、类型检查、生产构建与 Chrome 结果在工作日志及本地 `.novart-build/layer-queue-*` 回执中记录。
- 新回归覆盖单次提交、重启恢复、丢失回执、查询超时、重复投递、迟到结果、固定恢复期限、权限变更和不完整结果。
- 实际 Chrome 使用隔离测试接口验证刷新后恢复、原图保留、图层放置、撤销重做、保存重开。它证明交互行为，不冒充付费模型质量验收。
- 旧失败任务未保存上游编号，无法凭空恢复；保持原图和旧记录。新机制只保证已取得并保存编号的任务可续查。
- 模型不可用、余额不足、真正的模型失败仍可能发生；新流程解决同步等待超时和状态丢失，不保证所有模型请求成功。
- 支持的队列地址限官方 Fal 的 owner/model 路径；其他兼容网关需要明确的队列协议适配。

## 发布核对

本轮以实际完成的门禁和精确提交版本为准。新提交构建成功后，如果 CDS 仍未关联，使用平台原生 `branch claim-prebuilt --commit <SHA> --workflow-url <对应成功run>`，先 dry-run，成功后部署；不伪造流水线成功状态、不绕过审批。

部署后必须读取 Web/Worker/AI 的实际提交及队列能力字段，健康检查和用户路由分别确认。发布与真实付费验收结果另追加回执，未完成前不标记为线上已修好。

## 依据

- [Fal 官方异步队列：任务持久化、查询、禁止重试](https://fal.ai/docs/documentation/model-apis/inference/queue)
- [Qwen Image Layered 官方接口及输出格式](https://fal.ai/models/fal-ai/qwen-image-layered/api)

归因：I（同步调用和异常分类实现缺口）；E（已成功构建未被 CDS 接续，运行时版本已实测）；O（原先通用错误不足以定位）。

## 本次发布记录

- 修复提交：`c71ff6a6ac52f8364a96b4a20725af7002f1ab8b`，已推送 `devUpdate1012`，未修改 main。
- GitHub Branch Image：run `39227412995`。首轮于 2026-10-19 17:17（北京时间）完成产品门禁、真实临时数据库/存储联调、实际浏览器检查、镜像构建和成品容器检查。
- 首轮失败位于 `Publish checked Garage storage image`：Docker 连接 `https://ghcr.io/v2/` 约 15 秒后返回 `context deadline exceeded`。产品镜像发布步骤随后跳过。因此不能认领或部署这次尚未发布的镜像。
- 此故障发生在 GitHub Runner → GHCR 的网络连接阶段，不是分层模型故障，也没有证据证明是 CDS 服务端故障。使用 GitHub 原生 `rerun-failed-jobs` 重跑同一提交；没有跳过门禁、伪造成功回执或改变镜像标签。
- 真实模型验收预算：最多 1 次手动 7 层请求，0 次新生图、0 次额外视觉分析；通过隔离验收项目使用原图副本。部署实际版本核验通过之前不提交付费任务。
- 第二次运行于 17:31 成功，完整门禁记录为 Web 1779、AI 647、contracts 309、UI 39 全部通过，镜像发布完成。CDS 仍未关联本次成功回执，原生 `claim-prebuilt --dry-run` 校验成功后认领并部署。
- 部署 `dr_b9f90e73d4972f40a206fea7` 于 17:33:51 完成。随后读到三服务镜像标签、三个容器 `CDS_COMMIT_SHA` 均为 `c71ff6a…`；AI 的 `studioDecompositionQueueRevision=studio-layer-queue-r1`；公网健康检查 Web/AI/Worker 均正常，Worker 提交匹配。证据：`.novart-build/layer-queue-runtime-1019.json`。
- 已通过合法登录创建独立验收项目并上传原图副本，图片 SHA256 与失败原图一致。首次验收脚本仍使用旧按钮名称，停在付费提交前；脚本已对齐“选图AI分层”弹窗、任务深链、可见原图与图层组并列布局。没有为此修改已发布产品代码。
- 后续公网 `/api/auth/csrf` 返回非 JSON；只读探测 `/api/health`、`/api/auth/csrf`、`/login` 返回 Cloudflare 403 / `error code: 1010`，真实 Chrome 导航 `/login` 返回 522 / `Connection timed out`，页面无登录表单。同时 CDS 分支列表查询未得到 200。此前通过的部署核验不等于此刻公网仍正常，也不能从这些响应推断容器内部崩溃或具体网关配置。
- 截至 17:44，本轮真实模型调用仍为 **0**：checkpoint 仅有验收项目与 `uploaded:true`，没有 `submissionStarted` 或 `requestId`。真实分层、实际 PSD 导出和真实图层保存重开尚未验收，不能以本地夹具/CI 成功替代。保留已有项目和图片；入口恢复后继续同一项目的有界验收。
- 17:44:48 追加一次官方 CDS CLI 只读分支列表请求，15 秒后 `status=0 / errorCategory=timeout`，首读失败即停止，未请求容器内部日志。证据 `.novart-build/preview-outage-readonly-1019.json`。目前无法细分 CDS 主机、前置网关或本机出口；没有重启共享服务、修改安全配置或尝试绕过入口。
