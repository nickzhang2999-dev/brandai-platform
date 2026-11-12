# 2.0 验证记录

更新：2026-11-12。本页只记录实际执行结果。远端 CI 与预览在 PR 建立后补回。

## 本地门禁

| 检查 | 结果 | 证据范围 |
|---|---|---|
| pnpm test | 通过：Contracts 340、UI 39、Web 2171；旧 Web 数据库相关用例 31 项跳过 | 本批新增共享协议 28、领域 11、HTTP 6 项包含其中 |
| pnpm test:ai | Linux/Python 3.12：746 通过 | 本机 Podman 只读挂载完整源码；BRANDAI_TEST_PYTHON 指向容器 Python 包装器 |
| pnpm -F web typecheck | 通过 | 包括新 API 路由及 Prisma 类型 |
| pnpm -F web lint | 通过，0 error / 17 个原有 warning | 未把告警写成全无告警 |
| pnpm -F web build | 通过 | 完整生产构建；新工作单路由在构建输出中 |
| bash cds-release.sh check | 通过 | 7 项资源/发布边界检查 |
| node --test scripts/test-project-release.mjs | 8 通过 | 发布合同、CI 和发布顺序 |
| PostgreSQL 16 新库迁移 | 51 个迁移成功，重复执行无待迁移 | 一次性 deepflare_v2_test，不是业务数据库 |
| 2.0 数据库集成 | 10 通过 | 真实持久化、断连重读、重复/并发确认、原子回滚、作用域、只读权限、撤权和归档 |
| git diff --check | 通过 | 无补丁空白错误 |

实际 Node 命令通过 npx pnpm@9.15.0 调用。首次环境安装未完成时的命令失败不算验证通过，安装完成后重新执行上表。macOS 的既有文档解析子进程测试失败已原样保留记录，完整 AI 验证采用与 CI 一致的 Linux/Python 3.12，未跳过该测试。

本地临时日志位于 /tmp/deepflare-v2-*.log；交接以本页摘要、版本化测试和 CI 回执为准，不依赖临时文件。真实数据库检查代码位于 apps/web/tests/deepflare-v2-database.integration.ts，可复现。

## 尚未验收

- 未新增或验收 2.0 产品 UI；归档高保真 HTML/PNG 是讨论稿。
- 未运行真实 AI 员工，不含付费模型效果、Visual QA、最终稿审核验收。
- 未接入 Ommi 外部接口、记忆存储及写回；仅合同与明确未接入的适配器。
- 尚未配置 2.0 独立 CDS 环境，不把“源码可构建”写成“预览/正式环境已部署”。
- 首批 API 默认关闭；READY 只代表已确认的待执行交接记录。

## PR 与远端验证

待建立草稿 PR 后记录链接和精确提交；保持目标为 claude/deepflare-2.0，不合并主分支，不开启自动合并。
