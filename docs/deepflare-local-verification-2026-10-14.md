# DeepFlare 本地验证报告 · 2026-10-14

## 结论

当前本地源码与已完成门禁的工作树一致，构建资源没有漂移。新增本地生产 Next 实际运行检查 18 项通过（HTTP 11、Chromium 7）；关键模型/图片工具拒绝路径重新执行 TypeScript 19、Python 26 项通过。完整登录后业务、真实 SQL/worker/S3 以及模型质量尚未验收，不能称本轮完整产品端到端通过。

工作区为 `D:/coding/公司/brandai-devUpdate1012`，分支 `devUpdate1012`，基线 HEAD `928ab0a44db5e4e84d4da188bad8a3d20e19d9a9`。业务源码没有再次修改，依旧是本地未提交版本。没有推送、合并 main、部署、操作 CDS、公司数据写入或真实模型调用。

## 源码与构建完整性

| 核对项 | 结果 |
| --- | --- |
| 源码/资源记录 | 912/912 文件路径、大小、SHA256 一致 |
| 工作树摘要 | `5106fd79b24f6b663ea889c9e3c00d30598b8f7d8ad3a93672c91f2cb5de701e` 精确一致 |
| Studio 导出 | 125/125 文件大小及 SHA 一致，27027753 字节 |
| 捕获映射 | 76 项，均指向有效本地文件；bootstrap 与 manifest 一致 |
| 清单摘要 | `91b9d95cf971d664e1fc0ffe22c4c656952011bbdbc606328aa4e4efca560f13` |
| Next 构建 ID | `pwhNoLU-BKlpndVMiMJ18` 与上次记录一致 |

源码总摘要采用 `json.dumps(sourceFiles, ensure_ascii=False, sort_keys=True, separators=(',', ':'))` 的 UTF-8 字节计算 SHA256；不是未经说明的路径拼接。逐文件一致与总体摘要均重新核对。

## 已有门禁及本轮新增运行检查

四份完整门禁日志重新读取核对：L1 契约/服务 1447、UI 34，AI 487，类型检查 4 任务成功，生产优化编译和 36/36 静态页生成完成。L1 为强制新执行；类型检查的 Web/Contracts 新执行、DB/UI 使用有效缓存。构建有 `DEP0169 url.parse()` 弃用警告与依赖连接拒绝诊断，AI 有 Starlette/httpx 弃用警告。简短构建错误没有完整目标栈，不把所有连接拒绝断言为 Redis。

当前摘要未变化，因此没有无故重跑完整门禁。本轮实际新执行：

- TypeScript 19 项：冻结引用、固定快捷目标、低置信澄清、继续上一张、未知模型结果、失去任务归属/过期、图片工具能力及外品牌拒绝。
- Python 26 项：非法引用、固定目标不符、配置缺失/不支持提供者、非法蒙版及单次调用边界；使用合成传输，真实模型调用 0。
- 本地生产服务 HTTP 11 项：真实 Next 启动，登录页 200，根跳转 Studio，未登录 Studio 转回登录，实际 Logo 200；素材列表、上传、对话 GET/POST/PUT、图片工具 GET/POST 均返回 JSON 401。
- 生产 Chromium 7 项：实际构建登录页完成 hydration、唯一主标题、明/暗 Logo 解码、真实认证提供者列表没有免密演示登录、注册界面切换、390px 无横向溢出，无页面异常/外部请求/账号写入。

生产服务仅绑定随机 loopback 端口，子进程覆盖数据库、Redis、AI 和 worker 地址为隔离本地地址，清除继承的外部凭据变量，并关闭模型/图片工具开关。没有使用合成登录或替换真实页面 HTTP；也没有提交注册/登录表单。测试结束生产服务和浏览器均已关闭。

第一次生产浏览器尝试使用不存在的简写“注册”按钮选择器，HTTP 11 和浏览器前三项已通过，其后等待超时。按真实页面“没有账号?去注册 / 已有账号?去登录”调整测试定位后整轮 18 项通过；未修改产品按钮，也未使用强制点击。首轮失败报告仍保留。

现有画布52/PSD19/素材抽屉12/品牌库8的91项浏览器报告完整、无错误或外部请求；对话13和选图工具11报告仍为明确隔离 HTTP 回执，不能代替 SQL、身份或模型验收。

## 尚缺的真实运行环境

只读核对 PATH、常见安装/工具目录、相关 Windows 服务/进程和 loopback 监听，未发现可用的 PostgreSQL、Redis/Memurai 或 MinIO 服务器。`ioredis` 等包是客户端，不能当作已运行服务。本轮没有启动 Docker/WSL、安装运行时或读取公司凭据。

现有真实验收脚本要求本地地址与专用测试库，不能改成公司共享数据库来绕过：

| 依赖 | 验证用途 |
| --- | --- |
| PostgreSQL 16 / `novart_integration_test` | 执行新迁移、真实身份/会话/草稿/素材/项目隔离及保存恢复 |
| Redis 7 / 应用 worker | 上传、编排、生成、超时、重启与消息回执 |
| loopback S3/MinIO / 私有测试桶 | 实际图片归档、读取、SHA 和跨项目复用 |
| 真实提供者配置 | 新图、改图、结构化意图、透明去背景、局部修复、分层及 PSD 质量 |

因此真实注册/登录、画布 DB 保存恢复、真实素材上传、worker 关页继续、真实 AI 和 PSD 质量仍为待验收。模型意图及图片工具默认关闭；原图裁切/翻转/旋转后蒙版、外链素材迁入的已知差异保持。真实 Mac/Safari、三域登录、分区及公网版本也没有在本轮验证。

后续应先在独立本地测试栈执行迁移和真实后端/页面验收脚本，再单列提供者质量检查；不能用现有模拟回执或登录入口成功宣布这些项已经通过。

## 证据位置

- 源码/构建汇总：`.novart-build/handoff-local-verification-20261014.json`。
- 实际生产运行：`.novart-build/runtime-verification-20261014/production-runtime-report.json`、`production-browser-report.json`、`production-next.log`。
- 首轮定位失败：同目录 `*-first-attempt.*`。
- 原画布/PSD/素材库报告：仓库外 `D:/coding/.novart-tmp/handoff-*-20261014.json`。
- 完整门禁日志：`.novart-build/handoff-final-{l1,ai,typecheck,build}.log`。

完整实现范围和差异见 [交接包实施记录](deepflare-handoff-ui-2026-10-14.md)，当日历史保留在 [开发日志](development-log-2026-10-14.md)。
