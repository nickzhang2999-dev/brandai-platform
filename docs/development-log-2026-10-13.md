# Novart 开发日志 · 2026-10-13

## 工作区切换与两个功能迁移

用户指定 `devUpdate1012` 为后续开发区域，要求将昨天新增的品牌知识管理、AI 分层放入该分支，本轮先不处理 CDS。

实际核对：目标仍是公司仓库 `nickzhang2999-dev/brandai-platform` 的分支，起点 `5499be0fbed5926084ec29892f9a4c23643b6aa4` 与用户截图一致。它已包含 main 的首页/登录进入 Studio 修复、旧评审入口兼容及新提交规则。

新建独立本地 checkout：`D:/coding/公司/brandai-devUpdate1012`。安装 `scripts/install-cds-push-guard.cjs`，保留分支现有规则，普通推送必须通过本地钩子。

从 `D:/coding/公司/brandai-workbench-preview` 的 `74e2db2` 加未提交工作树迁入 77 个限定源代码/测试文件，包括两份 additive migration、知识管理入口、分层任务/Worker/归档、画布结果展开和跨页通知。旧工作区未修改，四个既有脏文件及私有配置未迁入。迁移备份与逐文件 SHA256 清单位于 `D:/coding/.novart-tmp/devUpdate1012-transfer-20261013`。

首次迁移内容核对因 Git CRLF 转换导致字节哈希不一致而停止；核对换行标准化后的内容逐文件相同后，在新目录恢复源文件字节，并重新核对全部 77 文件一致。没有用源文件覆盖不同的功能代码。

新目录离线安装依赖失败：本目录缓存缺少锁文件中的 AWS SDK 包。随后按未修改的锁文件联网安装 434 个包成功，未将旧工作区 node_modules 或账号配置复制到新目录。

## 当前验证与完成边界

三个并行任务分别负责两个旧测试缺口、后端迁移审阅、前端资源与隔离浏览器验收。全仓重型检查由主线程顺序执行，避免并发构建挤占内存。

| 本轮在新 checkout 实际执行的检查 | 结果 | 本地证据 |
| --- | --- | --- |
| L1 全仓，强制执行、无缓存 | 契约/服务 1147 项、UI 28 项通过 | `D:/coding/.novart-tmp/devUpdate1012-l1-20261013.log` |
| AI 服务完整 pytest | 421 项通过 | `D:/coding/.novart-tmp/devUpdate1012-ai-tests-20261013.log` |
| Web 全量类型检查 | 通过 | `D:/coding/.novart-tmp/devUpdate1012-typecheck-20261013.log` |
| Web 生产构建 | 通过，含知识管理与分层路由 | `D:/coding/.novart-tmp/devUpdate1012-build-20261013.log` |
| 原画布完整 Chromium 回归 | 49 项通过，包含画笔、文字、图片、撤销、保存重开、PNG/SVG 及工具栏稳定性 | `D:/coding/.novart-tmp/devUpdate1012-owned-core-20261013.json` |
| 新 AI 分层画布交互 | 10 项通过，含部分下载失败不插入、整组撤销、原图保留、重开 | `D:/coding/.novart-tmp/devUpdate1012-ui-20261013-layers.json` |
| 品牌知识交互 | 14 项通过 | `D:/coding/.novart-tmp/devUpdate1012-ui-20261013-knowledge.json` |
| 分层跨页任务通知 | 16 项通过 | `D:/coding/.novart-tmp/devUpdate1012-ui-20261013-inbox.json` |
| 原资源清单校验 / Studio 导出 | 173 项通过；导出 124 文件、76 外部资源、27,072,925 字节 | `D:/coding/.novart-tmp/devUpdate1012-ui-20261013-source-freeze.json` |
| 原生推送钩子真实 Git 回归 | 14 项通过 | `D:/coding/.novart-tmp/devUpdate1012-push-guard-20261013.log` |
| 旧目录保留复核 | 77 个功能源文件与 4 个既有脏文件的 SHA256 均未变化 | 原迁移清单及保留清单 |

AI 测试在新目录独立创建的 Python 3.12.9 venv 中执行，使用仓库固定的 requirements；Windows 入口为 `apps/ai/.venv/Scripts/python.exe -m pytest -q`，与仓库 `test:ai` 的 pytest 检查范围一致。没有借用旧工作区运行时。仅有一条 Starlette TestClient 的 httpx 弃用警告，不影响通过；本轮不改依赖协议。

浏览器测试运行实际 React 页面及样式，使用隔离 loopback 内存服务；报告明确标记 `realBackend=false`、`realProvider=false`、`realAuthentication=false`、`providerCalls=0`。它们证明交互回归，不能替代真实账号、业务数据库、模型质量或正式环境验收。

## 两个迁入功能及整合修正

- **品牌知识管理**：增加 `/studio-brand-knowledge` 入口，复用七类品牌规则、禁用项、术语与快照接口；支持编辑/确认、草稿导入和快照恢复。草稿导入读取真实保存的草稿 revision，新增幂等导入回执，只写待确认的色彩/字体规则，不直接覆盖已确认品牌规则。
- **AI 分层**：增加持久分层任务、队列与 worker、真实 Fal 协议、私有图层归档和授权 raw 读取。画布可查看任务、显式把结果插入为整组，保留并隐藏原图，支持一次撤销和保存重开；全局任务通知可返回原项目。后台持久记录付费 claim，模型请求不自动重试；归档重试仅使用既有模型结果。
- **旧测试缺口修复**：raw 图层读取测试补齐授权、404/422/500 和私有数据不泄露检查；解构契约测试覆盖可选 `providerRetryPolicy=never` 及非法值。对应 63 项检查通过，没有删断言或放宽验证。
- **收尾修正**：去掉契约入口重复导出；三个迁入 shell 文件统一 LF，移除 HTML 第 55 行 6 个行尾空格，同步资源 SHA256 并重导出；移除知识编辑组件及其测试的文件末尾多余空行。最后的变化只有空白，已保留之前的浏览器报告并记录源文件哈希。
- **后续持续验证**：在现有 GitHub 产品整合工作流中加入分层、知识管理、任务通知三个隔离浏览器检查和报告真实性断言，保留原验证链路及正常推送流程。

后端只读审查未发现本次迁移漏文件或新增越权入口。原识别/手册解析的旧队列、Mock 配置边界及付费幂等与新分层链路不同，是后续真实验收的历史风险，未在本轮扩展修复范围。

## 交付边界与下次起点

两个功能的源码迁移和本地检查已完成，交付目标仅为公司同一仓库的 `devUpdate1012` 分支，按正常 commit / push 流程发布源码。最终提交与远端匹配结果以分支 Git 记录和 `D:/coding/.novart-tmp/devUpdate1012-delivery-20261013.json` 为准；本日志不填写自身提交 SHA。

保留分支已有 `AGENTS.md`、`CLAUDE.md`、普通推送钩子及历史文档策略失效提示。未修改 main、CDS 配置、共享业务数据和旧目录。未复制任何私有配置；生成物、依赖环境和本地验证日志不纳入 Git。

本轮没有运行真实模型、业务数据库迁移或 CDS 操作；自动工作流是否成功不从本地结果推断。下一次从 `D:/coding/公司/brandai-devUpdate1012` 继续，先在批准使用的隔离环境应用两份 additive migration，再用真实账号验收品牌知识持久化和一张图片的真实 AI 分层，随后按用户安排推进管理页、识别/手册解析等后续优先级。
