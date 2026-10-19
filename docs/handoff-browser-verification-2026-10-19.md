# 10 月 19 日交接收尾：独立浏览器回归

日期：2026-10-19
工作目录：`D:/coding/公司/brandai-layer-ux`
基线提交：`7a4141f`，加本轮未提交的界面文案修改。
依据：[交接文档](./handoff-gpt-2026-10-19.md)和用户“按照文档改，改完出报告，多智能体并行”的指令。

## 1. 结论与边界

本次独立回归的 **9 组、161 个命名行为检查全部通过**。这里的数量是各 JSON 回执中 `checks` 的总数，每个检查可以包含多个断言，不是 `assert` 语句的执行次数。9 份回执均为 `passed: true`、`errors: []`、`externalRequests: []`、`providerCalls: 0`。

验证使用本机 Chrome **155.0.8059.80** 的 headless 模式，通过 Playwright 直接访问随机端口的 `127.0.0.1`。没有使用用户浏览器、computer use、Docker、线上账号、共享数据库或真实模型。业务响应是各现有测试脚本提供的内存 HTTP 夹具；编辑器及其样式、首页模块、品牌切换和任务入口使用真实产品源文件。它证明交互、恢复与防重复行为，不证明线上数据库、队列、存储、真实生成质量或非方图模型输出正确。

本次没有发现失败用例，没有修改产品逻辑或浏览器测试代码。仅刷新本地静态产物、运行测试并记录结果。

## 2. 确认测到本轮源码

文案修改完成后，先执行已有的 `scripts/export-novart-studio.py`：导出 24 个文件、385402 字节，`capturedExternal: 0`。测试结束再次对照当前源码 SHA-256，`studio.html`、`novart-product-bootstrap.js`、`novart-product-task-inbox.js` 均与 `.novart-build/studio/manifest.json` 中对应条目匹配。

交接中的 33 处术语修改范围分开理解：

- 当前导出壳加载的文件中有 9 处：bootstrap 4、task-inbox 4、HTML 1。本次品牌创建、恢复、切换和首页用例运行了修改后的导出壳及真实脚本；任务收件箱专门回归由文案智能体负责，未重复计入本报告的 161 项。
- `novart-product-generation.js` 和 `novart-product-materials.js` 的其余 24 处在保留的旧兼容脚本中，当前 24 文件导出包不加载它们。本报告不把这些文案更新说成新版生成或素材逻辑的改变，也没有为测试重新启用旧入口。

所有测试使用本地网络保护预加载文件 `.novart-build/temporary/handoff-loopback-preload.cjs`。它为 Playwright 新 context 加入仅允许 loopback 的请求规则，并关闭 Chromium 后台联网。既有 harness 自身的同源拦截继续生效；首页模块 harness 原来只记录外部请求，本轮由该预加载保护补上执行时拦截。该临时文件不进入产品包。

## 3. 本轮结果

| 组别 | 通过检查数 | 本轮回执（相对工作目录） |
| --- | ---: | --- |
| 核心画布与工具 | 55 | `.novart-build/handoff-owned-canvas-browser-report.json` |
| 对话、未知提交和终态恢复 | 43 | `.novart-build/handoff-conversation-browser-report.json` |
| 排列、比例锁和图片交接 | 10 | `.novart-build/handoff-owned-experience-browser-report.json` |
| 分层成功后的画布操作 | 10 | `.novart-build/handoff-owned-layer-browser-report.json` |
| 分层失败保护 | 3 | `.novart-build/handoff-owned-layer-failure-browser-report.json` |
| 首页首次创作与 IndexedDB 恢复 | 7 | `.novart-build/handoff-home-creation-browser-report.json` |
| 首页跨品牌离开与恢复 | 9 | `.novart-build/handoff-home-brand-leave-browser-report.json` |
| 新增品牌响应丢失与明确拒绝 | 15 | `.novart-build/handoff-brand-creation-recovery-browser-report.json` |
| 品牌新增、切换、刷新 | 9 | `.novart-build/handoff-brand-switcher-browser-report.json` |
| **合计** | **161** | **本轮全部为成功回执** |

这些回执生成于本机时间 2026-10-19 13:08–13:11，不是复用上一轮的测试结果。首页原脚本使用固定输出文件名，完成后将同一次回执复制到本表的 handoff 文件名，其内容没有改写。

## 4. 对交接要求的具体覆盖

### 首页首图与重复提交

- 明确输入文字、点击开始创作后，在测试服务中只产生一次被接受的首次对话。
- 参考图片先上传并确认画布保存，然后才提交首次对话；真实 React 编辑器用例还覆盖对话和工作流延迟初始化。
- 丢失成功响应并刷新后，恢复同一请求身份；网络请求可以重放，但内存服务中不出现第二条被接受的任务。
- 只图无字走放入画布，不凭空补生成提示词；空输入和空白入口不提交生成。
- 超过 4000 个 UTF-16 字符的输入完整保留，并显示可读提示。
- 保存失败时保留原图、需求和恢复身份，明确恢复后再继续。

首页模块用例的空白按钮由测试宿主提供，相关检查只证明未调用生成；没有将它说成真实数据库空白项目创建验收。

### 单一输入、选图修改与分层

- 页面只有一个“对话设计需求”输入框，不出现重复创作输入框或重复全局分层入口。
- 快捷修改固定已选择的目标；引用顺序、用途、参与状态和删除结果在恢复后保持一致。
- 未知提交冻结输入，用户点击“检查上次提交”后复用原请求及图片快照；不会因为刷新、切项目或任务查看而额外发起模型调用。
- 分层结果以原子操作放到原图右侧，保留可见原图；部分下载失败不会只插入半组图层。
- 分层成功可撤销、重做、保存重开；失败替换处理中提示并保留原图，不自动重试。

分层成功用例的 PNG 为明确的 12×8 本地夹具，用于验证对齐、透明度、组操作和恢复，不能代替真实街景图的模型分层验收。

### 比例锁、排列与画布稳定性

- 宽高默认锁定比例，50% / 100% / 200% 快捷倍数正确；解锁后可独立修改尺寸，偏好在刷新后保留。
- 连续三张图片按画布世界坐标有序向下排列，不受镜头平移影响；最新图被选中并带入可视范围。
- 修改结果位于原图右侧，原图几何不变。
- 插图下载失败和归档失败可恢复；恢复只完成落图，不重启生成；用户撤销、删除或刷新不会强制重插入已经处理过的图片。
- 核心工具栏持续等待 15 秒仍在，包含画笔、文本、图形、选择变换、裁切翻转、图层、框架及 PNG/SVG 导出验证。

### 新文案之后的品牌与任务恢复

- 新增品牌出现未知响应时先检查服务端列表，不再次创建；明确拒绝仍允许用户主动重试。
- 创建成功但切换失败时进入已创建品牌，不生成重复品牌。
- 切换前等待画布和草稿保存确认；存储空间不足、中文输入未结束或缺少保存能力时保留当前内容并给出提示。
- 刷新后 URL、测试 Cookie 和当前品牌一致；旧品牌任务及错误不会渗入新项目。
- 既有任务通知只打开对应任务，不自动修改画布或发起生成。

## 5. 执行入口

浏览器路径通过 `NOVART_CHROMIUM_EXECUTABLE` 指定为 `C:/Program Files/Google/Chrome/Application/chrome.exe`。本轮依次运行以下已有脚本，没有并发启动多组浏览器：

1. `scripts/test-novart-owned-canvas-browser.cjs`：默认核心用例；再分别以 `NOVART_OWNED_EXPERIENCE_ONLY=1`、`NOVART_OWNED_LAYERS_ONLY=1`、两项分层环境开关组合运行分支用例。
2. `scripts/test-novart-conversation-browser.cjs`。
3. `scripts/test-novart-home-creation-browser.cjs`。
4. `scripts/test-novart-home-brand-leave-browser.cjs`。
5. `scripts/test-novart-brand-creation-recovery-browser.cjs`。
6. `scripts/test-novart-brand-switcher-browser.cjs`。

分层失败分支同时设置 `NOVART_OWNED_LAYERS_ONLY=1` 和 `NOVART_OWNED_LAYERS_FAILURE_ONLY=1`；每个场景在独立 Node 进程中运行，报告路径单独设置。实际命令均带 `node --require ./.novart-build/temporary/handoff-loopback-preload.cjs`。

## 6. 未验证项目

- 真实登录、成员权限、数据库持久化、队列、对象存储和模型计费链路。
- 首页自动首次生成的真实模型产出与费用；本轮模型调用为零。
- 新反馈街景图非方图分层的原始模型输出、输出尺寸与坐标语义，须由只读取证分支另行报告。
- CDS 或正式站当前版本、旧页面删除、历史兼容脚本的完整运行行为。
- macOS/Safari、真实操作系统中文输入法和真实触屏硬件；本轮为 Windows Chrome headless，中文输入采用合成 DOM composition 事件。

本报告的完成结论仅限上述本地交互回归；不能用它替代真实服务验收或宣称线上故障均已关闭。

## 7. 同日新增上传阻断反馈的后续结果

上述 161 项完成之后，用户新增了首页上传失败后无法删除、无法进入项目的截图。新增的 `FAILED` 首页用例在旧代码下明确复现：卡片仍为 `queued`，删除与空白画布入口禁用。原有 7 项首页浏览器用例仍通过，因此本报告原有结果不能推导出失败恢复场景也曾覆盖。

该问题随后独立修复并验证：协议 34 项、首页模块 Chrome 14 项、完整 Studio 壳 Chrome 5 项通过；保留了单独的修前红和修后绿回执。详细证据及真实服务边界见 [首页上传失败恢复验收](./home-upload-recovery-verification-2026-10-19.md)。这些新检查未混入原 161 项历史计数。
