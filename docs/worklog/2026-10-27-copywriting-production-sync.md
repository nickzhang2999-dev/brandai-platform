# 2026-10-27 · 正式环境文案配置同步

正式站曾提示“文案模型尚未配置”，无法提交生成。已将 `devUpdate1012` Web、Worker 已验证的独立文案配置同步到正式环境；用户明确授权执行并批准 CDS 主机操作。本记录为事后追溯，不代表执行前已通过 PR 审核。

## 实际变更

- 正式目标：`brandai-novartlab-local-prod`，入口 `https://deepflare.cn`。
- 仅更新 `/opt/brandai-platform-prod/.env` 中的 `COPYWRITING_BASE_URL`、`COPYWRITING_API_KEY`、`COPYWRITING_MODEL`，由 Web、Worker 共用。
- 模型：`qwen3.7-plus`。接口地址和密钥不进入本 PR。
- 生产版本保持 `632ac2fa8abdb6bc535ff4df12f3232719b2af83`，原发布记录为 `rel_ccbb7b6ac27fb9b7`。
- 固定现有镜像，仅重新创建 Worker、Web；其他生产容器身份保持不变。没有业务代码、数据库结构或发布策略变更。
- CDS 批准执行请求：`req-mvqdjmxn-fabdec`。使用当前生产 AI 镜像的一次性维护容器，完成后自动删除；候选配置先与原 Compose 解析结果比较，确认仅三键变化后应用。
- 原配置备份：`/opt/brandai-platform-prod/config-backups/copywriting-20261027T074008Z-eeeab990/.env.before`；备份及结果留在生产主机，私密配置不外传。
- 执行时间：北京时间 15:40:08–15:40:37。此前四次主机执行尝试都在生产写入前失败，详见脱敏证据；执行方式和路径判断失误导致了不必要的延误。

## 已完成验收

1. Web、Worker 运行配置与预览环境三项值一致，且镜像身份没有变化。
2. 正式内网及公网健康检查通过：Web / AI / Worker 均正常，队列为 `brandai-prod`，Worker 版本仍为 `632ac2fa8abd`。
3. 用正式站现有登录会话新建独立空白验收项目，没有覆盖首页原有草稿。
4. 真实点击一次“生成文案”，成功返回三组标题和正文；“文案模型尚未配置”提示消失。
5. 刷新页面后重新打开 AI 文案面板，三组记录均由服务端恢复；刷新没有再次调用模型。

[正式验收项目](https://deepflare.cn/studio?workspaceId=cmra9orxw000vqtwz1xayngki#/workspace/cmvqdmyly0001pk111nmzpwoz)（需已有项目权限）。结构化证据见同目录 `2026-10-27-copywriting-production-sync.json`。

## 同时核对的 CI 提示

同一提交 `632ac2f` 的 [CI](https://github.com/nickzhang2999-dev/brandai-platform/actions/runs/40447600956) 与 [Branch Image](https://github.com/nickzhang2999-dev/brandai-platform/actions/runs/40447600977) 均成功；CDS Deploy 检查 `122007290016` 却报 `CI image wait timed out`。可以确认 CDS 没有匹配到已完成的镜像构建，不能将该提示解释为业务代码编译失败。本次配置同步没有修复该部署状态问题。

归因：E · 正式服务没有获得有效的独立文案配置；预览分支的服务覆盖变量不会随代码合并自动进入正式服务器 `.env`。
