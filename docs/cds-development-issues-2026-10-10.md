# CDS 问题记录｜2026-10-10

完整原因、源码位置、证据边界与修复建议见 [CDS具体原因报告](cds-root-cause-report-2026-10-10.md)。16:34补充：当前线上03836f8cb的infra bind按CDS自身repoRoot解析（container.ts:2925），而非项目分支目录；基础设施依赖会在应用部署前启动（branches.ts:13217）。已获批相对TOML挂载因此不能保证读到项目配置，当前未启动故障配置。改为配置内置的预构建存储镜像，真实CI结果待确认。

本日新存储两项独立密钥已实际设置，仅新RPC/admin字段变化；原环境字段比较一致。c38d476真实源95/API与15/UI过，但构建后UI一次已受理上传进入FAILED，原因记录不足；这一条尚不能归因于CDS，新增清理前脱敏诊断和准确请求回执绑定。公司原项目与共享数据本轮未变，实际AI调用0。

## 已确认：expose-only 存储声明获准后未转换为服务

范围仅独立产品 `98cfea6cdcbd`。人工批准导入 `473923091fca` 后，保存的 Compose 有 `novart-storage` Garage 服务、两份独立卷和只读配置；实际基础设施仍只有原 PostgreSQL/Redis，没有新增存储，Web/Worker 的 dependsOn 却已含该缺失服务。导入结果 addedInfra=[]，三个应用 profile 保持 prebuilt。

导入前官方 `/api/compose/lint` 返回 200 与空 findings，未提示服务会被省略或引用缺失。**批准成功与 YAML 保存成功不能代替服务实体及运行字段验收。** 本次未启动新的部署、创建存储对象或执行付费生成。

官方 `infra/resync/preview` 的三次对照（不 execute）：

| 只读输入 | 预览结果 |
| --- | --- |
| 原 Garage 固定镜像，expose 3900 | adds0 |
| 相同 Garage，仅把 expose 改为 loopback ports 声明 | adds1，识别原 Garage 镜像与 containerPort3900 |
| 独立真实 MinIO + loopback ports 对照 | adds1，识别 MinIO |

各次 updates/removes 均为0，前后实际项目/基础设施/profile 配置哈希一致。可确认该导入路径忽略 expose-only；不能归因于 Garage 镜像白名单。官方固定 infra catalog 没列 Garage，但预览确实能识别其自定义镜像，故 catalog 缺项不是自定义镜像绝对不支持的证据。

预览仅提供 id/name/image/containerPort，不展示 host binding、卷、命令、健康检查及内存预算。尚不能证明这些字段在实际 infra 部署中保留，不执行 ports 假设或临时服务绕过。后续先查真实运行规范，准备完整可审配置；若平台不支持，明确配置缺口。保持原 PG/Redis 卷和加密材料，不复用公司素材桶。

## 本批应用问题，不能归为 CDS 故障

后续修正b778553的真实CI38036388613已success：95后端、15UI及构建后容器验收通过。下列应用问题已由真实栈复核解决，不能继续列为当前CDS故障。存储新申请3d3d941a2c50合并ports与官方内部管理REST；实际infra创建/运行时scope/卷/网络仍需单独回读，不由CI临时S3替代。

- API 匿名裸 `/workflow` 被应用中间件返回登录307：修正路径边界，使工作流接口返回JSON401，页面仍保留登录跳转。
- UI 权限拒绝验收使用宽泛 alert 选择器，与 Next 隐藏 announcer 冲突：增加实际错误提示 testid，保留拒绝和404断言。
- CDS 右侧前端评审仍运行旧捕获编辑器，约5秒后卸载由其许可检查触发。新自研编辑器尚未发布到该入口，不能说是新编辑器部署后被 CDS 关掉。

历史部署隔离、代理 Origin 和共享库事项保留在 [10月8日问题记录](cds-development-issues-2026-10-08.md)与[10月9日共享审计](cds-shared-audit-2026-10-09.md)。本批 `[skip cds]` 实际签名投递跳过，公司分支版本及CI基线不变。
