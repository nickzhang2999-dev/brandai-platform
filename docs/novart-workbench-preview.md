# Novart 独立前端评审版

本次将独立前端体验程序归入 `claude/novart-workbench-preview` 分支。目录为 `previews/novart-workbench`。现有 Next.js 页面、正式业务接口、数据库结构及根 `cds-compose.yml` 不变。

## 范围

- 首页填写原始需求，选取最多四张 PNG/JPEG/WebP 图片，预览、移除、失败重试，进入同一项目的原画布。
- 图片经原生上传、编辑和自动保存；刷新、响应丢失和重开时恢复，避免重复创建和重复导入。
- 项目库使用中/已归档、归档撤回、恢复继续；素材与需求保留。
- 保留已有文字、图形、画笔、图片、图层、撤销重做和已验证导出操作。
- 保留本地品牌规范与个人偏好页面；品牌规则的生产集成、AI 生成和账户协作仍未接入。

它是独立的可操作交互评审件。AI 和生产业务未接入，不把演示图片当作真实生成结果，不把分支入库称为已上线。来自捕获前端的第三方构建资源与自行编写的适配代码分开保留，权属与来源见目录内 `THIRD_PARTY_NOTICES.md`。

## 本地运行

安装 Python 3.12 后，在仓库根目录执行：

```sh
cd previews/novart-workbench
python -m pip install -r requirements.txt
python harness/share_runtime.py --port 8769 --room review
```

服务启动后会生成 `sharing/review/runtime.json` 与随机访问密钥，均已忽略，不进入 Git。在同一目录的另一个终端运行链接工具，打开输出的完整入口：

```sh
python print_review_link.py --origin http://127.0.0.1:8769 --room review
```

浏览器使用 Chrome 或 Edge；服务端不需要安装浏览器、Playwright 或浏览器代理。

## CDS 接续部署

本次 Git 交付不修改已有 CDS 应用配置，也不发布 `www.novartlab.com`。

**不能直接用根 `cds-compose.yml` 来验收这个前端：那个文件仍然指向原 Next.js 应用。** 新评审服务的配置是 `previews/novart-workbench/compose.preview.yml`。在 CDS 新建/导入这条评审分支时需要明确使用这份配置；若当前 CDS 页面只允许固定读取根配置，应在后续部署步骤单独调整这条分支的根配置并走配置审批，不覆盖现有 main/正式服务。

运行要求：独立 HTTPS 子域名的根路径、同源接口、支持 Service Worker、单实例持久数据目录。不要把它当作纯静态 HTML 服务挂在现有应用的 `/demo` 子路径。HTTPS 网关应透传 `X-Forwarded-Proto`，并允许最多 24 MiB 请求体；单张首页图片仍限制为 10 MiB。

评审入口包含随机访问凭证。部署时生成新的凭证，操作人员从服务内读取完整链接后私下提供给评审人；不提交到 Git，不放进公开文档或构建日志。同一链接代表同一个评审空间，不提供多租户权限或多人同时编辑保障。

## 数据与保留项

分支只带运行必需代码、固定前端构建资源、资源来源映射和说明。没有复制开发机项目、上传图片、浏览器会话、测试结果目录、个人访问密钥、虚拟环境或依赖缓存。

首次运行从空评审空间开始。`sharing/` 为可变数据，部署时挂持久卷；服务重启应继续读取同一卷。不要在两个独立进程里同时打开同一份数据目录。

原 FingerprintSDK agent 脚本加载告警仍是已知边界，与 AI 未接入提示分开记录。已验证的本地交互不能替代 Linux 容器、公网 HTTPS 或真实业务验收。

## 验证状态

2026-10-07 实际验证结果：

| 检查 | 结果 |
| --- | --- |
| `pnpm test` | 254 项通过（contracts 248 + UI 6） |
| `pnpm test:ai` | 155 项通过 |
| `pnpm -F web typecheck` | 退出码 0 |
| `pnpm -F web build` | 退出码 0，编译及路由构建完成 |
| 独立入口普通 Chrome 操作 | 12/12 通过；无测试网络代理、请求拦截或登录 cookie 注入 |
| 独立 Compose 配置解析 | `docker compose -f compose.preview.yml config --quiet` 通过 |

浏览器实测覆盖无凭证访问隔离、Service Worker 启动、首页两图预览与上传、原画布保存、原需求保留、中文文字编辑保存、归档只读、恢复继续，以及关闭浏览器和服务后换端口重开原文档且不重复导入。测试中发现外壳就绪早于原编辑器懒加载工具的问题；现已等待画布、上传入口和对应模块注册完成后再读取形状，修复后重测通过。原 FingerprintSDK agent 的加载告警仍存在，未将其记为已修复。

构建期间本地 Redis 未启动，日志有连接拒绝与依赖弃用提示；上述构建结果不代表完整业务服务已启动。Docker daemon 未运行，因此仅完成 Compose 静态解析，尚未验证镜像构建、Linux 容器或公网 HTTPS。验证未调用真实 AI 生成或执行数据库迁移。

交付目录的 `SOURCE_MANIFEST.json` 记录 158 个来源文件，其中 156 个保持原 SHA，另两处适配有明确说明；`PACKAGE_MANIFEST.json` 记录最终交付文件校验值。浏览器测试记录与截图留在本地实验目录，不随公共分支提交。

CDS 分支注册、配置审批、线上 HTTPS 验收与正式发布是后续步骤；当前不把推送成功等同于部署成功。
