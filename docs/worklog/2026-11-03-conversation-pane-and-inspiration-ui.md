# 2026-11-03 灵感库检索修复与画布对话区重做

本轮两批改动：灵感库（检索/分页/图片缓存/错误文案/响应式）与画布右侧对话区按参考稿重做。另含一次本机 Docker 无法启动的排查结论。

## 起点与提交

- 起点 `2b79559`（分层预览当时实际运行版本）。
- 本轮结束时本地与远端均为 `f10d043`，工作区干净。
- 已推送 `claude/layer-quality`，**未做 CDS 部署**。预览仍运行 `2b795594d8da`，因此页面上看不到本轮界面改动，属预期。
- 同时带上了 `ce78d24`（共库兼容修复）——该提交此前已完成本地验收但一直未推。

## 一、灵感库：229 条只显示 200

### 判定

`filterCatalog` 末尾硬编码 `.slice(0, 200)`，而 `caseCount` 在截断前计算。结果是界面同时显示「库内 229」与「当前显示 200」，剩余 29 条无任何可达路径。接口只读 `q/kind/industry/medium/task` 五个参数，`limit/offset/cursor/page/skip` 全部无效，浏览器无法翻页。

这不是展示上限，是内容不可达。

### 改动

- `catalog.ts`：`filterCatalog` 去掉截断，只做匹配与排序；新增 `pageCatalog(cards, filters, page)` 做游标分页。
- 游标用 `caseId` 而非 offset：排序是 `score desc, caseId asc` 全序，新案例发布不会让翻页错位；被筛掉的 caseId 不会复活成锚点（找不到则返回空页）。
- 页大小默认 50，上限 `CATALOG_MAX_PAGE_SIZE = 200`，`?limit=10000` 被夹住。
- 契约（Zod + Pydantic 同步）：`InspirationListResponse` 增加可选 `matchedCount / hasMore / nextCursor`。
- `inspiration/route.ts`：读取 `cursor`（截断 128 字符）与 `limit`。
- 前端：`当前显示 N 个案例（共 M 个）` + 「加载更多」，按 `libraryId:caseId` 去重。

### 测试

`inspiration-catalog.test.ts` 原有断言 `expect(filterCatalog(cards)).toHaveLength(200)` 恰好把截断缺陷固化成了预期，本轮改为 `toHaveLength(205)` 并补三条：游标走到底能取全 205 条、过滤后总数描述过滤结果、失效游标不复位。

## 二、图片接口：每次请求重算 sha256 且 no-store

`cases/[caseId]/images/[imageId]/route.ts` 原来每个 GET 都对整图 `sha256(bytes)` 并从 DB 取全量字节，响应头是 `Cache-Control: private, no-store`。一页 200 张卡等于 200 次哈希加 200 次全量传输，且刷新后全部重来。实测单张最深 60–75 秒。

改为：进程内记忆已校验的 `(libraryId, releaseId, path, sha256)` 四元组，只哈希一次；响应带强 `ETag`，命中 `If-None-Match` 返回 304；`Cache-Control: private, max-age=31536000, immutable`（内容按 revision 不可变）。鉴权与权限校验在 304 分支之前执行，缓存不绕过越权。

## 三、错误文案：Failed to fetch 直接进页面

`client.ts` 的 `apiFetch` 只在 `!res.ok` 时包装，网络层异常原样抛出。`errorText` 取 `error.message`，于是浏览器原生的 `TypeError: Failed to fetch` 直接渲染在首屏。

改为在 `fetch` 外层 try/catch，网络失败包成 `ApiFetchError(status 0)`；`AbortError` 原样上抛（取消不等于离线）。`errorText` 按 status 映射，并对残留的英文 transport 文案兜底。新增 `client-transport-errors.test.ts` 三条覆盖：网络失败中文化、HTTP 失败透传服务端 message、abort 不被伪装。

## 四、对话区按参考稿重做

参考稿来自用户提供的独立 HTML 原型（`DeepFlare-source.zip`，非本仓库代码）。编辑器外壳已有「对话改图 / 文案 / 记录」三标签（`OwnedEditorClient.tsx:954`），本轮只重做面板本体。

- 消息拆成两侧：用户气泡右对齐、浅紫底、右上小圆角、右侧头像；助手结果左侧头像 + 正文直排。
- 输入区从 400px+ 压到约 300px：品牌规范收进折叠、修改对象变单行 chip、参考图变横向缩略图条、比例/画质并进同一操作行、字数计数移入输入壳右下角、发送按钮改紫色胶囊带 `↑`。
- 「文字像素优先…」那段尺寸规则没删，折进输入框下方「尺寸规则」。

### 施工中撞到的三处回归

1. 给 `{target.name}` 加「修改对象：」前缀，使元素 textContent 变成 `修改对象：图片2`，破坏浏览器脚本的 `getByText('图片2',{exact:true})`。改为名称独立文本节点、标签下移到第二行。
2. 「更多」面板试过 `absolute` 悬浮（跑出滚动容器，`check()` 超时）和独占一行（撑高 100px+），最终用 `details.contents` + `w-full` 作为 flex 子项整行展开。
3. 只在筛选条件真正变化时置 `filterPending`，避免 60 秒轮询把「当前显示 N」刷成「正在更新筛选结果…」。

## 五、三个门禁卡点（属另一批五项产品改动）

| 卡点 | 位置 | 处理 |
|---|---|---|
| `useAsImagePrompt()` 以 `use` 开头被 `rules-of-hooks` 当 Hook，build 失败 | `WritingWorkbench.tsx:293` + 两处调用 | 改名 `applyAsImagePrompt`；prop 名 `onUseAsImagePrompt` 保留 |
| 断言 `已应用 N 条品牌规则`，实现输出 `已传入 N 条…` | `packages/ui/tests/owned-generation-card.test.tsx` | 改测试迁就实现：无逐条回执时只能声称「已传入」，不能说「已应用」 |
| `toHaveBeenCalledWith(updated)` 整体对象比较失败 | 同上 `:74` | 组件回传补了 `brandRuleReceipts: []`，改为 `objectContaining` 断言关键字段 |

## 六、本机 Docker 起不来（与代码无关）

现象：WSL 发行版能启动、Docker Desktop 进程在跑、`/run/docker.sock` 始终不存在，`wsl --shutdown` 重启无效。

排查结论：以上怀疑全部排除——`docker-desktop.iso` 的 sha256 与官方清单一致（`10f8830b…331f`），`ext4.vhdx` / `docker_data.vhdx` magic 正常，WSL 文件系统完整。

真正原因在 backend 日志：

```
initializing backend: ... loading/formatting daemon.json:
parsing daemon config ~/.docker/daemon.json: invalid character 'ï' looking for beginning of value
```

`~/.docker/daemon.json` 开头有 UTF-8 BOM（`EF BB BF`）。Go 的 `encoding/json` 不认 BOM，backend 在 settings loader 阶段就崩，引擎没有机会启动。去掉 3 字节后引擎 8 秒就绪（`29.7.2`）。原文件备份为 `daemon.json.bom-backup-20261103-173706`，JSON 内容未改。

## 验证

| 项 | 结果 |
|---|---|
| `pnpm -F web typecheck` | 通过 |
| `pnpm -F web build`（带 lint） | Compiled successfully |
| `pnpm test` | 3/3 tasks；ui 42、web 2421 全绿 |
| `pnpm test:ai` | 851 passed（2 既有 warning） |
| `test-novart-conversation-browser.cjs` | 58/58 |
| `test-novart-owned-canvas-browser.cjs` | 全部 passed |
| `test-inspiration-catalog-browser.cjs` | 28/28，0 写入请求 |
| `test-inspiration-library-browser.cjs` | 16/16 |
| `test-inspiration-receive-browser.cjs` | 28/28 |

## 边界

- **未部署**。预览仍 `2b79559`，界面改动不可见；CDS 部署未执行，也未调用任何 CDS 发布接口。
- 未验收真实模型生成质量；对话区只做了界面与交互回归，未跑付费生成。
- 面板宽度仍是 `OwnedEditorClient` 的 360px，参考稿为 390px；改宽度会动编辑器主布局，未动。
- 本轮改了另一批五项改动写下的测试断言（已传入 vs 已应用）。若那批仍在开发，需知会。
- `.gitignore` 新增 `.novart-tmp/`，用于排除本轮截图脚本。

## 需求归因

- **O**：灵感库「库内 229 / 显示 200」无出口、图片接口每次重算哈希且禁缓存、错误文案直接透出英文——都是做了但用户无法确认或无法使用，属可见性与可用性缺口。
- **R**：`filterCatalog` 混了匹配与截断两种职责，拆成 `filterCatalog` + `pageCatalog`。
- **O**：对话区输入区占高 400px+ 挤压历史，参考稿已给出明确版式，属可见性/验收缺口。
- **E**：本机 Docker 无法启动，定位为配置文件 BOM 而非代码问题。
