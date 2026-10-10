# Novart 运行版本、预览入口与发布隔离审计 · 2026-10-10

## 结论

北京时间约 14:10–14:18 的只读核查确认：**用户点击的公司右侧前端评审分支，仍打开旧的独立评审包；本地自研画布 `92d91f8` 尚未部署到这个入口。** 右侧卡片显示的公司分支提交、它所链接的评审服务提交，以及独立产品的提交，是三个不同版本，不能互相代替。

独立产品服务正在运行，但仍缺少真实生成和对象存储配置。本轮只查询配置存在性，没有读取到报告中、输出或复制配置值，没有调用外部模型，没有业务写入、部署、推送、配置修改或本机 Docker 操作。

## 1. 当前运行身份

本地候选分支：`claude/novart-product-integration`。

本地核查提交：`92d91f838c4e6fee0c04e31a5a74b49f8fb7181b`。提交标题含 `[skip cds]`。本报告新增后若再产生提交，发布前必须对最终提交重新预检。

| 项目 / 分支 | CDS 分支 ID | live 提交 | CDS 状态 |
| --- | --- | --- | --- |
| 公司 main，`a8a098f7193a` | `brandai-platform-main` | `e99919a64cd212d5d1b083fd7210842a1962d935` | running |
| 公司右侧前端评审 | `brandai-platform-claude-novart-workbench-preview` | `52e95a54148400a801e487e0216d76cc33139eb0` | running |
| 公司旧整合分支 | `brandai-platform-claude-novart-product-integration` | `f968f1a0e26722af4c57ba54271f4d6acf16ca00` | idle，三个服务 stopped |
| 独立评审，`cd9d15b4c592` | `novart-workbench-preview-claude-novart-workbench-preview` | `9e5e2afd69f8ab75650e35e5cd027ae66b581181` | running，`deployRuntime.prebuilt=true` |
| 独立产品，`98cfea6cdcbd` | `novart-product-integration-claude-novart-product-integration` | `847434758c7906565476a58e920000db39c78e8f` | running，`deployRuntime.prebuilt=true` |

以上是 CDS 状态回读，不等于真实图片上传、模型生成或画布交互验收。独立项目的 `deployRuntime.kind` 同时返回 `source`，故记录完整语义，不能只看这个单字段否定 `prebuilt=true`。对应 build profiles 明确 `prebuiltImage=true`，命令未含源码构建、`db:push` 或 `db:seed`。

配置镜像模板：评审为 `novart-workbench-preview:sha-${CDS_COMMIT_SHA}`；产品 Web/Worker 为 `novart-product-web:sha-${CDS_COMMIT_SHA}`，AI 为 `novart-product-ai:sha-${CDS_COMMIT_SHA}`，均属于公司仓库的 GHCR 路径。**本轮未读取容器引擎的实际 image digest；模板不能当成镜像 digest 取证。**

## 2. 右侧预览确实仍是旧包

`GET /api/branches?project=a8a098f7193a` 的右侧分支 `previewEntries` 指向：

- 域名：`novart-workbench-preview-claude-brandai-platform.geole.me`。
- 路径为受保护的 `/share/…` 入口；访问码未保存到本报告。

对该域名使用已有评审访问能力，只做 GET：

| 证据 | 结果 |
| --- | --- |
| `/healthz` | `status=ok`，`service=novart-workbench-preview` |
| `packageSha256` | `bcc37056c08d242f43f21bd394e4b6765945824004b5061306363cc418175f1a` |
| 上述包 SHA 与 Git `9e5e2af` 的 `PACKAGE_MANIFEST.json` | 字节 SHA 完全匹配 |
| 冻结 `lib-tldraw.e6518aa1.js` | HTTP 200；SHA `99079b08341259acf30d9d0e834f1dca74d8ce3b52c3e8e905f8b1ec7c040101` |
| 冻结 `1773.fe2335a6.js` | HTTP 200；SHA `2dc5773410b0759fa63a05fc97fbf6c9f6e11d9423af40090eb8aa354ba25750` |
| `/studio` | HTTP 200，仍加载评审服务的 share/home-start 脚本 |
| 新产品 `/studio-editor` | HTTP 503，未提供新的自研编辑器路由 |

这证明页面没有运行新自研版本。之前已确认旧 SDK 存在生产域名授权拒绝后停止绘制的问题；**本轮没有控制浏览器、没有重新测量“5 秒消失”，不能把本次 HTTP 读取写成一次新的完整交互复现。** 单独 GET `/canvas` 也返回旧服务兜底 503；旧包部分页面依靠 service worker 处理，不能仅凭这个直接 HTTP 结果再认定一个新的 CDS 故障。

## 3. 右侧按钮的精确配置范围

官方 UI 使用的接口为：

```text
GET /api/branches/brandai-platform-claude-novart-workbench-preview/web-entry-config
PUT /api/branches/brandai-platform-claude-novart-workbench-preview/web-entry-config
```

PUT 的结构为 `{scope:"branch", entries:[{serviceId,name,subdomain,path}]}`。**本轮没有执行 PUT。** 不应改用 `profile-overrides` 或项目共享 profile 来调整按钮。

live 配置：服务 `web`、`handlesRoot=true`；项目基线 `subdomain=""`、`name=""`、`path="/"`；分支覆盖名为 `NovartLab frontend review`，`subdomain=""`，路径为已有受保护评审入口。Worker、AI 没有入口覆盖。

官方已缓存页面 `BranchListPage-CKTFpzMd.js` 的 URL 预览函数和校验确认：

1. `path` 必须以 `/` 开头；接口 UI 没有任意目标 URL 字段。
2. `subdomain` 只允许最多 40 位小写字母、数字、连字符；它是非根服务的后缀，不是完整目标域名。
3. 对 `handlesRoot=true` 的 Web 服务，URL 始终由当前 `previewSlug`、公开根域和 `path` 组成，忽略 `subdomain`。
4. 非根服务使用当前分支 slug 加服务后缀，总 DNS 标签长度不超过 63。

因此，不能把独立产品的完整 slug 填进这个字段，就声称右侧按钮已换到产品环境。下一步应先部署并验证独立产品的官方入口，再决定使用已证实的独立产品链接、官方路由能力，或对旧评审服务增加明确的应用重定向。跨环境跳转方案尚未实施，不应借此覆盖公司共享 compose 或启动旧整合分支。

CDS API 当前返回的独立产品入口是：<https://novart-product-integration-claude-novart-product-integration.geole.me/login>。这是现有旧产品提交的入口，不是新版本交付链接。

## 4. 独立产品的实际配置缺口

目标为独立项目 `98cfea6cdcbd` 的既有 Web 容器，未访问公司业务库。通过官方 `container-exec` 运行 Prisma 只读事务，先 `SET TRANSACTION READ ONLY`，回读确认 `transaction_read_only=on`。数据库查询直接返回字段存在性布尔值，不返回设置内容。

| 检查 | 当前结果 |
| --- | --- |
| `AppSetting` singleton | 不存在 |
| image / VLM / layer 的 DB 密钥配置 | 无设置行 |
| 运行时 image / VLM / layer key | 均不存在 |
| 运行时 image 显式服务地址 | 不存在 |
| `S3_ENDPOINT/REGION/BUCKET/ACCESS_KEY/SECRET_KEY/PUBLIC_URL` | 均不存在 |
| 设置加密材料 | 存在；没有密文可验证解密 |
| 项目环境元数据 | 仅独立 PG/Redis、认证、内部 AI/Worker 连接相关键；无 provider/S3 键 |
| 独立基础设施 | PostgreSQL、Redis 均 running；未配置独立对象存储服务 |

公司项目中存在模型和存储配置的键名，不代表已授权或已经把这些配置接入独立产品。本轮没有读取公司设置值、复制密文或把共享存储直接接到隔离环境。

`missingRequiredEnvKeys=[]` 也不能代表业务依赖齐全：这些 provider/storage 字段并未被当前 CDS 导入配置声明成必填项。真实模型与存储未接通属于**环境配置缺口**，不能写成 CDS 部署平台故障，也不能把内部服务 running 写成真实生成已通过。

## 5. 精确 SHA 的安全推送预检

现成工具：`D:/coding/.novart-tmp/product-ai-release-check.py`。在集成仓库根目录运行：

```powershell
python D:/coding/.novart-tmp/product-ai-release-check.py before
# 最终候选通过仓库门禁、推送并接收实际 webhook 后：
python D:/coding/.novart-tmp/product-ai-release-check.py after
```

脚本从 Git 获取完整 HEAD、原提交消息和实际 changed paths，确认当前分支与 `[skip cds]` 后，使用官方 `/api/github/webhook/self-test` 分别模拟 push 和 workflow_run。该自检是明确的 dry-run，不触发部署。它保存公司三个分支的 SHA、CI 字段及状态，`after` 必须与同一完整 SHA 的 `before` 基线一致。

本轮对 `92d91f838c4e6fee0c04e31a5a74b49f8fb7181b` 实测：

- push：`ignored-skip-marker`。
- workflow_run：`workflow-acknowledged`。
- 两次 `dryRun=true`，`deployDispatch/stopDispatch/prComment` 全部为 false。
- 基线保存于本机 `.novart-tmp/product-ai-release-92d91f8-before.json`。
- **没有 push，因而没有本候选的真实 webhook 投递或 after 证据。**

历史实际投递中 `[skip cds]` 已被 CDS 接受，并回读确认公司分支元数据未变，详见 [10-09 开发日志](development-log-2026-10-09.md) 与 [Origin 联调日志](novart-integration-2026-10-09-origin-and-edit-review.md)。这些历史证据不能替代新候选实际推送后的核验。

公司项目当前仍为 `githubAutoDeploy=true`、`githubEventPolicy.push=true`。不得回到“关闭全项目 push 开关→推送→立即恢复”的旧隔离方法，也不得去掉跳过标记后假设旧整合分支仍会保持 idle。

## 6. 后续放行条件与本轮边界

### 首版最小外部配置与独立存储方案

源码核对位置为 `apps/web/src/lib/settings.ts`、`s3.ts`、`crypto.ts`，以及 `/api/admin/settings/ai` 和其 `/test` 接口：

| 项目 | 首版需要的内容 | 安全管理与验证 |
| --- | --- | --- |
| S3 兼容存储 | 明确 endpoint、region、独立 bucket、应用 accessKey/secretKey、forcePathStyle；与对象 key 一致的稳定 publicUrl 基址 | 在独立产品 `/admin/settings` 保存；`secretKey` 使用 AES-256-GCM 加密存入独立 `AppSetting`。验证真实 PUT→GET 字节一致→DELETE，然后上传/保存/重开/导出 |
| 图片生成 | 获得授权的 provider、实际 model、baseUrl 和 API key | 同一管理员设置接口加密保存 key；明确一次小规模付费调用额度，验收真 Worker、真 provider、持久化产物 |
| 设置加密材料 | Web/Worker 共用且跨部署稳定的独立 `SETTINGS_ENC_KEY`，当前也支持回退独立 `AUTH_SECRET` | 不重新生成已有加密材料，不复制公司密文；更新后回读只验证 key-set/可解密状态 |
| VLM / 分层 | 仅首版实际暴露并调用这些能力时需要 | 未配置能力保持明确不可用，不能用默认占位 provider 标绿 |

存储 `configured` 有意只认管理员显式写入的 DB 字段；**只往 CDS env 填 S3 字段并不能保证上传放行**。默认 endpoint、bucket 和默认凭据只是源码兜底，绝不可作为部署就绪依据。普通显示使用同源鉴权的 Asset `/raw`，不要求公开整个 bucket；生成、AI 引用和导出的其他读取路径仍须单独验收，不能凭一个链接可打开就断言全部兼容。

可以在 `98cfea6cdcbd` 的独立控制 compose 中新增仅该项目使用的 S3 兼容存储服务：CDS 的项目级 `pending-import` 和已有独立 PG/Redis 证明了这一配置边界。最小设计是独立服务、独立持久卷、独立 bucket、仅该 bucket 的应用权限，不给管理控制台配置公网入口。**本轮未创建服务，因此尚不能声称镜像维护性、持久卷隔离、运行资源、网络连通、备份恢复和桶权限已经验证。**

若采用此路线，应只编辑 `novart-cds-integration-deployment/cds-compose.yml` 的审阅副本，保留现有独立 PG/Redis 和预构建 profile；核对完整 diff 后提交 `/api/projects/98cfea6cdcbd/pending-import`，遵守平台人工审批。不要导入公司 `a8a098f7193a`，不要替换 main profile，也不要从公司现有存储复制根凭据。新增服务的管理凭据只进入受保护配置，应用使用限制到独立 bucket 的凭据。镜像必须先确认维护来源和固定版本，不直接沿用旧示例镜像或未经审核的 `latest`。

外部托管 S3 的独立 bucket 也能复用同一应用协议，且无需新增 CDS 服务；同样需要经授权的账户、桶权限及真实读写验证。以上是实现所需配置清单和项目边界，未执行配置创建，也未将配置缺失假装成代码已修好。

1. 完成自研首版余项和仓库规定的验证；最终 SHA 重新执行发布隔离预检。
2. 精确 SHA 推送后确认真实 webhook 跳过公司部署，云端 CI 通过并发布对应不可变镜像。
3. 只部署独立产品项目 `98cfea6cdcbd`，核对运行 SHA、prebuilt 状态和新的 `/studio-editor` 行为。
4. 落实经授权的独立对象存储与真实模型配置，再跑真实上传、保存重开、生成持久化及导出验收。
5. 新入口验证通过后，按上文确认的能力范围处理右侧按钮；新旧环境的项目数据和会话不能默认通用。

本轮没有新增已证实的 CDS 服务端故障。主要发现为**旧入口仍在运行旧包、独立产品依赖尚未配置、预览入口字段不能充当任意跨项目 URL 映射**。未修改 main、共享业务数据、远端配置、访问码或凭据。

本机脱敏证据：`.novart-tmp/owned-cds-runtime-audit.json`、`owned-cds-detail-audit.json`、`owned-cds-entry-audit.json`、`owned-cds-native-evidence.json`。这些文件只存运行元数据、哈希、配置存在性；访问码已抹除。

## 7. “源码里是否已有真实 AI 配置”的只读补充

本轮确认的是三件不同的事：**仓库有完整接入实现；公司部署元数据有配置键；独立产品尚无实际配置。** 前两项不能代替第三项，也不能证明模型账户余额、端点或模型权限可用。

| 代码位置 | 本轮核实的行为 |
| --- | --- |
| `apps/web/src/lib/settings.ts` 的 `getEffectiveAiSettings` | 读取并解密独立数据库 `AppSetting`，DB 优先、环境变量兜底；图片、VLM、分层配置分别处理 |
| `apps/web/src/lib/ai.ts` 的 provider headers 与 `requireRealImageProvider` | 将服务端设置传给内部 AI 服务；要求真实图片 provider 和 key，缺失时明确拒绝 |
| `apps/ai/app/providers/registry.py` | 按实际配置创建图片 provider；未配置真实 key 不能认作真实生成 |
| `apps/ai/app/providers/http_providers.py` 的 `HttpImageProvider` | 已实现图片生成与图片修改请求，包括 `/images/generations`、`/images/edits`；有参考图时使用对应图片请求路径 |

只读扫描限定在公司源码 `D:/coding/公司/brandai-platform`、当前集成源码 `D:/coding/公司/brandai-workbench-preview` 和已授权的独立部署控制目录 `D:/coding/公司/novart-cds-integration-deployment`，排除了依赖、Git、构建产物和虚拟环境。结果如下，**未输出任何配置值**：

| 文件/环境 | 字段存在性与范围 |
| --- | --- |
| 两份源码根目录 `.env.example` | 存在图片 provider 示例字段；`IMAGE_PROVIDER_API_KEY`、`IMAGE_PROVIDER_BASE_URL`、`IMAGE_MODEL`、`VLM_PROVIDER_API_KEY` 均为空 |
| 上述扫描范围的 `.env`、`.env.local`、`.env.production`、`.env.production.local` | 未找到实际文件，不能声称本机源码中已保存可复用的真实账号配置 |
| 两份源码根目录 `cds-compose.yml` | 图片 provider/key/base/model 与 VLM key 是环境变量引用，没有核实到字面配置值；变量引用不等于运行时配置已注入 |
| 当前独立产品 `deploy/novart/cds-compose.yml` 与部署控制 compose | 没有图片 provider 配置字段；不会因复用了公司代码就自动继承公司账户 |
| 公司 CDS 项目环境元数据 | 有 `IMAGE_PROVIDER`、`IMAGE_PROVIDER_API_KEY`、`IMAGE_PROVIDER_BASE_URL`、`IMAGE_MODEL` 键名；本轮没有读取值、调用模型或复制到独立项目，实际可用性未验收 |
| 独立产品运行时与 AppSetting | 仍采用第 4 节的只读实测结果：图片/VLM key 缺失、AppSetting 无设置行 |

源码中的默认模型/服务地址只是兼容逻辑，不能作为当前公司的有效参数。下一步应在经授权的独立环境安全完成配置，并通过一次明确受控的真实请求确认 provider、模型、任务、存储和回执；公司共享业务数据与密钥不在本轮复制范围内。

同时，`apps/web/scripts/verify-studio-ui.ts` 已增加草稿自动保存、真实离页后的恢复、素材用途与修改目标保存、全新认证会话恢复的真实 DB 检查。脚本仍要求 loopback 应用和 `novart_integration_test` 一次性数据库；用途检查只使用实际上传并持久化的图片，provider 调用继续由显式开关控制。**这里只记录验收脚本已补齐，未将尚未运行的 E2E 写成通过。** 真实整图修改和 EXACT 生成继续单列待验收，界面持久化通过也不会清除这两项。
