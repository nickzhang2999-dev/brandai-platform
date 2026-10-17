# 2026-10-17 集成版本发布记录

## 授权与范围

用户授权按已提出方案备份、精确清理独立预览库唯一孤立成员关系，然后推送 devUpdate1012 并验收。没有授权修改 main、CDS 配置、加密密钥或共享库；本次均未修改。

## 数据修复与复核

- 目标 SQL 实查库名：brandai_devupdate1012。
- 孤立 Membership 原始记录已保存到 Git 忽略的本地受限目录，文件读回校验一致；备份 SHA-256 见推送预检报告。原始业务标识不进入报告。
- 写事务重新核对记录指纹、唯一孤儿数、26表关联情况，以短期锁防止检查与清理之间新增关联；精确删除1条，用户和品牌数量不变。
- 事务内审计及提交后的独立只读审计：26表孤儿数量全部0，6项跨品牌不一致全部0。
- 没有调用 migrate resolve、手动执行候选迁移或放宽约束。

## 代码与推送

- 产品代码基线：21eb6a5979e44ef47572e6c9102978c7be107f1c。
- 新增交接证据文档提交：48d5a3d81b4fcfa3532db8552ab9911838b51b0d。
- 常规推送：integration/devupdate-opt -> origin/devUpdate1012；83a5dca 快进至48d5a3d，远端 readback 完整SHA一致。
- 推送守卫正常安装并执行，未使用强推或绕过检查。
- 本地测试 Web1596/contracts293/UI34/AI547、types、低内存生产build通过；lint0错误14警告。
- [Branch Image 39011726235](https://github.com/nickzhang2999-dev/brandai-platform/actions/runs/39011726235) 已由 push 触发；最终容器能力断言失败，未发布镜像。

## CI 集成遗漏修复

首轮CI的源码与构建后容器真实API/UI均exit0，32项UI检查通过，PSD文件读写与2K内存边界证明通过；失败位于工作流嵌入Python第10行的providerRetryRevision断言。P3已将Web/AI契约提升到single-provider-attempt-r2，工作流仍要求r1。修复只更新CI断言到r2并补充失败说明，未移除门禁、放宽兼容条件或改业务代码。新提交重跑完整工作流，结果另补。

修复提交c5da4a75718c8ca3e4328c2036c271c6d5d76c68已正常推送，远端回读一致。定向Python42、Web30项通过。第二次推送前实际独立库26表/6项审计仍全部0。[第二轮Branch Image 39012731982](https://github.com/nickzhang2999-dev/brandai-platform/actions/runs/39012731982) 已启动。

## 部署与真实页面验收

第二轮 Branch Image 39012731982 全部成功，31个步骤成功、无失败步骤。成功构建后，CDS 的 ciTargetSha 仍停在83a5dca；通过平台官方 prebuilt-image/claim 先 dry-run 验证，再认领并部署精确提交 c5da4a75718c8ca3e4328c2036c271c6d5d76c68。

- 部署运行：dr_fb54ab5d604975d6e9cadf06，phase=complete、status=running、failure=null。
- 当前版本：dv_43f341362168e2d54fefedc7；分支运行提交c5da4a7，Web/Worker/AI均running。
- 官方预览入口：https://devupdate1012-brandai-platform.geole.me/ 。
- Web和Worker容器分别执行只读SQL，实际数据库均为brandai_devupdate1012。
- 20261016080000_async_task_compliance_payload、20261016080500_generation_attempt_token、20261016090000_workspace_fk_indexes均已完成，未回滚，无未解决的失败迁移。
- Membership_workspaceId_fkey已存在。没有手动跳过迁移，也未修改共享业务库。

真实预览浏览器验收已通过（本机headless Chromium，连接真实CDS预览后端，非模拟API）：

1. /api/health 的Web/AI/Worker均ok，Worker提交c5da4a75718c与发布提交一致。
2. 使用已有验收账号登录成功，认证后的/studio页面正常。
3. 新建唯一验收项目“发布验收 2026-10-17 c5da4a7”，不修改既有项目内容。
4. 自研画布与文字工具加载后继续等待12秒，仍可见、可操作。
5. 添加两行文字并保存，刷新页面后内容恢复。
6. 实际下载SVG与PNG，验证文件非空及对应格式标记。

结果文件：.novart-build/release-browser-20261017.json（Git忽略，本地留证）。本轮模型调用为0；以上不代表已进行真实AI生成或分层效果验收。最终部署回执和日志更新保留本地，避免仅为回填发布结果再触发下一轮部署；远端及运行版本均保持c5da4a7。

## 平台与工具观察

- GitHub连接器的fetch_commit_workflow_runs仅返回pull_request触发记录，不能用于判定push没有触发CI。已改用本仓库Git凭据帮助器，在内存中认证GitHub只读Actions API，确认实际push工作流；未打印或保存访问凭据。
- 新CI成功后，CDS仍关联旧CI与旧ciTargetSha；官方成功镜像认领后部署正常。本次确认的是镜像状态同步未及时更新，未调查平台内部根因，不将其误写为产品构建失败。
- 一次只读CDS分支请求发生网络错误，重试后成功，未重试任何不确定的数据删除操作。

## 明确未纳入本次

交接第6节的编辑任务事务合并、管理员注册入口、上传内存、计费竞争、旧页面删除及P1残留清理没有混入本次发布。真实AI分层/生成质量验收未执行。
