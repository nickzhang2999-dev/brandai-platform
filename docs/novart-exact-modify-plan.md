# EXACT 与原生改图的接入状态 · 2026-10-09

第一批静态 EXACT 已在本地实现，并完成原生交互与两项原生 PNG 像素对照。**真实数据库、S3、provider 串联的 EXACT 成品验收仍待完成**；本地 fixture 与单元回归不替代这项验收。整图修改已本地接通，蒙版局部修改尚未开放；原捕获副本保持不变。

按用户要求普通任务执行，不启用目标模式；发布隔离和完整构建未通过，**当前未推送或部署**。本文记录功能状态与验收边界，不更新其他日志中的总门禁数量，也不表示本地修改已经上线。

## 当前实现与待验收项

| 部分 | 当前源码与本地实现 | 尚待完成或验收 |
| --- | --- | --- |
| 显式输出画框 | `deploy/novart/studio/novart-product-generation.js`：仅活跃 EXACT 显示紧凑选框；默认空选，使用当前原生页面的 frame；提交只增加 `outputFrameId`，保存 revision 一并冻结 | 已通过隔离原生 UI 交互；真实 DB/S3/provider 下完整提交待验收 |
| 权威素材与几何快照 | `studio-generation-policy.ts`、`studio-exact-geometry.ts`：从已保存文档、workflow revision 和入库素材解析原生层级、坐标、旋转、翻转、排序、SHA；同 mutation 不接受不同 payload | 权限变更、来源失效与发布前检查已有本地覆盖；真实持久化和并发任务环境仍需验收 |
| 确定性素材合成 | `studio-exact-image.ts`、`studio-generation-exact.ts`：预检授权素材字节与尺寸；EXACT 不进入模型参考图；模型生成底图后按冻结布局复贴，固定输出画框范围 | 两项原生 PNG 对照已通过；真实模型底图、对象存储归档、结果发布全过程待验收 |
| 干净底图与复贴记录 | `studio-generation-base.ts`、`workers/studio-generation-artifacts.worker.ts`：保留 AES-256-GCM 加密 clean base、底图 SHA、尺寸、keyRevision，以及 EXACT 配方；发布前复核来源和权限 | 真实对象存储读回验收待做；历史密钥轮换需受控迁移，当前没有 keyring；整图修改已消费底图，真实模型与 S3 链路尚未验收 |
| 整图修改 | `studio-generation-edit.ts` 与 `/v1/studio/edit` 接授权原图/底图，复用公司 multipart 图片 provider 和任务、额度、归档；原图保留，结果另存 | 单测及原生交互通过；真实模型/S3/DB 未验收；实际裁切、滤镜等效果未接 |
| 蒙版与分层修改 | 已定位捕获模块 `89719`（remover）、`37733`（contours/store）；旧 decompose 对新工作台 generation 返回 409 | 产品蒙版合同、坐标映射与提交边界尚未接通；保留原生画笔不等于已支持模型局部改图 |

`assetUsages.EXACT` 与旧 `referenceAssets.STRICT` 含义不同：后者兼容成默认水印，不能代替主体布局。EXACT 源图从模型参考中排除，模型先生成底图，再由服务端复贴原素材；同一源图若又通过品牌示例或其他参考途径进入模型，也须明确拒绝，不能悄悄重绘或省略品牌设置。

## 第一批：静态 EXACT 已本地实现

1. 用户明确选定输出 frame。前端按账号、品牌、项目与原生页面隔离会话偏好，随画框新增、删除、改名和换页更新；不自动选择、不传客户端计算的坐标或任意素材 URL。新请求等待画布及用途保存完成，服务端核对 `workflowRevision`、`documentRevision`，再冻结来源与布局。
2. 原生 `c-image` 的 `x/y/rotation/parentId/index` 与 `props.w/h` 由服务端解析。以 frame→页面矩阵 `F`、图片→页面矩阵 `I` 计算 `F⁻¹ × I`，结合原生父级与兄弟排序推导最终图层顺序；不用旋转后的轴对齐外框猜角度。普通 group、frame 的保存后变换可参与计算，自动布局同样以已保存坐标为权威，不另行模拟布局算法。
3. 原生图片 `flipX/flipY` 已转换：以同一图像中心为基准，垂直翻转通过增加 180° 旋转并切换 EXACT 的水平翻转表达，不再将 `flipY` 静默丢弃。当前支持等比静态图的明确变换；输出尺寸须与所选 frame 比例一致，允许正常的输出像素取整范围。
4. **所选画框定义成品输出范围，框外部分不出图。** 普通原生嵌套 frame 的 `getClipPath` 为空，不擅自把每一层 frame 都当裁切区域；只有显式输出矩形限制本次成品边界。完全不与输出区域相交的素材拒绝，部分越界按输出范围裁掉。
5. 付费前明确拒绝：真实图片裁切、非零调色或滤镜、非零圆角、隐藏或额外透明度、非等比拉伸、额外缩放/倾斜矩阵、额外蒙版或容器裁剪、父级容器翻转、错误页面、循环父级、失效或重复素材、无法表达的中心/尺寸及超出资源预算的变换。原生默认 `radius=0`、`opacity=1`、零调整，以及完整全图 `cropRegion={x:0,y:0,w:1,h:1}` 不作为实际效果误拒绝。
6. 原生 `cropRegion={x,y,w,h}` 与公司 `crop.left/top/right/bottom` 不等价，当前不转换实际裁切。合成器虽然具有遮裁能力，也不代表原生图片裁切已开放。对不支持的参数保留明确错误，不静默降级。
7. 接受时绑定素材 ID/SHA、实际解码尺寸、输出区域和布局配方；调用 provider 前预检，归档/发布前再次核对来源及权限。只把经授权、安全读取、字节和像素预算校验后的图片送入合成器，不继承旧实现的任意 URL fetch 路径。
8. provider 成功后，合成与入库仍是独立归档阶段；归档失败应重试归档，复用已有底图，不再次付费生成。原生 UI 的 422、删除画框、错页面等失败保留提示词、素材用途和选框；丢失 202 时以相同 mutation、frame ID 和 revision 确认原请求，用户在等待期间新写的输入不被清空。

透明主体需要**源文件本身具有正确 alpha**；JPEG 的背景不会自动抠除。EXACT 表示源素材不交给模型重绘，并不承诺任意旋转、缩放后所有像素逐点不变。任意角度和缩放会涉及重采样、边缘抗锯齿及取整，本批原生逐像素相等结论只覆盖下述明确场景。

### 原生像素证据与已知输出边界差异

真实原生流程使用两张通过原生上传菜单加入的 48×32 非对称颜色 PNG，复制实际上传图片的默认属性构成测试布局。普通 group 中的图片旋转 90°；另一张水平、垂直翻转并旋转 90°，两图叠放。使用原生右键 PNG 下载，保存 HTTP 确认一致的完整文档；关闭原 context 后重开，再次从原生菜单导出。没有替换几何计算或调用自制原生渲染器。

原生实测默认属性为：c-image 的 `w/h/url/originalUrl/radius:0/name`，以及顶层 `opacity:1/isLocked:false`；frame 的 `w/h/name/color:"white"/isAutoLayout:false`。原生允许该普通 group 保留单个图片子对象。测试没有为迁就服务端删掉默认字段。

`packages/contracts/tests/studio-exact-native.test.ts` 已将真实原生 store 和 PNG 固化为两项回归，本地执行均通过：

| 对照场景 | 原生行为 | 服务端对照结果与可作出的结论 |
| --- | --- | --- |
| 两图完全框内、128×128、整数位置、90° 旋转/翻转、叠放 | 首次与新 context 重开导出的全部 65,536 个 RGBA 字节一致 | 同一 store 经 `deriveStudioExactLayout` 和 `compositeStudioExactImage` 处理，与两份原生 PNG 全部 RGBA 相等 |
| 子图向左、向下各越出 12px | 128×128 frame 的原生 PNG 扩大为 140×140，包含越界子图 | 产品固定输出 128×128，与原生 140×140 中 `x=12,y=0,width=128,height=128` 的选框区域逐 RGBA 相等；**不宣称两张完整导出相同** |

仓库证据在 `packages/contracts/tests/fixtures/studio-exact-native/`，越界原件在其 `overflow/` 子目录。本机完整诊断产物位于 `D:/coding/.novart-tmp/studio-exact-native-comparison/`，包含原始图片、下载 PNG、原生 snapshot/store、保存文档及 `derive-input.json`；越界原件另存在 `overflow-native-evidence/`，未被框内样本覆盖。

这两项回归使用固定透明底图与本地图片字节，不调用模型，也不验证真实数据库或 S3。它们证明指定场景下原生保存数据、服务端几何和最终合成的像素关系，不能扩展为任意角度、任意缩放或所有原生工具都已一比一。

### clean base 保护与密钥轮换限制

`studio-generation-base.ts` 使用 AES-256-GCM 保存模型的未复贴底图，以 workspace/project/output 身份作为 AAD，记录 SHA、实际尺寸、MIME、字节数和 `keyRevision`。读取时核对归属、密钥版本、认证标签及解码后的内容摘要；原始底图不是仅靠不可猜 URL 隐藏。

对象路径包含内容 SHA 与 `keyRevision`，旧密钥 worker 的迟到对象写入与新密钥路径隔离；任务 attempt/权限屏障继续约束结果发布。密钥版本标识不是解密 keyring：当前仅使用当前配置派生的密钥，轮换后旧底图不能自动解密，会明确要求恢复对应配置或完成受控迁移。**当前没有历史 keyring，也没有自动重加密迁移流程**，部署前必须把历史底图迁移纳入轮换安排。

整图修改已读取授权 clean base，再按继承配方复贴 EXACT、应用当前品牌规则。水印合成前也保存底图；历史已合成图缺底图则拒绝。目标扁平图的 ID 或相同 SHA 副本不能再作为模型参考，防止锁定主体通过第二条输入路径进入模型。真实存储和模型验收仍待完成。

## 第二批：整图修改，已本地接通

以单个已授权 target 开始，接受源素材 ID/shape ID/SHA 和保存版本，结果生成新图，用户决定后续放置，不自动覆盖原图。普通改图不承诺主体像素不变，主体保护由 EXACT 路径承担。

公司旧 edit 在同一 `Generation` 下创建 `parentVersionId` 子版本，`getVersionLineage` 也按该 Generation 查询；产品请求则一请求对应唯一 Generation。需先确定合法来源关系，不能跨 Generation 随填 parentVersionId；上传素材没有源 version，同样必须记录实际来源。

产品已接专用内部整图编辑，要求真实 gpt-image-2 编辑能力、单次调用和完整参考语义。归档验证真实解码尺寸；幂等、额度、迟到屏障、底图读取和私有归档已接通。新结果是独立 Generation 根版本，source provenance 关联原 asset/version/generation，不填跨 Generation 的 parentVersionId。旧 edit/decompose 对产品任务保留 409，不能绕过新流程。

隔离原生 UI 已验证目标选择/保存、422 留稿、丢失 202 同 mutation 确认、新目标/新稿保护、手动入图、撤销/重做/全新 context 重开。产品构建层关闭原生 selection/undo 自动 mention，修复草稿保存失败，服务端媒体规则不放宽。真实 DB/S3/provider、连续改图与底图读回仍待验收。

## 第三批：蒙版局部修改，尚未开放

保留原生 `remover.enter/commit/exit` 及画笔 store；已定位 `37733.fS(contours,width,height)` 可导出黑底白笔迹 PNG。仍需替换 vendor 提交动作，将目标 SHA、文档 revision、蒙版实际尺寸和摘要送给产品后端。

蒙版与实际送入模型的目标图须共用同一裁切/翻转坐标系。旧 `EditVersionInput.payload` 很宽松，另一个旧 UI 使用矩形数组，而 provider 期待 base64 图；不得直接复用为新合同。白色重绘/黑色保留到 alpha 蒙版的转换可复用现有 `_build_inpaint_mask`，但当前不因此宣称支持产品蒙版修改。

## 后续验收与开放条件

- 完成真实一次性数据库、S3 兼容存储、worker、provider 的 EXACT 全流程：原生上传 → 保存用途/选框 → 幂等受理 → 模型底图 → EXACT 复贴 → clean base 密文保存 → 成果归档 → 原生加入/撤销/重做 → 保存重开。
- 在真实持久化环境复核 SHA 改变、对象删除/替换、跨项目/品牌、归档、降权以及失败重试的拒绝边界，确认调用与发布前均不会错用素材。
- 验证 provider 已成功但合成或 S3 失败时只重试归档；旧 attempt、旧密钥 worker 的迟到写入不能覆盖新结果；clean base 能按授权身份读回，错误密钥/身份明确失败。
- 任意角度、等比缩放、EXIF、透明图与边缘抗锯齿另列对照；保留已测/未测及允许误差，不把整数 90° 场景的全 RGBA 相等泛化。
- 整图修改先完成合法来源与 clean base 复贴闭环，再开始蒙版全黑/全白、尺寸不符、越界、撤销后提交、缩放后笔刷坐标和受保护区域效果的验收。
- 文档持久化不代表撤销栈跨刷新持久化；原生图重开与原生 PNG 复导出已测场景，应与跨刷新撤销历史分开记录。
