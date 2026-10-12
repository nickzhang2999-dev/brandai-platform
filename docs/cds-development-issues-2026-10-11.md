# CDS 发布问题记录 · 2026-10-11

## 预构建镜像认领不兼容现有 profile 配置

独立项目 `98cfea6cdcbd` 的三个应用 profile 均为 `prebuiltImage: true`，镜像为 Web/Worker 的 `novart-product-web:sha-${CDS_COMMIT_SHA}` 和 AI 的 `novart-product-ai:sha-${CDS_COMMIT_SHA}`。没有 deployModes，activeDeployMode 为空；分支 override 只有 Web 的 `/studio` 入口，没有镜像固定覆盖。

精确提交 `68cb239732641b324c27058b69c22c12b9ab8ada` 的 [CI38147140367](https://github.com/nickzhang2999-dev/brandai-platform/actions/runs/38147140367) 完整通过，源码和镜像内两轮 API95/UI15、Garage 校验、三镜像发布及清理全部成功。调用正式 `POST /api/branches/:id/prebuilt-image/claim`，请求包含完整提交、该流水线 URL 和 `dryRun: true`，实际返回 **409 `branch_not_prebuilt`**。两次均只是 dry-run，没有 claim 或部署副作用。

源码原因已经核对：[prebuilt-image-claim.ts](https://github.com/inernoro/prd_agent/blob/main/cds/src/services/prebuilt-image-claim.ts) 使用 `branchUsesPrebuiltMode`；[deploy-runtime.ts](https://github.com/inernoro/prd_agent/blob/main/cds/src/services/deploy-runtime.ts) 的该判断只识别有效 `deployModes[mode].prebuilt`，遗漏旧形式 `profile.prebuiltImage`。正式部署路径却兼容两种形式，并在解析服务镜像之前把显式 `body.commitSha` 写入该分支的镜像版本来源。认领接口和部署接口的分类不一致，是 CDS 接口兼容问题，不是 Novart 编译、上传或生成服务失败。

本次采用已有正式部署路径：在相同完整 CI/镜像验收及独立配置检查通过后，用正式 branch deploy 显式指定已验证提交，保留平台 pending-import 守门和 DeploymentRun 精确版本验收，不改变服务定义、分支 override 或共享项目。发布结果另见当日开发日志，尚未完成时不称已上线。

23:27结果：正式部署run `dr_6813ca04040e2de4d4a644a4` 已完成，同SHA68cb的Web/AI/Worker实际容器环境和镜像均核对，独立Garage固定55e/两卷healthy，公司三分支及最近部署未变。公网工具保存、同项目只读全新登录恢复及PNG/SVG一致性已过。因此本次可以通过正式支持路径解决交付，不需要改公司CDS源码或新增服务模式配置；认领接口兼容缺口本身仍待CDS维护方修复。独立live核对会对账本项目状态，不能称严格无状态GET；没有对公司项目进行live对账。

建议 CDS 修复：统一镜像分类，认领、部署、Agent 门禁均识别有效 mode 或 baseline `prebuiltImage: true`；补齐旧配置/新模式两类测试。不要为调用认领接口就迫使现有项目迁移模式定义。

## 本机代理连接问题，与 CDS 产品故障分开记录

本次本机系统代理仍启用，但其本地端口没有监听，默认代理请求失败。并行只读网络检查确认直连 CDS 登录页200，直连 Git远端查询及推送也成功。只为当前 Python 进程使用直接连接，当前 Git 命令清空代理，没有修改系统代理、全局 Git 配置、证书或浏览器凭据。该故障归属于本机连接路径，不归属 CDS 服务端。

## 隔离与已验证边界

实际签名推送回执 `ed4ce16b-f40e-45df-9986-49592ccceb80` 确认 `[skip cds]` 被执行；公司三分支注册及最近部署记录未变化，引用此次提交的公司部署为0。独立 Garage 固定55e及两块命名卷保留。没有新增付费生成调用。云端 API/UI 验收不会冒充真实模型验收；此前单张真实1K生成证据保持原样。
