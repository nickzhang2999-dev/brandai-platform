# 2026-10-16 P4 前端收拢开发日志

## 范围与分支

- 基线：本地 devUpdate1012@2cf3932；分支 fix/p4-frontend。
- 在现有产品上修复，不另建产品。该分支尚未包含 P1/P2/P3/P5 的独立修改。
- 仅本地，不推送、不部署、不合并 dev/main，不访问真实模型或共享业务数据。

## 已实现

- 无效 Tailwind 缩写统一改为 preset 中的语义色名，不新增兼容别名。
- 统一 DeepFlare 圆润侧栏；小屏图标导航、品牌菜单、成员入口均带品牌 scope。
- 创建/改名/删除失败可见；删除要求输入完整品牌名，失败保留输入与品牌。
- 首页、项目、生成图、推荐品牌读取失败与空列表区分，可明确重试。
- 登录页读取只公开 registrationOpen 布尔值的接口；关闭/读取失败均隐藏注册。真正注册授权仍在原 POST。
- 联系升级邮箱来自 NEXT_PUBLIC_UPGRADE_CONTACT，无配置或非法值隐藏按钮。清除未使用 mock 实体，live 常量迁到 brandai-nav。
- /studio 作为唯一首页；旧 /workspace 和 /workspaces/* 在 middleware 重定向到实际对应页面。没有 project 时进入项目选择页，不制造无效画布。
- /account 迁入 BrandAI 布局，formatElapsed 提到独立 lib。
- URL 的 workspaceId 经服务器成员校验；跨品牌链接不再被旧 Cookie 静默替换。Next 共享布局 query 切换期间隐藏旧品牌页面，重新取服务端上下文；慢请求提供重新打开。
- 旧生成图/版本没有原生画布文档，成功通知和版本编辑旧入口进入生成图库定位原图，避免伪装成空白原生画布。现有 Studio 上传/生成/分层通知保持原任务回执。

## 验证记录

最终全量 L1 contracts 1664 + UI 34 项通过；AI 500 项已通过（最终小改未涉及 Python）；Web typecheck 与生产 build 均 exit 0。日志为 `.novart-build/p4-{test,typecheck,build}-20261016.log`。

- Chromium：最终实际 React 页面与 BrandProvider 16 项通过，报告 `.novart-build/temporary/p4-frontend-browser-XOI3k8/report.json`，含 desktop/mobile 截图。
- 自研画布实际 Chromium：52 项通过，报告 `.novart-build/p4-owned-browser.json`。
- 浏览器均仅 loopback 合成 API，外部请求/浏览器错误/付费模型调用为0；这不是线上真实账户/生成质量验收。
- 实际生产 Next 服务 HTTP 路由 12 项通过，报告 `.novart-build/p4-routing-http.json`；仅 loopback，不连接真实数据库。

## 收尾发现与修复

- Campaign 两个品牌规则入口补齐 workspaceId，避免从当前品牌误入 Cookie 所指品牌。
- 历史生成图原先只在最近300条里找，旧通知/版本链接可能找不到。接口现在先按 generationId/versionId 精确筛选再取列表，并检查素材、来源生成任务、来源项目均属于当前品牌；不带定位参数保持原列表行为。
- 新增15项API回归，包括第301张合成图片可定位、跨品牌来源拒绝、空白/重复参数422。页面将两个ID送入请求；提供“查看全部生成图”清除定位，保留品牌。

## AI 分层当前状态

本轮核对源码：真实分层使用独立 fal / qwen-image-layered 适配器；自动层数另需视觉模型分析与图片存储。普通生图 API 成功不等同分层成功。本轮未读取真实运行配置或调用模型，不能标为真实 AI 分层已验收；已有本地测试只证明代码/交互行为，不证明线上模型配置和生成质量。

## 尚待发布阶段

计划 4.3 要求“部署预览确认没问题，再删页面和组件；删除单独提交”。用户后续明确只保留本地，所以旧首页、旧 workspace/OpenCanvas 及旧 workspaces 实现目前只停用路由，源码保留，未提前删除。部署后再进行删除提交。

旧画布数据不会自动伪装或转换成 native 文档；原生成图片仍可从生成图库查看并按现有素材流程加入画布。真实账号、数据和预览环境尚未验收。

## 集成提示

阶段分支独立于 dev 基线。之后本地集成 P3/P4 时，campaigns、generated、workspace、Owned 组件等可能重叠，必须保留 P3 有界轮询与任务身份保护；合入 P5 时将本轮新增 Web 测试也迁入 apps/web/tests，并重新跑门禁，不可凭单分支全绿声称集成全绿。
