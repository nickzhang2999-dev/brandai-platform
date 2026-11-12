# 2026-11-12 · 2.0 独立骨架开发日志

## 01 · 需求与边界

依据总负责人六点要求：独立 2.0 分区、完整文档、骨架优先、未经明确指示不与主分区合并、Ommi 外部接口、完整 PR。用户 DOCX 属于讨论资料，其图4返工捷径不作为执行规则。

## 02 · 基线调查

- 实际远端：nickzhang2999-dev/brandai-platform；main = `71a3132b68087f9e091777d7a7363f33f25453d9`。
- 同步时 layer-quality = `371e88a`；本批从 main 开新分支，没有将该实验分支的未合并改动带入。
- 原两个本地工作区保留原状态。新独立工作目录为同级 deepflare-2.0。
- 集成分支 claude/deepflare-2.0；开发分支 claude/deepflare-2.0-foundation。解除集成分支对 origin/main 的默认 upstream，避免误推。
- Git SSH 22 连接超时；读取通过 HTTPS，后续正常 Git 推送使用 GitHub 的 SSH 443，仍执行现有 pre-push 门禁。
- 应用的工作区创建接口没有及时返回，未据其结果宣称成功；使用标准 git worktree add 创建并核对工作区。

## 03 · 材料与计划

归档 16 份原始材料（包括用户 DOCX），附源文件 SHA-256、文字索引。历史 Markdown 的本机代码链接改为固定 Git 版本；不将旧方案当成已实现。新增 TODO、架构、接口、决策、交接、验证入口及专用 PR 模板。

## 04 · 骨架实现

- TS/Python 合同、共享合法/非法请求用例。
- 固定上新任务分派，声明灵感/文案/视觉/渠道适配/QA 岗位及记忆种类。
- 版本化方向状态机：先看方向 / 直接制作；退回后修改生成新版本，再提交确认。
- 三张兼容新增表与新 API，原 Studio/Ommi 实现不变。
- 创建/操作的身份重验、作用域、请求哈希、版本 CAS、Serializable 事务和原子派发。
- 空适配器明确拒绝调用；默认双开关关闭；所有回执 executionAvailable=false。
- 新增数据库 CI 和 PR 分支隔离检查。后者只是防误操作检查，不是已配置的 GitHub branch protection。

## 05 · 修复与验证过程

- 宿主默认 pnpm 版本高于项目版本，改用项目锁定的 pnpm 9.15.0；等待完整安装后重新生成 Prisma client 并跑门禁。
- 类型检查发现 deliverables[0] 的可空类型，补运行前检查。
- 负例 fixture 含刻意的 null，与历史“真实 AI 捕获 fixture 禁止 null”目录约定冲突；将负例移入独立 protocol-fixtures，保留旧测试要求。
- macOS/Python 3.14 的既有文档解析子进程用例失败；没有改旧测试或删除资源限制。转到本机 Podman Linux/Python 3.12，对当前完整源码运行 pnpm test:ai，746 项通过。
- 独立 PostgreSQL 16：51 个迁移顺序应用成功，再执行无待执行迁移；10 项实际数据库测试通过。测试异常日志来自并发冲突/唯一约束故障注入，不是遗漏的失败。
- 本地全量和构建结果见 [verification](../verification.md)。无付费模型调用，无正式库访问。

## 06 · 交付与后续

首个 [草稿 PR #70](https://github.com/nickzhang2999-dev/brandai-platform/pull/70) 面向 2.0 集成分支。代码 896b1044eb6334b12c1c5f385998b2f3c382f5be 的完整 CI、数据库 CI 和分支隔离检查全部成功；回执见 verification。没有执行合并、正式部署或配置真实外部服务。下一批从 O-01（Ommi 合同）与 R-01（可恢复的步骤执行器）开始，UI 与记忆按 TODO 交接。

最后补入 PR/CI 链接、F-07 完成状态与预览未部署证据；仅文档变更。临时测试容器已清理，远端 main 与 2.0 集成分支仍为原基线。
