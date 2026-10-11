# Novart 开发日志 · 2026-10-11

## 自研画布工具补齐（本地完成，发布待执行）

用户明确授权补齐对象复制、右键操作、文字排版、图片裁切翻转、对齐组合、图层显隐锁定排序、橡皮擦和直线箭头，以及画框联动和局部导出。三个子智能体分工实现数据模型／纯操作、渲染导出和交互 UI；主任务接通真实图片替换、后端效果边界和浏览器检查。

当前确认：基础对象保持旧版兼容，只有使用扩展工具的对象升级 owned v2。裁切使用原图归一化区域，图片身份与鉴权素材 URL 保留；翻转、文字属性、逻辑分组、平面坐标画框关系、显隐锁定随文档保存。屏幕与导出共用字体／图像／箭头计算；隐藏图层排除，锁定图层仍可导出。已有裁切与翻转、旋转画框裁边的真实像素检查。

新增隐藏图层／隐藏画框祖先检查接在服务端工作流和 EXACT／整图修改守卫；旧引用保留并显示不可用原因。现有后端尚未合并裁切效果的 AI 操作继续明确拒绝，不把显示裁切静默当成完整原图。图片替换通过真实上传任务和解码回执返回，不在前端伪造持久素材。

最终检查结果：

| 检查 | 结果 | 证明范围 |
| --- | --- | --- |
| 仓库 `pnpm test` | 989通过（contracts965 + UI24） | 模型、服务守卫、操作和导出回归 |
| AI完整pytest | 365通过 | Windows同一项目虚拟环境；没有模型调用 |
| Web typecheck | exit0 | 完整类型检查 |
| Web生产build | exit0 | 实际Next生产构建；不是运行后端验收 |
| 独立实际Chromium | 49项通过，pageerror/外部请求0 | 真实React/指针/键盘/拖拽/上传选择/菜单/下载；loopback合成API |
| 最终源码冻结 | 16个源码/测试文件哈希未变化 | 最后门禁与最终浏览器对应相同源码 |

Windows的 `pnpm test:ai` 因POSIX `.venv/bin/python` 被cmd拒绝，保留首次失败；使用同一项目 `.venv/Scripts/python.exe -m pytest -q` 完整365项通过，不宣称原命令通过。build使用已存在的显式低内存模式（每Node old-space768MiB），依然警告本机Redis不可用和url.parse弃用；独立类型检查已执行，构建成功不证明真实DB/Redis可用。

### 工具检查与修正

- 增加13项新工具交互，在原36项之上合计49项。覆盖连续两次粘贴ID不冲突、图片替换及撤销、中文排版、裁切翻转、组框联动、对齐、整笔擦除、图层拖放显隐锁定、保存刷新以及选区/画框导出。
- 实际修正连续粘贴沿用旧ID和画框背景盖住内容的风险；画框导出除PNG/SVG像素一致还必须有非空内部像素，避免两份空图误通过。
- 第一次默认Playwright浏览器文件不存在，改用本机已安装Chrome独立headless运行，不下载浏览器、不调用Computer Use。原失败报告保留。
- 最终强化轮曾在“撤销粘贴已清空选中”后直接CtrlD，属于测试前提遗漏；补显式重新选择原对象后13项和全49项均通过，未删除断言。相关false报告保留，不把它说成重复粘贴产品失败。
- 模型补极小裁切值造成除法Infinity/过大尺寸的保护，并增加两项边界回归。图片替换保留持久上传任务及原图身份，成功后单次可撤销应用；待确认时不会静默换图。
- 橡皮擦当前删除整条笔迹；字体为三种本机族。高级旧容器/未知效果仍只读保护，裁切AI语义未支持时仍明确拒绝。这些边界不能算全部复杂编辑能力已恢复。

最终报告：`D:/coding/.novart-tmp/owned-canvas-full-tools-20261011-final2.json`，`passed=true`、checks49、`realBackend=false`、`realProvider=false`。冻结证明：`owned-canvas-tools-source-final-freeze-20261011.json`。原环境失败及测试前提失败报告原样保留。

本批尚未推送或发布，没有模型调用或公司共享资源写入。线上仍是之前已验证的55e核心版。CDS本轮GET-only回读确认独立project98的Web/AI/Worker均为预构建镜像，Garage及两块卷、PG/Redis独立卷可沿用，effective入口为/studio、readiness为/login。只更新应用镜像不需要重新导入存储配置或复制模型密钥。

距CDS交付仍有三道检查：1）准确新提交带 `[skip cds]`，先跑官方push/workflow dry-run，再核对实际签名投递和公司分支快照；2）该SHA云端一次性DB/S3/Worker/实际页面、构建镜像复验通过并发布已验证镜像；3）只部署独立项目98，回读运行SHA后实际登录验新工具、保存重开和局部导出。此记录不是新批次上线证明，不重复之前唯一一次付费生图。

## 新版产品入口纠正

用户打开交付链接后看到公司原版页面，反馈属实。此前发出的链接是裸 `/login`，而 `apps/web/src/app/login/page.tsx` 在缺少 callback 时默认返回 `/`；根页面仍保留公司原版首页。已评审的新工作台在 `/studio`，此前的交付链接没有进入它。

正确入口：[新版 Novart Studio](https://novart-product-integration-claude-novart-product-integration.geole.me/studio#/home)。匿名访问 `/studio` 的登录 callback 由 middleware 保留；不要把缺少 callback 的裸登录页当作新版产品入口。

已完成的修正：

- 官方 CDS 分支 `web-entry-config` 已将独立项目 `98cfea6cdcbd` 的 Web 入口从 `/login` 改为 `/studio`，读回的 effective path 和 URL 一致。AI/Worker 入口配置不变。
- 本机 `deploy/novart/cds-compose.yml` 的 `cds.web-entry-path` 改为 `/studio`；readiness 探针仍为 `/login`。只改入口标签，不修改服务环境、启动命令、图片模型或共享资源。
- README 与整合进度补充当前正确入口；较早日志保留历史状态。

配置前后回执保存在受保护控制目录的 `studio-entry-fix-20261010.json`，原始 recordedAt 为 `2026-10-10T18:26:58+08:00`，不改写该时间或历史证据。本日志按当前客户端日期记录。

本次没有应用部署、业务写入或模型调用，线上仍为已验证的 `55e07ac`。源码标签及文档修改仅保存在本机，未新增推送。裸 `/login` 的默认跳转行为未被修改；当前修正依靠独立 CDS 入口和明确的 `/studio` 链接。

### 验证与边界

官方入口配置本轮只读回查为 HTTP 200，effective path 和 URL 仍为 `/studio`。独立 compose 与 HEAD 的结构化比较已通过，确认只改变入口标签，readiness、环境和启动命令不变。

独立 Chromium 的实际入口检查已确认：输入 `/login?callbackUrl=%2Fstudio`，不固定 workspace 参数；实际密码登录 HTTP 200，跳转 `/studio` HTTP 200。工作台随后将服务端选定的品牌写入 URL；新版 `NovartStudio.snapshot().homeStart.loaded` 为 true，`#ns-home-brief`、`#ns-create` 均可见。记录四项检查通过，只有一次认证 POST，业务写入、模型调用、外部请求、pageerror 均为 0。

报告：`D:/coding/.novart-tmp/studio-entry-readonly-report-v2-20261011.json`。该报告在最后一个额外 session 读取阶段记录 `READONLY_ENTRY_CHECK_FAILED`，整体 `passed=false` 保留不改。前四项支持“实际登录回跳和新版首页可见”的限定结论，不能把整份报告写成全部通过；额外 session 检查的失败另留待定位。入口修正不替代之前的核心业务验收。

归因：交付链接和独立项目入口配置错误。此项不属于已记录的四项 CDS 平台源码故障，也不说明已验收的上传、生成、保存恢复链路失效。
