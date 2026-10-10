# Novart 与公司源码的阶段差异 · 2026-10-09

## 2026-10-10 增量：公司自研编辑器

真实 CI fedbfa3 暴露裸 /workflow 匿名返回307的原边缘门禁缺口，现使接口边界返回JSON401并维持页面登录回调；13项实际Next回归通过。权限拒绝页面增加准确的验收定位，权限本身及404保持不变。独立存储审批已通过但CDS未承接expose-only声明，暂未部署或复制公司存储；模型仅获准图片四字段/单张小规模验收，尚未调用。

后续真实栈证明上传修复生效，`42a0e90` 实际 UI 15 项通过；API 旧通知测试遗漏 taskId 的断言已更新为完整精确链接。配置复用前，管理员写入审计改为 account ID + 字段 set/cleared，不再输出新旧服务地址、模型值、邮箱、桶/访问 key 或系统提示词；配置仍使用原 AES-GCM、原管理员权限与 updatedById，未改公司 main 的运行代码。五项隐私/加密/失败回归通过；真实模型配置存在性、复制授权与调用成功分别记录。

上传云端增量：`6f271da` 的真实上传验收超时后，修复四个新业务 producer 的启动恢复，Redis ready 前不构造 BullMQ Queue，初始化／命令失败后更换自有连接与队列，投递总限时 1.5 秒。保留公司队列名称、jobId、重试次数和单次 provider 认领，不改公司既有旧业务队列。新增失败时一次性 DB／Redis／Worker 脱敏诊断和报告收集，本机 L1 931、AI365、类型／构建及36项 fixture 通过；本次事故唯一根因、真实上传恢复和上线仍待新 CI，不将可复现机制代替现场证据。

下午业务接线增量：自研客户端已经提供三类素材用途／参与、EXACT 输出画框与整图修改目标，复用原 `/workflow`、生成任务、归档与检查后端；草稿与通知转接到自研入口。归档比较改为后端真实的字符串版本。生成成功 POST 若回执身份、mutation 或素材不一致，仍按未确认处理，保留原请求，不将它误判成明确拒绝后重复付费。支持整幅 PNG/SVG/JSON；局部蒙版、分层、复杂旧对象以及按对象／嵌套框导出仍单列未接，不以接口存在代替功能验收。

这些是本地实现与交互回归，不是线上已完成。真实数据库／存储脚本新增草稿和用途的全新会话断言，只有云端实际运行通过才记录完成；真实修改与 EXACT provider 调用尚未验收。在线右侧旧评审仍为 9e5e2af，独立产品仍为 8474347，详见 [当日运行审计](novart-runtime-audit-2026-10-10.md)。

产品入口已从捕获的模板编辑器切为独立 React 自研画布，保留已评审外层工作台。借鉴公司 `OpenCanvas` 指针、焦点和上传交互，补笔迹、旋转、历史、PNG/SVG 导出；未修改公司原 `OpenCanvas`。继续复用 Auth.js、成员/品牌/项目权限、`EditorDocument`、素材、生成、队列及对象存储服务。

存储保持原生兼容封装，`tldrawSnapshot` 是纯数据字段，新入口不加载 SDK。公司原 `ProjectCanvas` 不迁移、不覆盖。新图片使用已有后端认识的 `c-image`、Asset ID/SHA 与鉴权素材 URL；自研文字/图形/笔迹使用明确版本记录，保留源文档未知内容。旧层级、裁切、隐藏/锁定与压缩笔迹目前只读；不宣称与原编辑器功能或行为一比一。

已通过本机 23 项实际 Chromium 交互，覆盖保存恢复、导出与首页图片交接，但 API 为隔离合成服务。真实 DB/S3/provider 验收尚未执行。公司后端已有 EXACT 合成与改图实现，新画布第一批尚未提供这些交互；原目标和用途保留，相关任务明确阻断，不能记作已恢复。后文表格是较早原生方案的阶段记录，最新入口以上述增量为准。

比较基线为公司 `main/e99919a64cd212d5d1b083fd7210842a1962d935`，对象为本地 `claude/novart-product-integration`（含本轮基于 `57bd341` 的整图修改增量）。这是源码和验收层级对照，**不是公司旧版与新版全部功能的一比一验收报告**。不以文件数量或测试数量推算完成百分比。

## 核心关系

本日云端联调增量：产品整合分支修正 Next middleware 的 multipart 缓冲预算，匹配 10 MiB 文件加 64 KiB 请求开销；实际文件上限不增加。新产品上传/生成两处事务锁使用同一 helper 显式转换 SQL 返回类型，保持原锁键及事务生命周期，不修改公司旧生成调用。新增实际 Next 请求克隆回归及一次性 Prisma/PG 锁预检。首轮 CI 已确认密码登录、品牌创建、原生图形/中文/笔画入库，真实图片上传重跑与 provider 验收仍未完成；公司 main 和共享数据未改。

新版不是另起一套无关后端。它复用公司身份、品牌/项目、权限、额度、队列、模型适配和素材实体，在这些服务之上新增原生画布兼容入口、完整文档持久化和可恢复任务记录。已评审前端及原生编辑器通过产品适配层接入；原捕获资源保持未修改副本，构建时生成受校验的派生文件。

| 范围 | 公司源码 | 本地整合版 | 验收边界与差异 |
| --- | --- | --- | --- |
| 页面与编辑器 | 原 Next 页面及原工作台 | `/studio`、`/canvas` 使用已评审壳与原生编辑器，构建导出资源清单；原公司页面保留 | 隔离原生交互有覆盖；最新版本的真实数据库/浏览器全链路尚未验收 |
| 身份与品牌 | Auth.js、User、Membership、BrandWorkspace | 继续复用；增加工作台会话、Origin/身份校验与用户/品牌隔离缓存 | 不把前端预览访问能力当产品身份；独立环境历史真实登录通过，不代表最新 UI 已通过 |
| 项目 | Project 与项目归属、名称、归档 | 原生 query/save/list/rename 映射到公司服务；新增幂等创建、版本化工作台状态 | 不用自动保存回显的旧标题覆盖独立重命名；归档/只读拒绝写入 |
| 画布文档 | 原 `ProjectCanvas` 格式 | 新增 `EditorDocument`，保存完整 `SHAKKERDATA://` 原生文档，revision 与 mutation 控制并发和重试 | 两套格式不假定互通；不自动迁移公司旧画布，不把复杂图形压成简化 items |
| 图片上传与素材 | Asset、ProjectAsset、S3 封装 | 新增上传持久任务和真实字节/格式校验，成功后才返回鉴权 `/raw` 地址供原生图片使用 | 本地交互和服务回归通过；真实独立 S3 上传、重登重开仍待验收 |
| 素材用途 | 新 `assetUsages` 与旧 `referenceAssets` 并存 | 接显式 EXACT/ADAPTIVE/REFERENCE；用途与改图目标按项目保存独立 revision | 旧 STRICT 是兼容水印语义，不能直接当作 EXACT 主体布局 |
| 生图 | generation-prepare、额度、BullMQ、Generate Worker、HTTP provider | 继续复用，新增请求幂等、持久 outbox、一次 provider claim、实际调用前上下文复核 | 所有模型调用默认不伪造成功；真实供应商闭环未执行 |
| 成果归档 | GenerationVersion 与素材镜像 | provider 输出先私有保存，完成合成与存储后再一起发布 version/asset/project link；归档可独立重试 | 重试归档不再付费生图；暂存窗口有界，上游 URL 本身不等于已保存原字节 |
| EXACT | 公司合成器支持明确资源变换 | 从已保存原生 frame/图片解析几何、SHA、顺序，模型生成底图后服务端复贴原素材 | 两个原生 PNG 样本有像素证据；原生越界导出扩框，产品按指定输出框裁边；任意变换不宣称完全一致 |
| 整图修改 | 旧 edit 在同一 Generation 下追加 parentVersionId | 新内部 `/v1/studio/edit`，复用 HTTP 图片编辑实现和完整品牌约束；沿用产品任务/额度/归档，结果是独立新图 | 用合法 source provenance 记录来源，不写跨 Generation 的虚假 parentVersionId；只接完整原文件，实际裁切/滤镜/旋转等未接状态明确拒绝 |
| 干净底图 | 旧流程与新产品归档生命周期不同 | EXACT 或水印合成前保存 AES-GCM 底图；整图修改优先读取授权底图，继承 EXACT 后复贴、应用当前品牌规则 | 无底图的已合成历史图片拒绝改图；轮换没有 keyring，需受控迁移；真实 S3 解密读回待验收 |
| 品牌限制 | 已确认品牌规则、禁止项编译器、旧 FREE 策略 | 产品路径完整保留编译后的正反例、负面提示和替代建议；旧调用默认策略保留 | 不把未确认品牌草稿当正式规则；EXACT 最终扁平目标也不得通过附加参考重新进入模型 |
| 品牌检查与任务通知 | 公司合规与通知基础 | 新增有实际模型执行证明的检查任务、重试和跨页收件箱；归档后才显示素材可用 | 缺 VLM 配置显示不可用；本地 HTTP 模拟和交互不算真实 VLM 验收 |
| 保存、重开、导出 | 原工作台独立链路 | 保留原生选择、撤销、完整文档、单图下载和画框 PNG 导出 | 隔离测试覆盖真实原生下载与重开像素；真实独立存储/数据库全链路、其他导出格式尚待验收 |
| 局部蒙版、分层、Agent | 公司旧 edit/decompose 与捕获前端厂商 Agent 是不同协议 | 原生画笔保留；产品未接的模型蒙版、分层或厂商 Agent 明确不可用，旧入口对产品任务返回 409 | 不算功能已恢复，不用静态按钮或替代图冒充真实结果 |
| 发布 | 公司 CDS 项目可监听同仓分支并使用共享基础设施 | 独立 compose、独立 PG/Redis/队列与精确提交镜像；CI 配有一次性库和存储验收 | 同仓 webhook 分支隔离仍待证明；最新改动未推送/部署，不影响 main 或再写共享库 |

## 本轮验证与上线缺口

- 整图修改新增本地测试收口后，L1 **786**（780 契约/服务 + 6 UI）、AI/Python **365** 通过，Web 类型检查通过。
- 原生 modify 选择/保存、422 留稿、丢失回包幂等确认、后续目标/新稿保留、手动入图、撤销/重做和全新浏览器重开通过；数据服务是隔离 HTTP fixture，没有真实模型/S3/数据库验收。
- 生产构建此前受 Windows 内存提交上限阻断；本地新增可选低内存构建模式后，实际构建退出 0。正常构建配置保留，优化范围是开发构建资源，不代表前端运行时内存已验收。真实业务验收及安全发布隔离仍未完成。
- 上一次独立环境记录为 `8474347`，公司 main 为 `e99919a`；这两项来自本日较早的只读核查，本轮没有重新读取 CDS。
- 上线仍需：可靠分支发布隔离、完整构建/CI、真实授权 image/VLM 与独立存储配置、实际用户链路、备份恢复与回滚验收。用户要求不开目标模式，后续按普通任务推进。

## 对照代码入口

- 前端：[产品构建器](../scripts/export-novart-studio.py)、[身份与资源适配](../deploy/novart/studio/novart-product-bootstrap.js)、[上传适配](../deploy/novart/studio/novart-product-materials.js)、[生成/改图适配](../deploy/novart/studio/novart-product-generation.js)。
- 持久化：[原生项目](../apps/web/src/lib/native-projects.ts)、[完整文档](../apps/web/src/lib/editor-documents.ts)、[工作台状态](../apps/web/src/lib/studio-state.ts)、[上传任务](../apps/web/src/lib/studio-materials.ts)。
- 生成：[请求受理](../apps/web/src/lib/studio-generation.ts)、[用途与权威快照](../apps/web/src/lib/studio-generation-policy.ts)、[共享 Worker](../apps/web/src/lib/workers/generate.worker.ts)、[私有归档](../apps/web/src/lib/workers/studio-generation-artifacts.worker.ts)。
- 改图：[来源与保护](../apps/web/src/lib/studio-generation-edit.ts)、[内部请求契约](../packages/contracts/src/studio-edit.ts)、[图片编辑预检](../apps/ai/app/studio_edit.py)、[AI 入口](../apps/ai/app/main.py)。
- 发布与验收：[独立部署配置](../deploy/novart/cds-compose.yml)、[CI](../.github/workflows/novart-integration.yml)、[真实 UI 验收脚本](../apps/web/scripts/verify-studio-ui.ts)、[CDS 与配置缺口](cds-launch-readiness-2026-10-09.md)。
