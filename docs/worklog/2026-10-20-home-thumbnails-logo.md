# 2026-10-20｜首页完整缩略图与实际产品中文 Logo

## 请求与范围

帅帅要求首页最近项目的缩略图完整显示，并在宣传展示中加入中文 Logo。本轮只修改本地实际产品，不提交、不推送、不部署、不改 main 数据库或共享业务数据。用户否定过的 `demo/promo-20261020/` 独立样稿未修改，也不将它作为宣传截图。

归因：I（半下载图片提前显示，造成只露顶部一条且与占位叠加）；R（卡片复用已有轻量图片预览）；N（画布桌面顶栏展示官方中英文完整 Logo）。

## 实测根因

对当前 devUpdate1012 实际首页进行只读浏览器检查：卡片图片区尺寸为 238 × 158.656 px、`object-fit: contain`，并没有高度塌陷。出现条带的图片 `complete=false`，但 `naturalWidth/naturalHeight` 已读到 1024×1024 或 1125×1486，说明原图还在下载，浏览器已开始绘制不完整的图片内容；占位图同时还在。

首页与项目库共用 `projectCard()` / `previewProject()`，原先都通过 `/workflow/image/<hash>` 跳转完整素材。之前项目库看起来正常不能证明它走了不同缩略图接口。

## 改动

- `apps/web/studio-shell/home-start-studio.js`：卡片先加载已有轻量预览；完整 load + decode 后才显示图片并移除占位。加载超过 20 秒显示明确提示并提供独立的“重试预览”按钮；失败同样可重试。重试按钮是打开项目按钮的同级元素，不产生嵌套按钮，点击不会进入项目或触发 AI。
- `apps/web/studio-shell/home-start-studio.css`：加载中不绘制半张图片；图片始终 contain + center，横竖图等比例完整显示。重试按钮沿用当前语义色变量。
- `apps/web/src/lib/studio-route.ts`：只有显式 `preview=1` 的工作流图片请求，在原有项目/素材归属校验成功后跳转现有 `raw?w=320` 入口。画布/下载原图请求保持原路径。客户端传任意 `w` 不会产生任意缩放参数。
- 已有后端预览是异步 worker：首次返回 202 时，图片元素只回退原图一次，后续访问可命中生成的轻量缓存；没有新增前端轮询，也没有模型调用。保留浏览器 lazy-loading。现有后端统一缓存最大宽 768 的预览，所以不宣称每份输出恰好宽 320。
- `apps/web/src/components/owned-canvas/OwnedEditorClient.tsx`：640px 及以上画布顶栏使用现有官方 `deepflare-logo.svg`，包含“曜影深蓝”和 DeepFlare；窄屏继续使用图标，避免挤掉编辑控件。首页左侧原本就已有完整中英文 Logo，没有重画或替换功能图标。

## 验证

- 实际 Studio HTML/CSS/bootstrap 的本地 Chrome 交互回归 8 项通过：部分响应不绘制半图、20 秒慢提示、失败重试不导航、预览 202 一次回退原图、1440/1024/768/390 宽横竖图 contain 完整显示且无页面横向溢出。
- 实际生产 React 编辑器 + 产品样式的本地 Chrome 回归 3 项通过：1440/768 宽使用官方中英文 Logo、390 宽使用图标，创作面板按钮仍可点击，无页面横向溢出。
- `pnpm test`：contracts 309、UI 39、Web 1783 通过（含新增受控预览路由与授权失败不跳转回归）。
- `pnpm test:ai`：647 通过，1 条既有 Starlette 弃用警告。默认工作区没有 Python venv；通过 `BRANDAI_TEST_PYTHON` 显式使用已存在的 `brandai-devUpdate1012/apps/ai/.venv/Scripts/python.exe` 后运行本工作区 AI 测试，没有安装依赖或改配置。
- `pnpm -F web typecheck`、`pnpm -F web build`、`node --check apps/web/studio-shell/home-start-studio.js`、`git diff --check` 均通过。构建有既有本地服务 ECONNREFUSED 日志，命令最终正常退出 0。

证据位于 `.novart-build/home-thumbnail-logo-1020/`：`report.json`、`editor-brand-report.json`、4 张首页与 3 张编辑器本地回归图、`full-test.log`、`test-ai.log`、`build.log`。

## 边界

这些本地回归图使用明确标注的合成 HTTP/图片几何数据，证明实际组件交互和布局，不是宣传截图或真实生成/保存验收。本轮真实 AI 调用为 0。线上缩略图 worker 的实际产物耗时、新代码上线后的浏览器表现，以及替换宣传包中的在线真实截图，仍需部署后验证。当前宣传包未被本地夹具图片覆盖。
