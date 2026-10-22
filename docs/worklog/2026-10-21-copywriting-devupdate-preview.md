# 2026-10-21 devUpdate1012 文案功能部署验收

## 交付

- 远端分支：`devUpdate1012`。
- 代码/镜像/运行版本：`b7ec530efa576b8eb7fe7f4892f332b41d89f137`。
- Branch Image：[39575450866](https://github.com/nickzhang2999-dev/brandai-platform/actions/runs/39575450866)，success。
- CDS 部署：`dr_713c5698acb12176cd942a3e`。
- 实际预览入口：[https://devupdate1012-brandai-platform.geole.me/studio](https://devupdate1012-brandai-platform.geole.me/studio)，来源为 CDS 分支 API。
- 用户授权本次预览发布；main 和正式环境没有改动，没有数据库迁移。

## 配置

只为 devUpdate1012 的 Web 和 Worker 增加独立 COPYWRITING 服务端配置，保留其原有数据库、队列、登录和其他覆盖配置。运行容器已确认两者配置存在、模型为 qwen3.7-plus。密钥通过平台配置写入，未进入 Git 或文档。

## 真链路验收

使用既有授权评审账号，在所属品牌下通过真实 API 新建「文案功能验收 · 2026-10-21」项目，没有修改既有项目。

- 真实登录成功，文案配置查询 enabled=true。
- 真实页面点击顶部「文案」后提交一次请求。
- 真实 API → PostgreSQL 持久任务 → Redis Worker → 千问 → 结果落库成功。
- 返回 3 组标题正文，输入 194 token、输出 228 token，模型耗时 5631 ms。
- 点击加入画布，保存确认；刷新后原生文字恢复，双击可进入文字编辑。
- 文案记录从服务端恢复；最终只有 1 条文案任务，没有因刷新重复调用模型。
- 9 项真实验收断言通过，无浏览器 pageerror。

结果保留在上述测试项目。截图为实际云端产品与真实模型结果，证据位于 `.novart-build/copywriting-live-preview.png`；结构化结果与服务版本分别在 `copywriting-live-preview.json`、`copywriting-preview-runtime.json`。参考图片与真实改写模型质量本轮未增加付费验收。

## CDS 与网络记录

- 推送后 CDS 正确记录 b7ec530，等待 Branch Image 构建。
- 镜像构建成功后调用平台 prebuilt claim，再走原生 branch deploy，没有改成服务器源码编译。
- 首次触发没有拿到握手确认，复查分支仍是旧运行版本、旧部署记录后再次触发。
- 第二次已返回 HTTP 200 和部署编号，客户端读取 SSE 在 40 秒后超时；服务端继续完成。最终以部署记录、三服务镜像、容器运行 SHA 和真实 HTTPS 页面共同确认成功，没有把超时直接归为部署失败。
- Python 默认 User-Agent 的公网健康查询返回 403；浏览器及使用正常 User-Agent 的读取成功。没有绕过鉴权，也没有修改平台访问控制。

## 本地门禁

此前同一代码提交的 contracts/UI/Web 为 309/39/1812 项，AI 649 项，typecheck/build/发布合同通过；Lint 0 errors、15 warnings。文案交互夹具 9 项与原画布 55 项通过。本轮云端 Branch Image 全流程再次通过。

本日志为部署后本地证据，部署代码版本仍为 b7ec530，不用额外文档提交冒充新的已部署镜像。
