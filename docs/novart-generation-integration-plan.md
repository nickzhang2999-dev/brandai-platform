# Novart 原生工作台生成链路接入方案

更新：2026-10-09。状态：**只读代码核对完成，生成运行代码尚未接入**。本次没有访问原站、调用图片供应商、读取密钥或修改公司线上数据。本文的“现有”指当前工作区源码；“拟新增”是待实现方案，不能作为验收通过记录。

## 1. 接入结论和最小成品边界

原生编辑器的聊天是带工具事件、会话历史和恢复协议的 WebSocket Agent；公司后端的图片生成是 HTTP 提交、Redis/BullMQ 执行、数据库任务状态轮询。两者不能通过解除发送按钮的禁用直接相通。

建议第一条闭环固定为：**原生输入框纯文字 → 202 持久化受理回执 → 真实单张图片生成 → 对象存储 + GenerationVersion + Asset + ProjectAsset → 同源鉴权图片 → 原生 c-image → 原有文档保存 → 新浏览器上下文重开**。页面关闭后任务继续，回来能查询和加入画布。这条验证完成后再接素材用途、修改图片及其他工具。

首个版本不假装恢复 Lovart Agent。保留原生输入框、按钮、画布及撤销机制；请求和任务结果由产品适配层负责。对外称“图片生成”，不能称“已恢复原站完整 AI 对话”。现有品牌规则、额度、真实生成 worker 可以复用，业务鉴权及幂等仍要补齐。

## 2. 捕获原版实际发送入口

以下均来自 `previews/novart-workbench/originals/static/js/` 本地未修改副本。压缩文件以模块 ID / 函数锚点定位，避免用单行文件的行号制造精确假象。

| 源文件与锚点 | 实际行为 |
| --- | --- |
| `async/lovart-canvas.358a3a91.js`，模块 `29220` | 渲染 `data-testid="agent-send-button"`；按钮使用传入的 onClick，运行时还可切为停止/语音入口。 |
| 同文件，模块 `84004`，导出 `Z` | 取当前线程 inputForm；校验空输入、额度、进行中状态，`onSubmit` 调 `40394.V(threadId,inputForm,options)`。输入表单不只是 text，还有 paramList。 |
| `1773.fe2335a6.js`，模块 `40394`，函数 `p` / 导出 `V` | 会检查环境/检测器、把 blob 图片解析为渲染图片 URL、记录引用，再调请求管理器的 `sendChatMessage`。不能把这里返回 true 当服务端已持久化受理。 |
| 同文件，模块 `89759`，`async sendChatMessage` | 维护 processingThreadMap、inputForm、sessionHandler、tool event、taskMap；创建 `19875.H7` / `19875.L0`，最终调用 `19875.JR.sendChatMessage`。 |
| 同文件，模块 `19875`，`AgentSocket.createSocket` / `sendChatMessage` / `formatMessageData` | 实际发送 WebSocket 编码帧，包含 topic、reqUuid、thread_id、project_id、messages 等。支持 start、ack、fetch、abort、恢复等事件。不是公司 `/generations` 的 JSON。 |
| `async/lovart-canvas.358a3a91.js`，模块 `90044` 的 `sendAgentChatMessage` | 另一个桥接入口通过 `63880.dHA/Y63/b_f` 取得管理器、线程和输入再调用同一发送逻辑。仅拦截某一个按钮无法覆盖所有入口。 |
| `1773.fe2335a6.js`，模块 `79136` | HTTP 拉取线程列表、历史、状态及分享历史；`agentAgentThreadList`、`81322.a0/Ee/t_` 等。这些是历史和恢复辅助，不是主发送协议。 |
| `283.c3fbcbc3.js`，模块 `35323` / 接口字典 | 原国际版 WebSocket 公共地址为 `wss://socket.lovart.ai/ws?bizType=16`；字典还含 `/api/canva/agent/chat`。字典存在不证明当前主发送走该 HTTP 路径。 |

`19875` 的 inputForm 转换实际处理 text/image/mask/video/audio/file/skill/kit/asset_library/subject/mark/ref_context_item/prompt_quote，并带 tool_config、presetSkill 等。当前公司图片接口不接受这些完整语义。另有建议词工具的 SSE 读取代码，不能因此称原生主聊天为 SSE。

原生图片生成菜单的 `sendGeneratorMessage` 又是另一条 generator topic 与占位图事件链。最小版本仅接主输入框的受限图片生成，不同时伪接所有 generator 工具。

## 3. 产品导出目前为何不会发送

| 文件 | 已存在的保护 |
| --- | --- |
| `deploy/novart/studio/novart-product-bootstrap.js` | `availability()` 禁用 agent-send-button、generate-menu-image、generate-menu-video、nav-font-gen-button，保留输入为草稿；MutationObserver 持续处理新节点；捕获 Enter 防止原入口误发。 |
| 同文件 | fetch 只允许映射到产品同源接口；外部请求转不可用；WebSocket wrapper 拒绝外部域。 |
| `scripts/export-novart-studio.py` | 仅在产品导出中给捕获模块 `createSocket()` 加 `window.__NOVART_PRODUCT__` 提前返回。原始捕获副本未改。 |
| `apps/web/src/lib/studio-route.ts` | 已开放 document/state/draft/workflow/material-upload 等。未知 studio/compare 写接口返回 503，没有生成适配端点。 |

下一步应新增明确的产品发送分支；继续禁止原站 WebSocket。不能把原站 token / 线程协议搬过来，也不能统一把未知 HTTP 请求改成成功。

## 4. 公司后端能复用什么，缺口在哪里

### 4.1 新建生成与任务状态

- `apps/web/src/app/api/workspaces/[wsId]/generations/route.ts`：POST 校验 `CreateGenerationInput`、EDITOR、项目/素材归属、品牌规则硬拦截、额度预留，创建 `Generation(PENDING)`，提交 generateQueue，返回 **202 `{generation, jobId}`**。AI 预检/生成在 worker；HTTP handler 不等待出图。
- 同文件 GET 返回项目 Generation 与 versions。`generations/[genId]/route.ts` 的 GET 返回 `{generation, job?}`，可查 BullMQ 状态/进度；job 已清理仍有数据库 Generation。已核对 `lib/workspace.ts:41–55`：`requireOwnedWorkspace` 虽保留旧名称，实际允许 owner 或存在 Membership 的成员，非成员返回 404。GET 为成员可读，POST 再要求 EDITOR；这是正常读写权限区分，不存在因该函数名推断的“编辑者提交后读不到结果”缺陷。
- 现有 POST 未见调用方 mutationId 或 DB→Redis outbox。丢失 202 后盲目重发会再次占额度/生成。需要产品请求幂等记录和可恢复投递，不能用“前端按钮防连点”替代。
- `[genId]` POST 是重新生成：额度逻辑、终态→PENDING 原子转换及根版本替换。它不是“确认丢失回执”的重试接口，不能自动调用来恢复网络。
- `lib/generations.ts` 有 DB 状态序列化、队列查询与 10 分钟 stale generation sweep；它不等于供应商调用取消，也不能替代产品请求恢复列表。

### 4.2 Worker 与 AI 服务

- `apps/web/src/lib/workers/generate.worker.ts`：解析品牌规则、真实素材、尺寸和用途 → `ai.generate` → 后处理 EXACT/水印 → 上传最终图片 → 保存 `GenerationVersion` → best-effort 镜像 Asset。已有五分钟超时竞赛和终态写入隔离，超时不会被迟到成功覆盖；底层请求并不因此被 abort。
- `apps/web/src/lib/ai.ts`：普通 POST JSON 调 `/v1/generate`、`/v1/edit`，没有流式响应；配置在服务端解析转发。通用 fetch 本身未配置 AbortSignal。不要把内部服务转发头或供应商配置交给浏览器。
- `apps/ai/app/main.py`：`/v1/generate` 解析 direct/branded_direct/branded 提示词、图片引用和 provider；`/v1/edit` 调 provider.edit。现有 provider 层有各自超时处理，edit worker 未见与 generate worker 等价的整体终态超时屏障，后续接修改图前需单独补核对/验收。
- 实际是“HTTP 异步提交 + 任务轮询 + 最终 JSON/图片”，没有可直接复用给原生 Agent 的逐 token SSE。UI 应显示真实阶段/进度；不能编造思考流、百分比或 Agent 工具事件。
- AI 服务允许 mock fallback。成品生成入口必须验证有效真实 provider 能力与存储配置，不可把 mock 图当真实生成。此文没有读取运行配置，不能据源码判断当前公司环境已配好。

### 4.3 修改图协议

`generations/[genId]/versions/[versionId]/edit/route.ts` POST 接 `{op,payload,watermarkOverlays?,assetUsages?}`，创建 `AsyncTask(EDIT)`，返回 **202 `{jobId,taskId,lineage}`**。worker 以现有 GenerationVersion 为源，保存新的子版本 `parentVersionId`，不覆盖原图。`loadOwnedVersion` 调用的同样是成员可读的 `requireOwnedWorkspace`，并校验 generation.workspaceId 和 version.generationId；POST 另要求 EDITOR，未发现这里存在 owner-only 读取差异。

上传图片的 Asset / 原生 c-image 不天然有 `GenerationVersion.id`。工作流 mode=modify 不能直接塞 shapeId 或 assetId 到 versionId 位置。最小生成版本应明确拒绝 modify；后续需建立合法的 Asset 编辑入口，或仅允许可追溯到本项目真实生成版本的目标。

`EditOp` 已定义 IMAGE_EDIT、REPLACE_BACKGROUND、MOVE_PRODUCT、EDIT_TEXT、RECOLOR、ADD_ELEMENT、REMOVE_ELEMENT、OUTPAINT、INPAINT、RESIZE。枚举存在不代表产品菜单已接通或 provider 支持；每个 op 的 payload、mask、尺寸、素材保真仍需逐项验证。当前 edit worker 会继承部分源参数，空 assetUsages 数组还会继承原用途，不能用空数组表示“清空引用”而不处理这项语义。

## 5. 工作流用途如何映射

事实源：`packages/contracts/src/studio-workflow.ts`、`resource-usage.ts`、`api.ts`；`apps/web/src/lib/studio-workflow.ts`、`studio-workflow-codec.ts`；generate worker 和 AI main.py。

工作流保存的是 `{revision,mode,target,references}`；每个 reference 为 `{shapeId,assetSha256,purpose,participates}`。SHA 只用于识别，不是授权。提交时必须以项目已保存文档、服务端资产及当前角色重新解析到 Asset.id；不能信任前端 meta 或客户端发来的 URL。

| 工作流选择 | 正确目标字段 | 服务端实际行为与接入条件 |
| --- | --- | --- |
| participates=false | 不进入 assetUsages | 可保留在界面；不应偷偷继续参与生成。 |
| participates=true，purpose=null | 拒绝 | 当前 contract 已拒绝；不要默认当参考图。 |
| EXACT | `{assetId,mode:'EXACT',order,exactTransform}` | 原图片确定性后置合成。worker 不把它作为供模型重画的 referenceImage。必须补明确的输出区域/布局变换。 |
| ADAPTIVE | `{assetId,mode:'ADAPTIVE',order}` | 真实图片输入；允许调和光照、视角、材质等，主体应保留。worker 以 `ASSET_USAGE:ADAPTIVE` 注释区分，AI 服务走真实参考图路径。 |
| REFERENCE | `{assetId,mode:'REFERENCE',order}` | 真实图片输入，只借鉴风格/色彩/构图，不要求主体出现。worker 用 `ASSET_USAGE:REFERENCE` 区分。 |

注意三种容易误接的字段：

1. **`referenceAssets.mode='STRICT'` 不等于 EXACT**：当前 POST 为兼容旧逻辑，会把它变成默认右下角宽 120、偏移 24、不透明度 .85 的 watermarkOverlay。新工作流必须走 assetUsages。
2. `imageInputs:[{kind:'ASSET'|'VERSION',id}]` 是公司聊天引用槽；它没有 EXACT/ADAPTIVE/REFERENCE 选择，不能代替用途字段。避免同一素材同时放两条输入导致重复或覆盖语义。
3. `ProjectAsset.kind='REFERENCE'` 是项目关联分类，不能直接当作生成用途。显式用途字段才决定行为。

`ExactAssetTransform` 包含 xRatio/yRatio、widthRatio、rotationDeg、flipX、crop(left/top/right/bottom)、zIndex。当前工作流记录只有形状标识和 digest，没有输出 frame/归一化布局；原生画布全局坐标不能直接当 xRatio。必须明确以哪个输出区域归一化，处理旋转、父容器、裁切和顺序。没有合法变换时明确拒绝 EXACT，不能悄悄套默认居中 .35 宽，也不能把“完全保留”降级成提示词建议。

工作流容许同 SHA 的不同 shape；公司 CreateGenerationInput 当前禁止重复 assetId 的 assetUsages。同一图片多位置 EXACT 要么扩展契约表示多个 placement，要么首版明确拒绝重复，不能静默去重损失布局。

## 6. 真实结果入库与回到画布

现有 `lib/asset-mirror.ts::mirrorGenerationVersionToAsset` 是 best-effort：只处理当前存储公开地址下的 HTTP(S) 成果，创建 `Asset(libraryKind=GENERATED,generationVersionId)`；失败会返回 false，不使已出图版本失败；没有创建 ProjectAsset。尺寸/大小有时是请求值/估计值，原生插入应以真实解码确认后的尺寸为准。

需要补一项可恢复的“成果归档/关联”过程：以 generationVersionId 幂等，校验/存储真实字节、算 SHA、建/取 Asset，再建本项目 ProjectAsset。不要因镜像失败再次付费生成；展示“图片已生成，正在归档/归档失败可重试”。Generation 的真实出图成功和可插入素材就绪是不同状态。

浏览器最终使用 `/api/workspaces/{wsId}/assets/{assetId}/raw`，正常同源身份鉴权。供应商读图片不能依赖用户浏览器 cookie；worker 需把服务端解析的可读对象/签名引用提供给 AI 服务，不能把浏览器 raw 路径直接发第三方。

当前 `editor-documents.ts` **已经**允许本 workspace 有效 Asset 的 raw URL，以及本项目 GenerationVersion 的 download/imageURL；可复用原生文档 revision/mutationId/checksum 保存，不另起一种自定义 JSON。

当前 `studio-workflow.ts` 的素材验证、列表和 image 代理只查成功 `StudioMaterialUpload`。生成 Asset 即使可以保存进文档，仍不会自动成为合法下一轮 workflow 素材。应统一到服务端项目成果/上传记录解析器，保留 workspace/project、ProjectAsset、失效状态与 digest 校验；不能以 URL basename 或前端写入的 SHA 放行。

原生插入可复用已核实的 `37750.pW.getEditor`、`29543.getDefaultImageShape`、`63470.g5`，创建真正 c-image 并走 editor 历史。建议标记 novartAssetId、novartGenerationId、novartVersionId 供定位；这些 meta 是提示，不是权限证据。只在提交时的页面仍打开且可编辑时自动插入；刷新恢复只提供“加入/定位”，防止用户删除图片后被自动放回。唯一结果 ID 防止重复插入。

## 7. 拟新增适配契约与文件拆分

这些路径/字段是方案，不是已上线接口。优先复用现有 generate worker，避免再写一套图片供应商客户端。

建议新增 `POST /studio/generation`：`{projectId,mutationId,prompt,sizeSelection,workflowRevision,documentRevision}`。首版固定 versionCount=1、textMode=direct；sceneType 从明确产品模式映射到现有枚举，纯文字海报可固定 SOCIAL_POSTER 并记录，不猜原生隐藏控件的含义。只有 202 回执后才清理已提交草稿；失联重试复用 mutationId。后续开启引用时由后端在同一项目快照下解析，版本冲突返回 409。

建议 `GET /studio/generation?projectId[&requestId]` 返回项目/用户可见请求，包含 requestId、generationId、jobId(可选)、status、progress(可空)、expiresAt、displayText、resultState、results、可恢复错误；每个结果含 versionId、assetId、assetSha256、真实 width/height、mimeType、同源 raw URL。请求状态和成果归档状态分别表示，不能上传失败却伪装生成失败。DB 记录是刷新/关闭后的事实源，Redis job 不能作为唯一历史。

| 文件/服务 | 最小改动 |
| --- | --- |
| 新 `packages/contracts/src/studio-generation.ts` + index / tests | 请求、回执、错误和成果 schema；TS/Python 跨层字段按需要同步 `apps/ai/app/schemas.py`，不添加仅一端知道的 wire 字段。 |
| `packages/db/prisma/schema.prisma` + 新加性 migration | 产品生成请求幂等表/字段：ws/user/project/mutationId、payloadHash、Generation 链接、持久状态、时间/截止时间、投递/成果归档状态。统一 digest 存放位置须同时覆盖上传与生成。 |
| 新 `apps/web/src/lib/studio-generation.ts` + `studio-route.ts` | 同源/session/角色/归档/品牌与项目上下文；幂等受理；项目任务查询；公开能力限制。不要复制整个原有 POST 而遗漏额度/规则。 |
| `generations/route.ts` 的服务抽取；`generations/[genId]/route.ts` | 复用校验、额度、Generation 创建与排队；补 DB→Redis 可恢复投递；保留现有成员可读/EDITOR 可写及实体归属检查；lost-202 不重新收费。 |
| `lib/workers/generate.worker.ts`、`workers/index.ts`、queue helper | 消费持久请求并保持状态可恢复；请求上下文/品牌版本快照；终态隔离；成果归档可独立恢复。生产调用是否有供应商幂等需核对，不能承诺 exactly-once 扣费。 |
| `lib/asset-mirror.ts` 或新成果归档 service | 真实存储/解码/digest、Asset + ProjectAsset；镜像恢复不重新生成。已生成图可读性错误明确展示。 |
| `lib/studio-workflow.ts` / `studio-workflow-codec.ts` | 统一已授权上传/生成成果解析；下一轮参与用途不再仅认上传表；已有缺失/替换/冲突行为保留。 |
| 新 `deploy/novart/studio/novart-product-generation.js` | 读取原生 inputForm，受限映射并明确拒绝未支持参数；真实任务状态、失败说明/安全重试、成果插入、关闭恢复。保持原生设计和输入编辑。 |
| `novart-product-bootstrap.js` + `scripts/export-novart-studio.py` | 加载产品 generation overlay；只给支持模式解锁发送；在原生公共发送边界设产品分支覆盖点击/快捷键；继续阻断原站 socket，捕获文件保持不变。 |
| `apps/web/scripts/verify-studio-ui.ts`、后端验收脚本、CI | native 真实输入→202→结果图→撤销重做→保存→fresh context；权限/品牌/项目/刷新/超时/断网/重复受理。真实 provider 验收需显式启用，未配置必须 SKIP/阻断，不能用测试 PNG 冒充出图通过。 |

最短执行顺序：先受理幂等 + worker 复用，再成果归档 + 真实原生插入，随后关闭恢复与鉴权验收，最后逐项放开用途和修改图。EXACT 变换等尚未完成时，提交含参与素材的任务应明确不可用；不能忽略素材继续生成。

## 8. 必须明确拒绝或保留禁用的能力

- 视频、音频、语音、网页搜索、Skills、计划式多工具 Agent、PDF/file、批量生成菜单、未映射的模型/质量控件。
- mask/局部重绘、视频标记、组合复杂引用、任意上传图片直接 edit、EXACT 无输出布局、同 asset 多位置布局尚未实现的请求。
- 把原生“停止”解释为已取消供应商调用；未有真实取消协议时只能停止界面等待，并继续提供任务查询。取消与退款需有服务器确定结论。
- provider 或存储未配置、mock fallback、权限不足、已归档项目、workflow/document 版本冲突、品牌上下文变化、参与图片失效、未验证的第三方地址。
- 自动降级尺寸、丢弃不支持的引用或把失败统一返回成功。输入及用户选择应保留，错误说明可执行。

## 9. 验收与本次状态

第一条生成闭环验收必须包含：新任务真实受理；丢 202 幂等查询；关页后继续；明确 worker/provider 结果；真实字节存储和 HTTP 解码；Asset/ProjectAsset/Version 可追溯；c-image 撤销重做；document 保存；新 context 重开；同项目无重复插图；其他账号/workspace/project/只读/归档隔离。失败恢复不得重新生成成功图片，禁止把假进度当真实进度。

本次仅完成代码证据梳理。尚未运行任何真实 AI、DB/S3 生成链路或 CDS 部署验收。上传前端的另一个独立修复：读取任务遇到瞬时网络/5xx 故障采用有限退避，连续四次自动重试后停止并保留手动刷新；已知服务端 TTL 到期后不继续轮询，界面显示超时/读取暂停而非永久“处理中”。这项修复不等于生成已接通。

2026-10-09 补充验证：最新产品导出的 materials overlay 与源码 SHA-256 一致（`a6601a92d0bfaeb76625726923c5746125751bd71cf267b1a67ba125cf4a5925`）。隔离 headless 浏览器实点原生上传菜单，完成正常上传、单次任务列表 HTTP 503 后自动恢复（未手动刷新或重新提交）、关页后恢复已受理图片、撤销重做、查询并解码已保存文档、新 context 恢复及无重复插图；pageErrors=0，外部请求泄漏=0。业务服务使用本地 fixture，图片为测试 PNG，因此这只证明原生 UI/适配与故障恢复行为，不代表真实 DB、worker、S3 或 AI 已验收。临时诊断最初只等待旧的“已保存”标签导致过早离页，已改成解码实际服务端文档后再继续；正式 `verify-studio-ui.ts` 已有数据库文档断言。
