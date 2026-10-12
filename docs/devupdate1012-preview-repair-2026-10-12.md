# devUpdate1012 工作台预览修复

2026年10月12日。用户在新分区看到 `{"error":"工作台暂时无法读取，请稍后重试。"}`。目标为公司CDS项目a8a098f7193a的 `brandai-platform-devupdate1012`，修复前Git和运行提交均为完整2d291252db8b19cf3f8f6e226e633b27b4ceb798。

## 原因与真实现场

分区覆盖选择Web的dev源码热加载、Worker/AI的release源码模式。旧Web命令只安装依赖、生成Prisma并启动Next，不运行新版Studio资源导出；容器中 `/app/.novart-build/studio/manifest.json` 实际不存在。公开bootstrap请求也返回503及相同错误。新版资源来自完整CI镜像，因此main正常并不代表使用另一启动方式的新分区正常。

源码 `studio-assets.ts` 在读取缺失清单时抛错，`studio-route.ts` 的未知错误出口返回这条通用503。不是已证明的数据库丢失或用户密码问题。

第二项实际适配问题是可信公开origin。首次切换完整镜像后，124份资源校验通过，但Next进程的AUTH_URL仍为main；部署mode内的硬编码命令优先于分支command覆盖，会覆盖分区env的AUTH_URL。不能把Docker exec或配置字段读取当成Next进程的实际环境。已新增只供该分区选用的Web模式 `novart-devupdate1012`，显式设置正确公开域名；保留main原模式与项目默认选择。

## 已应用配置和代码

Web选择新的prebuilt模式，Worker和AI选择既有Novart已验证镜像模式；三服务镜像以完整成功SHA解析。Web/Worker显式使用 `brandai-devupdate1012` 队列前缀，Web使用本分区公开origin。分支级入口为 `/studio`。变更mode时平台会丢掉同对象中的入口配置，已通过正式web-entry-config恢复并回读。

第一次部署run为 `dr_54fceda762d18a724d075b05`，此阶段只证明资源和三服务健康，实际Next origin检查false保持，不标成完整成功。origin修正后的部署、真实浏览器与最终新SHA结果另行追加。main没有执行本次部署；旧模式含seed/db push，新模式没有重跑这条初始化命令。

仓库原Branch Image的push分支过滤、产品调用条件和被调用backend条件都排除devUpdate1012。三处现在一起加入该分支，保留原main及两条Novart分支行为，避免后续只改一层却仍skipped。

## 提交前验证

L1 contracts976/UI24共1000通过（同源Turbo缓存）；AI365通过/1上游warning；Web完整typecheck及生产build退出0。工作区没有应用、迁移、依赖或画布功能改动。新分支CI与镜像结果需按推送后的精确SHA另记；原2d已验证镜像临时恢复不代替新提交CI。

CDS回读确认初始三服务配置改动仅在本分区，原三个其他分支运行记录和覆盖不变；新增Web模式保留原mode内容、默认选择，Worker/AI项目profile保持。未读取或复制模型密钥，没有模型调用或业务数据库修复。

## 自动部署的边界

加入构建分支范围解决“新分区没有生成镜像”的仓库问题，不替代CDS App的workflow_run通知配置。当前App通知缺口和手动部署事实仍按既有记录区分；本次不伪造完成事件或把人工部署写成自动更新成功。
