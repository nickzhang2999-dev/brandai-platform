# Sol 简报本机对照

本目录只处理随仓库提供的两份自制样本。客户端固定访问 127.0.0.1，密钥为本机占位值。CLI 所用工作区参数只在测试目录定位样本。接入产品要从已鉴权的服务端选区读取资料。

使用 Rust 1.85.1 或兼容版本，在此目录执行以下命令。每次比较都会启动仅供本次使用的本地端口；结果按 JSON 输出，任何一项失败时返回非零退出码。

```sh
cargo build --locked
python3 compare.py ./target/debug/sol-brief-eval
python3 compare.py ./target/debug/sol-brief-eval --gguf /path/to/qwen.gguf --app-python /path/to/studio-ai-python
```

第一条 Python 命令只测协议异常，使用标准库。真实推理请用安装了 llama-cpp-python 0.3.16 的 Python。--app-python 指向装有 apps/ai 依赖的 Python，用于加入现有 Studio 客户端作对照。自定义 CARGO_TARGET_DIR 时相应替换可执行文件路径。实测权重为 Qwen2.5-1.5B-Instruct Q4_K_M，SHA-256 为 `6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e`。[模型来源](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF)

[阶段报告与通过条件](../../docs/deepflare-2.0/logs/2026-11-26-sol-brief/阶段报告.md)

## 在完整编辑器验收首张外观图

使用仅绑定回环地址的隔离环境。浏览器脚本校验数据库为 `127.0.0.1:26488/brief`，要求已有归属测试账号的两套样本品牌，并为每次运行单独创建项目。它给这个临时账号生成一次性密码，走正常登录页使用的认证接口。

1. 在本地启用 Sol 会话和原生派发，使用本地文本模型。启动编辑器、Worker、AI 服务、Redis 和本地对象存储。千问使用支持工具调用的聊天模板；llama-server 需开启 `--jinja`。
2. 创建临时目录，运行 `python tools/sol-brief-eval/appearance-fixture.py <该目录中的调用记录文件>`。将隔离环境的图片接口指向 `http://127.0.0.1:26492/v1`，使用支持多部分参考图的图片接口格式。夹具核对收到的商品图字节与需求，返回标有测试字样的方图。
3. 设置 `SOL_TEST_APPEARANCE=1`、`SOL_TEST_IMAGE_CALLS`（同一调用记录文件）、`SOL_TEST_DATABASE_URL` 和 `TEST_CHROME`，执行 `node tools/sol-brief-eval/session-canvas.cjs`。最后两行 JSON 分别记录外观图的请求和哈希、跨商品连续对话结果。

这项本地验收覆盖确认、原生任务、实际存储与浏览器恢复。商业模型的出图质量及账单需要使用获准的模型另验。
