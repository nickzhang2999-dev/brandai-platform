# 2026-10-27 · 发布脚本提交核验与正式发布

## 授权与范围

用户要求将 PR #65 发布到正式站，灵感独立开发；随后要求补交普通发布脚本、通过 CI 后发布，并补本次 PR。

## 已落地代码

- 原版本 `c72157be22b89f1d5c35c0ef902cb5f550aad5a8` 已包含根目录 `cds-release.sh`，Git mode 为 100755。CDS 的缺失提示与 Git 对象不一致，平台实际查找根因尚未确认。
- 修复提交：[`632ac2fa8abdb6bc535ff4df12f3232719b2af83`](https://github.com/nickzhang2999-dev/brandai-platform/commit/632ac2fa8abdb6bc535ff4df12f3232719b2af83)。该提交已直接进入 main，之后用户要求补 PR。本 PR 是追溯记录，不能作为代码进入 main 前已完成 PR 审核的证明。
- 两条 CI 在安装依赖前校验脚本 Git 对象、普通文件、可执行权限及 Bash 语法，输出 Git mode 和 SHA-256。
- `cds-release.sh check` 校验脚本属于当前提交、拒绝正文漂移，输出完整提交与正文 SHA-256。新增真实临时 Git 仓库回归验证修改后的脚本被拒绝。
- 保持 main 限制、正式目标身份、同提交镜像、生产 Compose、迁移/就绪及三域名资源校验。没有带入灵感功能或修改生产配置。

## 本地验证

同一代码状态：L1 2160 项（Web 1812 / contracts 309 / UI 39）、AI 649 项、Web typecheck、生产 build 均通过。生产资源 7 项及发布合同 7 项通过；Git diff 检查及推送守卫通过。

首次本机 pnpm fallback 为 11，与项目锁定的 9.15.0 不一致；改用现有 corepack 的锁定版本重新安装并完成门禁。工具产生的 workspace 配置变动已精确撤回，不在提交中。生产 build 的本地 Redis 连接警告不影响退出码 0，不能作为真实后端运行验收。

## 云端与正式发布

- [常规 CI](https://github.com/nickzhang2999-dev/brandai-platform/actions/runs/40447600956)。
- [同提交镜像流水线](https://github.com/nickzhang2999-dev/brandai-platform/actions/runs/40447600977)。
- 创建本追溯 PR 时，AI CI 成功，Web 与镜像仍运行中。最终结果及正式发布回执以本任务后续实测为准。
- 正式站发布前最近核验：worker commit `d896d7c8fc69`，Web/AI/Worker 正常，队列 `brandai-prod`。尚未创建本轮 release run。
- 后续必须核对最终 main 的同 SHA CI/镜像、CDS preflight 与回滚版本，再执行正式发布并核对实际运行 SHA 和公开资源。不能用 PR CI、main 预览或本地测试替代正式站验收。
