# DeepFlare 画布引擎适配（本地）

## 目标与依据

用户提供《自研改造指南》，要求把已有源码做适配，成为产品的引擎。本批在 `devUpdate1012` 本地实现，起点 `9fde897`；没有推送、部署或合并 main。

附件目录里的 `tldraw-re/package` 是 `@tldraw/editor@5.5.2` 编辑器包，不是完整 Lovart 产品源码。指南涉及的部分代码行数、试用行为与本地包不一致；其中“去掉 warnings 锁定”和“只按引用比较历史”不能照搬。本批参考模块划分与渲染思路，独立实现现有自研画布的引擎层，没有复制 SDK 实现、引入 SDK 依赖或修改授权校验。

## 已接入的边界

| 层 | 代码 | 职责 |
| --- | --- | --- |
| 产品适配入口 | `apps/web/src/lib/owned-canvas-engine/index.ts` | `ownedCanvasEngine`：读取、保存、序列化、PNG/SVG 导出及编辑策略 |
| 相机 | `camera.ts` | 屏幕/世界坐标转换、锚点缩放、DOM transform |
| 场景 | `scene.ts` | 按元素引用缓存边界、可见区域判定、稳定 DOM 排序与文档层序 |
| 编辑历史 | `history.ts` | 有界 delta 历史；仅复制变化元素，隔离嵌套笔迹/裁切数据；撤销保留后来上传对象与当前相机 |
| 几何 | `geometry.ts` | 现有旋转、缩放、选区和编辑差异；组件旧导入保留兼容转发 |
| React 视图 | `components/owned-canvas/OwnedCanvas.tsx` | 实际使用引擎相机、场景、历史，处理指针/输入/工具条 |
| 业务宿主 | `components/owned-canvas/OwnedEditorClient.tsx` | 经适配入口读写/导出；继续负责认证、revision、幂等回执、素材与模型任务 |

没有建立第二个文档存储。浏览器中的完整 `OwnedCanvasDocument` 是编辑状态，服务端 `novart-native-v1` 仍是保存协议。视口隐藏结果不会写入 `item.hidden`、删除记录或修改素材身份。

```ts
import { ownedCanvasEngine, OwnedCanvasHistory } from "@/lib/owned-canvas-engine";

const document = await ownedCanvasEngine.decodeDocument(savedCanvas);
const history = new OwnedCanvasHistory();
// UI uses immutable item updates; the host still owns revision/permission checks.
if (ownedCanvasEngine.canEdit(document, readOnly)) {
  const encoded = await ownedCanvasEngine.encodeDocument(document);
  // Pass encoded to the existing revisioned API, never directly overwrite a project.
}
const svg = await ownedCanvasEngine.exportSvg(document, { origin: location.origin });
```

## 实际行为变化

- 相机事件先同步逻辑状态和世界/网格 DOM；选框、浮层与剔除集合按动画帧刷新。松手/滚轮结算仍走原保存逻辑，命中与保存读取同一最新相机。
- 每个元素有独立 React memo 边界。未变化的图片、文字和 SVG 内容不会仅因平移相机而重新执行内容渲染。
- 离屏元素保留 DOM，用 `display:none` 停止绘制。选中、文字编辑及裁切对象受保护；未测量容器尺寸时不隐藏整个场景。
- DOM 始终按 ID 稳定排序，zIndex 按文档层序更新。图层重排不移动图片节点；选中和工具条保持原 UI。
- 撤销差异先比较引用，相同时快速跳过；新引用再比较结构，内容相同的克隆不制造假历史或清空 redo。历史默认仍为 60 步，没有盲增到 500 步。

## 保留的保护

- 未知对象、多页歧义、关联/视角异常等仍只读保留原稿。不能仅解开 UI 锁让用户编辑一个保存层必定拒绝的文档。
- 原文档相机坐标换算、素材 ID/SHA、图片编号、frame/group、保存冲突与失败停写逻辑不变。
- 上传/生成图片在拖动、画笔或擦除期间返回时，原有手势合并与撤销隔离继续生效。
- AI、存储和认证由宿主后端处理，引擎不持有密钥，也不自动重试付费请求。

## 验证

新增单元回归 26 项（相机/场景 19、历史 7）。全量契约/服务 1614、UI 34、AI 500、Web 类型检查以及生产 `build:low-memory` 均通过，构建退出码 0。AI 测试保留既有 Starlette/httpx 弃用提醒，不属于本轮失败。

本地真实 Chromium、直连 loopback 的结果：

| 流程 | 结果 |
| --- | --- |
| 原有画布核心、保存恢复及安全边界 | 52 项通过 |
| 扩展工具 | 13 项通过 |
| 分层入画 | 10 项通过 |
| 图片操作与异步竞态 | 19 项通过 |
| 新引擎大场景 | 9 项通过 |

大场景由 224 个合成元素开始，真实平移/缩放/命中/重排，创建中文文字与笔迹后为 226 个；gzip 保存后卸载编辑器再重建，全部记录和相机一致。导出同时包含屏内和离屏图片。连续平移保留图片节点，重排时世界层 childList 变化为 0。报告位于 ignored `.novart-build/engine-browser-20261015.json` 和 `owned-engine-*-20261015.json`，新引擎浏览器脚本已加入原 CI 配置，远端尚未执行本批。

这些是合成数据交互与文件验证，不是新的真实账号、数据库或模型质量验收。原 `tests/interaction/canvas-functions.mjs` 针对旧 `/workspace` 画布和真实栈，本轮使用针对当前生产 `OwnedCanvas` 的现成 loopback harness；未启动 Docker 或连接共享业务数据。

## 范围与后续

这是一版已经接入产品的自研引擎适配，不宣称完整复现 tldraw/Lovart。空间查询当前仍 O(n)，缓存减少边界重算；保留 DOM 不等于减少所有图片下载/解码内存。尚未做 R-tree、绑定箭头、多人协作或全面旧对象转换，也未宣称 10,000 对象性能验收或 Mac/Safari 验收。

后续先以实际大项目性能数据决定是否引入空间索引与按需图片加载，再评估手势状态机拆分。新 AI 工具接在宿主的任务/素材接口，不绕过来源和权限校验。
