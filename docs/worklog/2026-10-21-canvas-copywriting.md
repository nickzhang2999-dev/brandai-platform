# 2026-10-21 画布文案开发记录

## 范围与隔离

- 用户希望在实际产品画布中增加千问文案生成，提供了 Anthropic 兼容接口与 `qwen3.7-plus` 模型名。
- 原工作区存在其他协作者未提交的外部信号改动，未修改其文件。新建独立本地工作区 `D:/coding/公司/brandai-canvas-copywriting`，分支 `claude/canvas-copywriting`，基于 `origin/devUpdate1012` 的 `d049a46`。
- 没有推送、合并 main、部署 CDS、修改在线账号或共享数据；没有数据库迁移，没有启动 Docker Desktop。

## 本轮实现

1. 画布顶部增加「文案」入口：生成、改写、语气选择、可选参考图片、历史任务、失败和配置缺失提示。
2. 文案以标题＋正文展示，点击插入原生画布文字，可编辑、撤销、重做、保存恢复；长文本先按宽度换行，同一候选重复点击不会不断添加副本。
3. 新增 workspace/project scoped API、契约及 Python 镜像。服务端认证和项目权限生效，写入来源校验沿用现有规则。
4. 复用 AsyncTask 作为持久待办和结果存储，新增队列 Worker。POST 快速返回 202，不等待模型。原子抢占、有限期限、幂等恢复、防重复付费、脱敏错误与使用量记录接通。
5. 独立 Qwen Anthropic 适配器，密钥只在服务端读取。限制响应体大小；拒绝被截断或结构错误的结果。选图支持服务端归属与哈希校验、受控缩略图传输。
6. 通知中心显示本人文案完成/失败事件，过滤已不存在的项目，不在通知中暴露提示词。

## 实测结果

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| 真实千问文本请求 | 成功 1 次 | 返回 3 组标题正文；173 输入 token、234 输出 token，约 4974 ms；直接使用正式适配函数，小规模合成测试需求 |
| 文案真实浏览器交互 | 9 项通过 | 实际 React 组件和样式；插入、去重、撤销、重做、刷新恢复、历史恢复、文字编辑、使用选中文字改写、窄屏布局 |
| 原有画布浏览器回归 | 55 项通过 | 绘制、上传、选择、变换、对话恢复、权限、保存冲突、图层、画框和 PNG/SVG 导出等 |
| contracts / UI / Web 全量单元测试 | 309 / 39 / 1812 通过 | 新文案用例包括接口权限、幂等、素材归属、任务生命周期和通知隔离 |
| Python AI 全量测试 | 649 通过 | 1 条现有 Starlette 弃用提示 |
| Web typecheck | 通过 | next typegen + tsc |
| Web production build | 通过 | Next 生产构建 |
| 发布合同 | 通过 | `bash cds-release.sh check` 7 项；`node --test scripts/test-project-release.mjs` 6 项 |

浏览器报告明确标记：本地内存 API 交互夹具，不是真实认证/数据库/模型完整链路。真实模型证据与交互证据分别记录，不混为端到端验收。真实参考图文案请求、账号额度计费金额和生产可用性没有在本轮宣称验证。

## 修复与环境细节

- 浏览器测试发现原文 label 同时包裹按钮与输入框，影响可访问名称和定位；拆开后「使用选中文字」实际点击通过。
- 修复提交成功后旧轮询响应可能覆盖新任务的问题：接收成功回执后丢弃此前发起的过期 GET。
- 保证 PostgreSQL JSONB 的键顺序变化不会使相同提交误判为内容冲突。
- Python 输入镜像同步拒绝显式 `image: null`，与前端契约的可省略字段保持一致。
- 初次全量通知测试中，旧测试将所有 AsyncTask 查询视作旧业务访问；对新私有文案通知源做独立 mock，并补专门的隔离测试，没有删除旧边界断言。
- Windows 默认 bash 指向不可用 WSL，且 Git checkout 将 shell 文件写为 CRLF。使用现有 Git Bash，工作副本 `cds-release.sh` 换行归一后合同全绿；没有更改发布逻辑或放宽检查。

## 证据位置与后续

本地忽略目录 `.novart-build/`：`copywriting-live-result.json`、`copywriting-browser.json`、`copywriting-canvas-regression.json`、全量测试、AI 测试、typecheck、build 和 release 日志。未把真实密钥写进这些报告。

仍待：在可用且隔离的真实 PostgreSQL/Redis 环境，用真实登录账户完成 API 提交 → Worker → 千问 → 结果落库 → 刷新恢复 → 插入保存的完整链路；验证参考图文案质量。之后再按用户部署指令配置 Web 与 Worker 的服务端变量并发布。当前 `.env.local` 仅为本地私密配置，不会随 Git 自动上传。

功能使用与配置见 [画布 AI 文案](../canvas-copywriting.md)。
