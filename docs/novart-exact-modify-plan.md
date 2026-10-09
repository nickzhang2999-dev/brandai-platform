# EXACT 与原生改图的接入顺序 · 2026-10-09

本记录是本地源码核对后的后续实施方案，不是功能完成或真实模型验收报告。基线为生成批次 `302f665`，不改原捕获副本。先完成严格保留素材，再接整图修改，蒙版局部修改单独验收。

## 已有能力与尚缺的适配

| 部分 | 可复用源码 | 仍需完成 |
| --- | --- | --- |
| 主体确定性合成 | `packages/contracts/src/resource-usage.ts`、`apps/web/src/lib/exact-assets.ts` | 输出 frame、原生坐标转换、实际素材 SHA 与变换快照 |
| 接受时素材身份 | `studio-workflow.ts`、`studio-generation-policy.ts` | 现有 workflow 无输出区域、父级变换或 EXACT 配方；不能只解除 422 |
| 干净底图与复贴 | `workers/edit.worker.ts` 的 `params.baseImageUrl` 及后处理顺序 | 新归档目前成功即清私有原图；需保存受权限保护的底图对象、SHA 和图层配方 |
| 整图修改 | `/v1/edit`、`HttpImageProvider.edit` | 产品幂等/单次 claim、尺寸验证、源图身份、私有归档与合法来源关系 |
| 原生蒙版画笔 | 捕获 `1773.fe2335a6.js` 的 module `89719`（remover）与 `37733`（contours/store） | 旧提交仍走 vendor 上传/任务；替换提交边界，保留原生画笔及撤销 |

新 `assetUsages.EXACT` 与旧 `referenceAssets.STRICT` 含义不同：后者兼容成默认水印，不能用它冒充主体布局。EXACT 排除在模型参考图之外，由模型生成背景后复贴源素材；透明主体需源文件本身有透明通道，JPEG 背景不会自动抠除。缩放/旋转会重采样，不能宣传全部输出像素逐点不变。

## 第一批：明确输出区域与静态 EXACT

1. 由用户明确选择输出 frame；服务端从已保存原生文档解析 frame 和引用图片，绑定文档/workflow revision 与 SHA，不接受客户端任意素材 URL 或声称的坐标作为权威。
2. 原生 `c-image` 的 `x/y/rotation/parentId/index` 与 `props.w/h` 不一定是页面坐标。以 frame→页面矩阵 `F`、图片→页面矩阵 `I` 计算 `F⁻¹ × I`，再算中心比例、宽度比例和相对旋转。不能用旋转后的轴对齐外框推角度。
3. 首批只支持明确可表达的无裁切、无调色、等比静态图片；输出比例不符、隐藏对象、无效/完全越界图层、非等比拉伸等在付费前明确拒绝。后续逐项开放，不能静默忽略。
4. 原生裁切 `cropRegion={x,y,w,h}` 与公司 EXACT 的 `crop.left/top/right/bottom` 不等价。公司合成器先缩放完整图再遮裁边，直接使用裁后 `props.w` 会缩小或错位。原生 `flipY` 也不在现有 EXACT 合同中，必须转换或明确拒绝。
5. 同时保存受授权的 clean base、底图 SHA、EXACT 素材 ID/SHA、输出区域与完整布局配方。未来改图修改干净背景后再复贴，避免成品中的旧主体被模型修改、随后又叠一遍产生重影。
6. 复用几何合成函数前，按产品现有边界安全读取素材并限制字节/像素/期限，只传校验过的 bytes/data URL；不直接继承旧合成器任意 fetch/arrayBuffer 路径。

验收先用固定背景和主体进行本地几何/像素测试，再检查真实生成后的合成、归档、加入画布、撤销重做及保存重开。后处理失败只重试归档，不重新付费生成。

## 第二批：整图修改，保留原图

以单个已授权 target 开始，接受源素材 ID/shape ID/SHA 和保存版本，结果生成新图，用户决定后续放置，不自动覆盖原图。普通改图不承诺主体像素不变，主体保护由 EXACT 路径承担。

公司旧 edit 在同一 `Generation` 下创建 `parentVersionId` 子版本，`getVersionLineage` 也按该 Generation 查询；产品请求则一请求对应唯一 Generation。需先确定合法来源关系，不能跨 Generation 随填 parentVersionId；上传素材没有源 version，同样必须记录实际来源。

现有 edit provider 仍使用旧 `_snap_openai_size`，AI 响应也可能使用请求/默认尺寸。付费前验证支持范围，归档以实际解码尺寸为准。将幂等、额度、单次调用声明、超时迟到屏障和私有结果归档接到修改链后再开放入口。

## 第三批：蒙版局部修改

保留原生 `remover.enter/commit/exit` 及画笔 store；`37733.fS(contours,width,height)` 可导出黑底白笔迹 PNG。替换 vendor 提交动作，将目标 SHA、文档 revision、蒙版实际尺寸和摘要送给产品后端。

蒙版与实际送入模型的目标图须共用同一裁切/翻转坐标系。旧 `EditVersionInput.payload` 很宽松，另一个旧 UI 甚至使用矩形数组，而 provider 期待 base64 图；不得直接复用为新合同。白色重绘/黑色保留到 alpha 蒙版的转换可复用现有 `_build_inpaint_mask`。

## 必需验证

- 父级容器、旋转、缩放、平移和输出区域坐标一致；EXIF、透明图、裁切、翻转、非等比变换逐项验证支持/拒绝边界。
- SHA 改变、对象删除或替换、跨项目/品牌、归档、降权在付费与发布前均拒绝错用素材。
- provider 成功但合成/S3 失败时只重试归档；旧 attempt 不能覆盖新结果。
- 蒙版全黑/全白、尺寸不符、越界、撤销后提交、缩放后的笔刷坐标以及受保护区域效果。
- 新图进入原生 `c-image`，一次撤销移除、重做恢复；轮询不自动插回被撤销的图；保存重开保持内容和来源。
- 文档持久化不代表撤销栈跨刷新持久化，后者单独核对，未验证不宣称支持。
