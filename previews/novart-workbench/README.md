# NovartLab 独立前端体验版

本目录是当前“首页带图体验版”的独立运行副本，包含项目库、归档恢复、素材浏览、品牌规范与偏好、原画布编辑和保存。与仓库主应用分开，未修改 `apps/` 或根 `cds-compose.yml`。AI 生成、真实账号、团队权限和正式业务 API 尚未接入。

首页可添加最多 4 张 PNG/JPEG/WebP 图片，单张不超过 10 MiB。图片和原始需求随项目保留，进入画布后通过原上传入口加入；重复创建恢复同一项目，已确认导入的图片不会因刷新重复加入。归档项目保留内容并停止编辑，恢复后可以继续。

## 本地运行

需要 Python 3.12。只安装运行依赖，不需要 Playwright、浏览器代理、原站账号或公司密钥：

```sh
cd previews/novart-workbench
python -m pip install -r requirements.txt
python harness/share_runtime.py --port 8769 --room preview
```

服务启动后，在另一个终端获取完整访问链接：

```sh
python print_review_link.py --origin http://127.0.0.1:8769
```

用普通 Chrome/Edge 打开输出的完整链接。`/healthz` 无需认证，域名根路径及项目数据需要访问链接建立的 cookie。访问链接赋予同一演示空间读写权限，不是多用户权限系统，不应贴在公共页面。

## 容器与 CDS 配置选择

```sh
docker compose -f compose.preview.yml up --build -d
docker compose -f compose.preview.yml exec workbench-preview python print_review_link.py --origin https://实际预览域名
```

`compose.preview.yml` 是本目录的独立评审服务配置，包含 CDS 根路径路由标签，尚未导入 CDS，也不会改变仓库现有产品部署。需要在 CDS 选择或导入这个服务，配置独立域名根路径和持久卷后才能使用公网链接。导入时必须以本目录解析 `build.context: .`；平台是否允许该构建配置尚未实测。若平台只读取仓库根 `cds-compose.yml`，需另行配置独立服务，不能把当前主业务 Compose 当成本体验版。当前任务仅提交新分支，不表示已完成 CDS 部署。

服务监听容器 `8769`；本机 Compose 默认只绑定 `127.0.0.1:8769`。网关应反向代理到该服务，保留 Host 并设置 `X-Forwarded-Proto: https`。请求体上限至少 24 MiB，读取超时建议 60 秒。不要把接口统一重写到静态 HTML。

必须使用独立域名根路径，当前不支持 `/preview` 等子路径；Service Worker 需要有效 HTTPS（localhost 例外）。只运行一个实例，不使用无持久卷的临时文件系统。本服务是 Python 动态服务，不能仅作为静态站上传。

## 数据、来源与验证边界

- 初始数据为空，不包含开发者项目、测试图片、账号、密钥或本机浏览器资料。
- 项目、图片、附件任务和归档状态保存于 `sharing/preview/demo-data/`；访问能力保存在 `sharing/preview/access-key.txt`。整个 `sharing/` 都被 Git 与构建上下文排除。
- 备份时停止该实例并备份整个持久卷；禁止只复制 `projects/` 而遗漏图片、任务回执和其他记录。
- 包含捕获的原始浏览器构建及校验后派生响应；详情见 [第三方来源说明](THIRD_PARTY_NOTICES.md) 与 [来源校验清单](SOURCE_MANIFEST.json)。不能将它描述为原站全部功能一比一恢复，或已合入正式业务源码。
- 仓库只携带运行用的两个静态资源映射 `evidence/*.json`，不携带用户数据、截图和历史测试报告。
- 上线预览后还需核对 HTTPS/Service Worker、图片上传、保存重开、归档恢复，以及持久卷在容器重建后仍保留数据。本机浏览器检查不能代替 CDS 环境验收。

## 本次运行检查

普通 Chrome 使用全新浏览器资料与空数据目录，通过 12 项检查：无认证健康检查与页面访问隔离、Service Worker 启动、首页两图上传预览、原画布图片保存、原需求保留、中文文字编辑、归档只读、恢复、关闭浏览器和服务后换端口重开、避免重复导入，以及无新增未捕获浏览器错误。检查未使用 Playwright 请求拦截、代理或注入登录 cookie。

本次还修复了普通浏览器下的加载竞态：外壳 ready 早于原编辑器懒加载模块，首页图片交接现在等待原画布及上传入口出现，并确认目标模块已注册后再读取形状。原始第三方文件保持不变。

`docker compose -f compose.preview.yml config --quiet` 已通过静态配置校验；尚未声称 Linux 容器或真实 CDS HTTPS 环境验收通过。
