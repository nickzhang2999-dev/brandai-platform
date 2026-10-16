# P2 安全优化 · 本地执行记录

执行日期：2026-10-16。依据公司目录下 `brandai-优化执行计划-2026-10-16.md` 第 2 阶段。用户要求暂时只保留本地成果，继续开发后汇总。六项修复、四道本地门禁及编译后启动验证均已完成，最终代码提交 `5de6ffc`。

当前分支 `fix/p2-security` 从 `devUpdate1012@2cf3932` 建立；P1 保留在 `fix/p1-remove-captured-bundle@97ed7fb`。两个阶段独立，P2 不包含 P1 的旧抓取包清理。没有合并、推送、部署或创建线上数据库。

## 六项改动

| 项目 | 本地提交 | 变更与对应文件 |
| --- | --- | --- |
| 2.1 素材对象键归属 | `cfc8a5a` | `lib/asset-storage-key.ts` 与工作区 `assets/route.ts`：客户端 key 必须属于当前工作区，拒绝跨品牌、路径穿越和 URL 混淆，返回 422；鉴权后、存储配置读取及写库前完成检查。 |
| 2.2 内部错误脱敏 | `0b2b2fa` | `lib/api.ts`：未知异常和显式 500 只返回 `InternalError` 与 `requestId`，服务端日志用同一 ID 关联原错误；保留验证错误与有意提供的业务错误。 |
| 2.3 生产注册权限 | `43a207b` | `api/auth/register/route.ts`、`lib/admin.ts`、`lib/settings.ts`：生产环境关闭首个注册者自动提权；明确管理员名单和已有管理员仍有效，开发环境初始化保持原行为。 |
| 2.4 预检权限 | `20e844a` | 工作区 `compliance/precheck/route.ts` 与 `generations/precheck/route.ts`：至少 EDITOR；VIEWER、REVIEWER 在业务处理前拒绝，项目归属仍校验。 |
| 2.5 上传边界 | `efd3a6c` | `lib/asset-upload-policy.ts`、`lib/upload-limits.ts`、素材上传/raw 路由、`next.config.mjs`：有界读取实际流，检查文件头，文档最大 50 MiB，品牌素材图片保持 8 MiB，Studio 独立图片保持 10 MiB。 |
| 2.6 生产密钥启动检查 | `54f4f49`、`5de6ffc` | 共用 `apps/web/runtime-security.mjs`、Next 生产配置、instrumentation、worker 入口与三个启动脚本 preflight：生产缺失、短于 32 个非首尾空白字符或示例占位密钥时拒绝启动；只检查，不改实际密钥。 |

以上 `lib/`、`api/` 路径相对 `apps/web/src/`；完整测试在 `packages/contracts/tests/`。补充提交 `a9437ff` 修复严格类型检查发现的可缺失 MIME/环境字段类型，并清理测试文件末尾空行。

上传、认证、素材归属/权限三个子智能体并行，主智能体负责错误边界、交叉复核和串行全量门禁。独立复核未发现新的明确回归；这不是对所有安全问题的全面审计。

## 行为与兼容性

- 对象键检查只在客户端创建素材入口执行。历史 `brand-kit/`、`previews/` 以及网站来源素材的读取不增加前缀要求。
- 只有内部 500 使用固定公共响应；原有 4xx 验证说明、明确编写的 503 服务不可用说明保留，避免把可操作的配置提示全部抹掉。
- 生产注册关闭且没有管理员名单时，不再为首个请求绕过注册开关；注册开放时首个用户仍是普通用户。没有修改现有用户或管理员记录。
- 上传在 `formData()` 前累计实际字节，最多 50 MiB + 64 KiB 表单包络；无/假 `Content-Length` 同样受限。读取与解析 30 秒期限，超时 408，文件超限 413，不支持类型 415。
- 接受 PNG、JPEG、WebP、GIF、SVG、PDF、PSD。类型由内容识别，文件名和客户端 MIME 不决定放行。重复/未知字段及非文本元数据拒绝。
- SVG/PDF/PSD 在存储中使用 `application/octet-stream`；数据库保留检测出的真实 MIME。鉴权 raw 下载附加 attachment + nosniff，PSD 不再落入内联图片分支。PDF 手册按原字节解析，未发现 MIME 改动破坏该入口。
- 密钥共用检查由 Next 的 `PHASE_PRODUCTION_SERVER`、运行时 `register()`、worker 最早入口调用。`scripts/web-startup.sh`、`scripts/worker-startup.sh` 与 `deploy/novart/start-web.sh` 在占位服务、安装、迁移前运行无依赖 CLI 检查；构建导入不要求生产密钥，不更改 `AUTH_SECRET` 或 `SETTINGS_ENC_KEY` 的真实值。

## 验证记录

新增及调整的测试：`asset-storage-key-route`、`api-error-boundary`、`register-security`、`precheck-permissions-route`、`asset-upload-policy`、`asset-upload-route`、`runtime-security`、`studio-materials-middleware`。同时回归历史 raw 下载与 Studio 上传。

初次 Web 类型检查发现两项严格类型错误（可能为空的 MIME 首段和 `ProcessEnv` 可缺失字段），已修复；上传/raw 61 项和运行时校验 15 项重新通过，随后完整 L1、类型检查与生产构建重新验证。AI 代码未变，其本轮 500 项结果继续有效。

Windows 等价门禁命令：

```powershell
node node_modules/turbo/bin/turbo run test --force -- --maxWorkers=1 --minWorkers=1
# 相当于 pnpm test；强制重跑，不使用 Turbo 缓存。
cd apps/ai
.venv\Scripts\python.exe -m pytest -q
# 相当于 pnpm test:ai；仓库该脚本使用 Unix 的 .venv/bin/python。
cd ../..
pnpm -F web typecheck
pnpm -F web build
```

最终原样摘要（代码提交 `5de6ffc`；AI 测试之后没有 AI 代码改动）：

```text
@brandai/ui:test:  Test Files  5 passed (5)
@brandai/ui:test:       Tests  34 passed (34)
@brandai/contracts:test:  Test Files  142 passed (142)
@brandai/contracts:test:       Tests  1737 passed (1737)
 Tasks:    2 successful, 2 total
Cached:    0 cached, 2 total

500 passed, 1 warning in 5.39s

> next typegen && tsc --noEmit
Generating route types...
✓ Route types generated successfully

 ✓ Compiled successfully in 9.4s
 ✓ Generating static pages (36/36)
   Finalizing page optimization ...
   Collecting build traces ...
```

四项进程均退出 0。日志保存在本地忽略目录 `.novart-build/p2-{test,ai,typecheck,build}-20261016.log`。构建使用仓库现有低内存选项（`NOVART_LOW_MEMORY_BUILD=1`、768 MiB heap 与单进程配置）；不关闭既有门禁，也不改部署配置。已有 `ignoreBuildErrors` 配置不作类型正确证据，独立 `typecheck` 已通过。

AI 测试包含现有 Starlette/httpx 弃用警告；构建包含依赖 `url.parse()` 弃用警告及指向 `127.0.0.1:1` 的连接拒绝日志。本次构建主动将 DB/Redis/AI 指向不可用的本地地址以避免触碰真实服务，构建退出 0 不等于这些服务联通。没有导出或发布 P2 的旧预览静态包，也没有把磁盘上先前 P1 的静态产物当 P2 页面验收证据。

### 编译后启动发现的缺口

初版 `a9437ff` 的四项门禁虽然退出 0，但实际启动检验发现 P2.6 尚未通过：缺失、短值、示例占位值三种合成密钥均触发安全错误，Next 仍打印 Ready 并保持运行，13 秒后由验收脚本终止其自有子进程。不能将此时的单元测试绿色等同于生产进程已拒绝启动。

只读核对安装的 Next 15.5.24 代码：生产 `NextServer.prepare()` 不等待底层 `server.prepare()`，因此 instrumentation 的异常并不是可靠的 CLI 启动闸门。本次不归因于 CDS。`5de6ffc` 已补生产配置加载阶段的显式检查，以及 Web/worker 启动脚本在占位健康服务、安装和迁移之前的 preflight；未修改 CDS compose。

初次脱敏报告保留在 `.novart-build/p2-runtime-startup-proof-before.json`。使用合成无效密钥、临时 loopback 端口和隔离子进程，报告只包含布尔值、场景名及退出码。

新构建实际启动复验 **3/3 通过**，验收脚本退出 0，约 1.3 秒完成：

| 合成密钥场景 | 子进程退出码 | 安全检查触发 | 出现 Ready | 超时 | 连接拒绝日志 |
| --- | --- | --- | --- | --- | --- |
| 缺失 | 1 | 是 | 否 | 否 | 无 |
| 过短 | 1 | 是 | 否 | 否 | 无 |
| 示例占位 | 1 | 是 | 否 | 否 | 无 |

最终报告 `.novart-build/p2-runtime-startup-proof.json`。另已把无 BUILD_ID 临时项目的真实 Next CLI 拒绝场景纳入 `runtime-security.test.ts`，随常规门禁持续运行；不只依赖一次性的本地验收脚本。测试使用隔离配置与合成密钥，不输出真实密钥，不启动或迁移真实数据库。

## 真实边界与后续

1. 本轮是本地代码与安全边界测试。没有真实 SQL/S3 持久化验收、模型调用、CDS、GitHub Actions 或正式发布验收。
2. 文件头检测不保证图像或文档可完整解码；SVG 检测不是完整 XML 清洗。DTD/ENTITY SVG 主动拒绝，不能承诺所有历史 SVG 都可重新上传。
3. 30 秒仅覆盖上传请求体读取与解析；后续对象存储写入仍沿用原调用。请求体内存已设上限，但不是零复制上传，也不代替入口并发限流。
4. 预检后台异步化、AI 超时/中止、过期任务清理属于 P3；本次没有把这些标成完成。
5. P1/P2 均仅保留本地分支。合并到 `devUpdate1012`/`main`、修改 CDS 配置、线上迁移、改真实密钥仍遵循计划中的确认边界。
