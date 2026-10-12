# Novart 开发日志 · 2026-10-12

## 新反馈：正常打开时资源初始化超时 · 修复中

用户确认正常打开新版 `/studio?workspaceId=…` 也会出现“资源初始化超时，请重新打开”。源码唯一对应 `novart-product-bootstrap.js` 等待 service worker controller 的12秒超时，尚不能断言用户浏览器一定使用强制刷新。独立真实浏览器6种正常冷/热场景通过；两种单列的Chrome受控绕过场景精确复现：registration已activated、ready已完成，当前页面controller为null且无controllerchange。原失败报告保留。

进一步核对源码和真实流量：`/canvas` 在成员和文档校验后已经302到自有 `/studio-editor`；新版首页→项目库→原自有画布97条HTTP请求全部同源，页面及画布ResourceTiming同源，当前链路无需外域资源映射。因此采用最小修复：`/studio`、`/studio/` 完全不检查、注册或等待service worker；仅显式旧 `/canvas` 的兼容分支保留原逻辑。没有加无限等待、跳过鉴权或改许可校验。

本地源码启动回归18项通过，覆盖worker缺失/拒绝/永不ready/未接管/旧worker时首页继续，以及旧画布/品牌创建门保持；许可检查、首页协议和外层归档检查通过。CI真实账号和数据库UI恢复流程增加 `serviceWorkers:block`，要求无controller仍打开首页、恢复原画布并保持原文档。此处源码回归是生命周期单测，不充当真实模型或真实持久化验收。

L1 989（缓存的同源965 contracts+24 UI）、AI365、类型检查及生产构建通过。导出124文件/76外域映射，编译后的bootstrap与当前源码一致。精确新提交的CI/镜像发布、独立产品发布和公网正常/热/禁用worker回归仍按实际后续结果登记，不提前算通过。公司 main、旧共享服务及数据卷保留，付费调用0。

“最近推送3天前”已核对：公司旧右卡52e的lastPushAt是10月8日13:41:30北京时间；其时间戳属于旧环境。GitHub实际已有d82/68两次新提交，CDS签名有效投递均被 `[skip cds]` 跳过公司原部署；独立旧入口d82在10月12日00:12完成，新产品68在10月11日23:12完成。不会伪造旧卡commit/date；后续应从真实独立产品卡查看其运行版本。

现场报告：`studio-sw-diagnostic-20261012-de5cfb6e-2405-44de-afc0-0cb570857ee1.json`、`studio-resource-origin-audit-20261012-29d88989-96a7-4a95-b05e-f59c973009f5.json`，存于本机 `.novart-tmp`；均无业务写/模型调用，原文档保持。

## CDS 右侧旧评审分支无法预览新版产品：已修复

用户打开公司项目右侧前端评审分支，点击“预览”时看到“请使用管理员提供的完整评审链接进入”。实际发布的 CDS 主列表代码只打开裸域名，丢弃配置的入口路径；详情页使用完整入口，两处实现不一致。不是用户操作问题，也不是新版产品服务未启动。

在 `claude/novart-workbench-preview` 的旧独立网关增加固定跳转，提交 `d82e7c2843f417fde73558ebc2df493b21d732f6`。启用 `NOVART_REVIEW_PRODUCT_ENTRY` 后 GET/HEAD `/`、`/product` 固定跳转到已验证的新产品 `/studio`；合法旧分享入口保留原能力码和 cookie 校验，再跳转。不会传递旧访问码、cookie、参数或旧项目编号。新版独立产品仍使用自己的账号及自有画布，不绕过旧引擎许可。

公司右側旧分支只修改分支级入口名称“Novart 最新产品”和 `/product` 路径，其他入口不变，正式接口返回无需重部署。公司 main、共享业务数据和三分支运行版本/最近部署记录保持。新产品整合分支仍运行已验证的 `68cb239732641b324c27058b69c22c12b9ab8ada`，本次不重启应用或图片存储。

通过正式 CDS `preview-url` 命令取得 [可操作预览入口](https://novart-workbench-preview-claude-brandai-platform.geole.me/product)。主列表即使丢弃 `/product`，裸根也能跳转。

## 验证和发布结果

| 检查 | 实际结果 |
| --- | --- |
| 旧预览源码门禁 | L1 254、AI pytest155、web typecheck、生产构建通过 |
| 网关回归 | 桥接9、来源18、诊断10、许可13及包哈希173项通过 |
| 实际镜像 | [CI38154006162](https://github.com/nickzhang2999-dev/brandai-platform/actions/runs/38154006162) 默认模式重建持久化、桥接模式及发布全部成功 |
| 推送隔离 | `[skip cds]` 正式 dry-run及实际签名回执 skipped，公司未触发部署 |
| 独立旧入口部署 | `dr_378f629c2beff24596ce41dc` complete/running，镜像为完整 d82e 提交 |
| 公网路由 | 两旧域12组固定跳转通过，新产品匿名 studio307→login200 |
| 数据保留 | `/app/sharing` 原命名卷保留，30文件及完整内容哈希一致 |
| 真实浏览器入口验收 | 5/5：跳转、实际登录、新首页、可见项目库打开既有项目、自有编辑器 |
| 工具栏稳定 | 连续10.310秒/106采样，无消失、隐藏或替换 |
| 原项目保护 | revision20及checksum未变，登录POST1/业务写0/模型0/页面错误0 |

验收使用单独 headless Chrome，通过代码启动，不控制用户浏览器、不使用 Computer Use，也未启动本机 Docker。未重新生成付费图片。已有真实单张1K模型证据及其他未验收边界仍按原记录保留。

私有本机回执位于 `D:\coding\.novart-tmp`：`novart-bridge-actual-push-receipt.json`、`novart-bridge-ci-d82e7c2.json`、`novart-bridge-deploy-result.json`、`novart-bridge-public-verification.json`、`novart-bridge-company-entry-result.json`、`novart-bridge-final-isolation.json`、`public-cds-product-entry-report-20261012-f33ced83-91af-4a39-9af6-eceead32081c.json`。

## 源码差异和交付边界

本次产品前后端和自有画布没有变化。改动来自旧评审分支的网关兼容和发布检查；不是把旧评审镜像当作新版产品，也没有把旧项目自动迁移到新数据库。新产品登录后显示该账号在新项目中的内容。

入口问题已完成；CDS 平台的通用路径丢失仍应由维护方统一主列表/详情页解析函数。日志、问题报告及整合进度已本地补记，不为仅文档改动再部署。
