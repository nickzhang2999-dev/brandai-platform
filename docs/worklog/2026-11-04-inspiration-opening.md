# 2026-11-04 灵感库开放范围核查

用户目标：仅当前分层预览，开放公司共享灵感库，供同公司内已有品牌权限的登录成员跨品牌引用。匿名开放、main、正式站不在范围。

## 本地改动

- 灵感页保留工作台现有入口，页面副标题改为中性描述；根据接口 `sourceLibrary.kind` 明确显示公司共享或品牌私有范围。
- 私有库接收说明不再承诺案例进入公司共享库；没有读取到范围时只描述读取状态。
- 现有接收浏览器回归增加私有/共享切换及私有库不误报共享的断言。

归因 O：入口已存在，但页面文案无条件描述公司共享，用户无法分辨功能已开放与共享库尚未初始化。

## 入口和权限事实

- `apps/web/studio-shell/studio.html` 的 `studio-nav-inspiration` 常驻，`deploy/novart/studio/novart-product-bootstrap.js` 将当前 `workspaceId` 附到链接。
- 服务端 `INSPIRATION_ENABLED` 决定功能可用性；页面和 API 保留登录及品牌成员权限检查。
- `POST /api/admin/inspiration/libraries` 必须通过现有平台管理员检查，且请求库 ID 必须匹配 `INSPIRATION_SHARED_LIBRARY_ID`。
- 共享库永久身份绑定公司 owner；其他公司不能通过该配置访问。普通公司 owner 可以接收已初始化库，但不能代替平台管理员初始化。

## 本轮验证

- `node scripts/test-inspiration-receive-browser.cjs`：30/30；桌面及窄屏，私有/共享说明、请求去重、失败恢复、权限失效等。
- `node scripts/test-inspiration-library-browser.cjs`：16/16；品牌切换、来源库身份、私有收藏、只读成员及撤权等。
- `pnpm -F web typecheck`：通过。
- `git diff --check`：通过。

上述浏览器验证使用真实 Chromium、实际 React 组件和隔离合成 API，未验证线上共享入库，不产生模型调用。尚未运行本次完整发布门禁，也未提交、推送或部署本次修改。

## 当前管理员恢复核查

仅定向检查已有配置位置。体验配置最后修改仍为 10 月 12 日，整理账号文件仍为 11 月 2 日。使用已有体验配置正常密码登录分层预览：登录 HTTP 200、已认证会话成立；只读 `GET /api/admin/registration` 返回 403。没有打印、复制或新保存凭据。

实际认证 provider 仅 `password`。代码不存在忘记密码/邮件恢复路由，现有改密接口要求已登录，并在已有密码时验证原密码。本轮没有重置密码、调整管理员白名单或角色、伪造会话、直接 SQL 初始化。

下一步需现有管理员正常登录，或由用户指定已合法保存管理员凭据的本地位置。恢复后再完成共享配置、正常初始化、Omni 新范围发布、一次真实接收、双品牌同库同案例验证。仅当前文案修复不能证明公司共享已开放。

## 管理员正常初始化界面

新增后台导航“共享灵感库”和 `/admin/inspiration`，服务器独立执行 `requireAdmin` 后才查询共享配置、永久归属及品牌元数据。不返回用户邮箱、密码、发布 token 或签名密钥。

管理员明确选择一个公司品牌后，页面列出同一 owner 的品牌以供核对；切换品牌重置确认，未确认不能提交。初始化复用原 `POST /api/admin/inspiration/libraries`。缺配置、身份冲突或已经初始化时不提供创建按钮；网络结果不明时要求刷新后台状态，禁止自动重试。初始化不等同已接收案例。

创建契约增加向后兼容的可选 `workspaceId`，Zod/Pydantic 同步拒绝空值和显式 null。新界面必传该字段；事务使用参数化 `SELECT ownerId ... FOR SHARE` 锁定选定品牌，并核对 owner，防止旧页面误绑已经转移或删除的品牌。原管理员权限、活跃 owner 与永久身份约束继续保留。

新增验证：

- 管理员表单实际 Chromium：7/7（明确选择/重新确认、重复点击单次提交、缺配置、身份冲突、已初始化、403、结果丢失不重试），隔离合成 API，未调用线上初始化。
- 管理员页面权限与元数据最小化 3/3，初始化路由 6/6。
- Zod 库契约 5/5，Python 镜像 9/9。
- 初次路由参数化测试错误地展开空数组，修正测试表格参数后通过；不是产品接口错误。
- 并行开发期间一次全项目 typecheck 被其他组件的 `string.join` 类型错误阻挡；该协作者修正后，本轮再次执行 `pnpm -F web typecheck` 已通过。

以上 route 验证使用数据库 stub，没有将新增 `FOR SHARE` 声称为已完成真实 PostgreSQL 竞态验证。本轮没有新迁移，也没有线上写入。

## 两阶段配置，保留准备期间的私有库

发现直接设置 `INSPIRATION_SHARED_LIBRARY_ID` 而库未初始化时，现有安全逻辑会返回 503，阻挡原私有案例浏览。因此新增 `INSPIRATION_SHARED_SETUP_LIBRARY_ID` 仅用于后台待初始化候选：

1. 先通过正常部署配置 setup ID 和共享发布地址，保持 active ID 未设置；普通用户继续解析原品牌私有库。
2. 管理员在 `/admin/inspiration` 初始化 setup ID 对应库，页面明确显示“初始化后还需启用”。创建库本身不切换默认读取范围。
3. 完成正常初始化后，由部署管理员通过正常部署将 `INSPIRATION_SHARED_LIBRARY_ID` 设为该库，再推进发布/接收及双品牌验证。

`sharedLibrarySetupId()` 使用经过相同格式验证的 setup ID，缺省回退 active ID，兼容已有只配置 active ID 的环境。管理员初始化页及创建接口使用 setup helper；`resolveLibrary()` 继续只读 active ID。setup 和 active 可以指向不同候选，后台显示候选是否为当前共享库；非法 setup 阻止后台准备操作，但不影响既有用户库选择。非法 active、未初始化 active 及永久归属冲突继续按原规则拒绝。

新增配置/解析边界 11/11，加管理员页/接口共20/20；管理员 Chromium 表单7/7再次通过，确认初始化后仍提示需要启用。没有新增 wire 字段，所以此阶段不涉及额外 Python 契约变更。

## CI 与匿名后台入口收尾

现有 `novart-integration.yml` 原先没有灵感库 fixture 调用或数量断言。本轮将接收30项、管理员表单7项加入现有隔离 Chromium 步骤，使用固定报告路径并校验完整数量、passed、隔离标识、零模型调用、无外部/意外请求及错误。管理员 fixture 新增 `NOVART_INSPIRATION_ADMIN_REPORT` 支持，外部请求阻止和未知本地路径拒绝。

本地固定路径重跑 receive30/30、admin7/7，直接执行新增 workflow Python 报告断言通过；故意指定不存在的浏览器执行文件得到退出码1、`passed=false` 和错误报告，确认失败不被隐藏。CI分支检查3/3。此处是本地 workflow 断言验证，未声称 GitHub CI 已运行。

无凭据、无会话的普通 HTTP GET 实测：

- `/admin` → 307，`/login?callbackUrl=%2Fadmin`
- `/admin/inspiration` → 307，`/login?callbackUrl=%2Fadmin%2Finspiration`

用户可从分层预览 `/admin` 打开登录页，使用现有管理员正常登录。匿名跳转仅证明认证入口存在，不证明管理员会话成立，也不证明新初始化页已部署。没有触发初始化请求。

构建收尾修复：后台表单内部 `/studio` 链接改用 Next `Link`，保留 lint 规则。隔离浏览器 bundle 增加与其他 fixture 一致的 `process.env` 编译期定义，运行真实 Next Link（未替换为假组件），并断言实际渲染链接目标。管理员 Chromium7/7、相关20项测试和该文件 ESLint 均通过。
