# NovartLab 独立前端体验版

本目录是当前“首页带图体验版”的独立运行副本，包含项目库、归档恢复、素材浏览、品牌规范与偏好、原画布编辑和保存。与仓库主应用分开，未修改 `apps/`。AI 生成、真实账号、团队权限和正式业务 API 尚未接入。

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

用普通 Chrome/Edge 打开输出的完整链接。`/healthz` 和不含数据的根路径入口说明无需认证，工作台及项目数据需要访问链接建立的 cookie。访问链接赋予同一演示空间读写权限，不是多用户权限系统，不应贴在公共页面。

## 容器与 CDS 配置选择

```sh
docker compose -f compose.preview.yml up --build -d
docker compose -f compose.preview.yml exec workbench-preview python print_review_link.py --origin https://实际预览域名
```

上面的 `compose.preview.yml` 用于具备 Docker 构建能力的独立环境。CDS 专用根配置已在本地准备为 Python 镜像、只读相对源码挂载、动态端口和独立数据/缓存卷，不加载公司正式业务服务或环境变量。但原部署文件要求提交前执行官方 `cdscli verify`；本机未找到该工具，故根配置草案暂未提交。**远端根配置仍启动公司原产品，不能直接用它验收本体验版。** 后续先取得官方校验工具并验证配置，再提交、导入并部署本预览分支；若平台要求配置审批，应按实际审批流程执行，不选择正式发布。

已准备的 `start_preview.py` 支持这种部署方式：Pillow 版本正确且可导入时直接启动网关；否则只安装锁定的二进制轮子，单次网络超时 15 秒、重试 1 次，总安装时限 120 秒，失败或超时会非零退出。未启动真实网关前不返回虚假的就绪响应。首次部署仍需在 CDS 实际检查依赖下载和 Linux 容器启动。

部署后用 `/healthz` 的 `packageSha256` 核对启动时的 `PACKAGE_MANIFEST.json` SHA-256。CDS 拉取新代码后还须确认服务进程已重启；单看页面上的“部署成功”不算版本验收。根路径提供无项目数据的入口说明，已有访问 cookie 时跳转工作台。

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

屏幕适配使用独立的 responsive 覆盖层，窗口缩放不重建画布或修改对象坐标。首页、项目库、素材库、品牌规范和偏好页随宽度排布；小笔记本及平板用可收起的聊天抽屉，窄屏移除旧的画布遮挡提示，工具栏可换行，弹窗和输入框限制在动态视口内。具体实测尺寸和边界见仓库 [交付说明](../../docs/novart-workbench-preview.md)。

本地根 CDS 配置草案和 `compose.preview.yml` 均通过 Docker Compose 静态解析，但官方 `cdscli verify` 未执行，不能以普通解析代替。启动器 8 项边界检查、空 venv 实际安装后网关启动 4 项检查、网关访问隔离 7 项检查通过。Windows 冷启动测得 13.45 秒；它不代表 Linux/CDS 冷启动耗时，也不代表公网 HTTPS 已验收。
