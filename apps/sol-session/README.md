# Sol 海报会话本地试点

在完整画布选中已保存的商品图，展开「对话改图 → Sol 海报简报」。填写设计需求即可拿到外观图、场景图和卖点图的文字方案。简报需要补受众时，在同一面板回答。点击「记住这组构图」，可在同一浏览器标签页换项目后明确选择沿用。浏览器只携带三个构图选项。新选区的品牌、卖点、受众由服务端重新读取。项目内的简报历史保存在数据库，可跨刷新打开。

## 本地运行

1. 使用工作区已有的 Web、PostgreSQL、Redis 和文案 Worker，按原有 Sol 工作区开关启用测试品牌。
2. 在本目录执行 `cargo build --release --locked`。准备 Node 24 和含 `@deepseek-ai/dsh` **0.2.1-rc.2** 的 SDK 运行目录。这里的 `SOL_DSH_MODULE_ROOT` 应指向含 `package.json`、`node_modules` 的目录。桌面安装提供的 `resources/app/dsh` 可用于本机验证。
3. 在本机启动支持 OpenAI Chat Completions 和工具调用的文本模型。实测组合为 llama.cpp、Qwen2.5-1.5B-Instruct Q4_K_M 和 8192 token 上下文。模型地址仅允许回环 HTTP。
4. 在 Web 和文案 Worker 设置 `SOL_DSH_ENABLED=1`。Worker 还需以下配置。完成后重启这两个本地服务。

| Worker 配置 | 值 |
| --- | --- |
| `SOL_DSH_EXECUTABLE` | 上一步编译的 Rust 可执行文件的绝对路径 |
| `SOL_DSH_NODE`、`SOL_DSH_SIDECAR` | Node 可执行文件、本目录 sidecar.mjs 的绝对路径 |
| `SOL_DSH_MODULE_ROOT` | 固定版本 SDK 的安装目录 |
| `SOL_DSH_HOME` | 服务账号专用、可持久写入的绝对路径 |
| `SOL_DSH_MODEL_URL`、`SOL_DSH_MODEL` | 本地文本模型的 /v1 地址及注册名 |

服务端先验用户、项目、选区和资料版本，再将快照交给 Worker。每轮文本规划启动隔离的 SDK 进程。Rust 校验工具名、当前会话和空参数；Skill 取出三组资料，模型可按需再调同一组只读工具。DSH 的会话日志记录模型看到的资料，运行目录应与数据库按同一访问范围管理。成功回执在数据库中保存工具读取、事件序号和模型返回的下一步。进程未交回可验证结果时任务失败，需核对该次文本调用。关闭开关后，历史简报仍可阅读。

## 复验

- `cargo test --locked` 检查 Rust 权限和字段投影。
- 设置上述 Worker 变量后执行 `python tools/sol-brief-eval/session-protocol.py`。它在本机启动可控的文本协议端点，验证 DSH 发出工具请求、读取结果、重启恢复和拒绝不存在的会话。
- 独立测试栈使用本机 26490 端口。预置测试用户和两份 fixture 对应的虚构品牌，商品样本位于 `tools/sol-brief-eval/fixtures`。设置 `TEST_CHROME` 和 `SOL_TEST_DATABASE_URL` 后执行 `node tools/sol-brief-eval/session-canvas.cjs`。它只接受本机 26488 端口的 brief 测试库，核对两品牌归属，每次新建测试项目，实际上传素材、保存资料并提交简报。
