# AGENTS.md — BrandAI 跨工具智能体约束（binding）

> 本文件面向**所有**在本仓库工作的编码智能体（Claude Code / Codex / Cursor / Copilot…）。
> **唯一事实源仍是 [`CLAUDE.md`](./CLAUDE.md)**；本文件是它的「不可违反门禁」摘要 + 本仓库
> 血泪教训沉淀。两者冲突时以 `CLAUDE.md` 为准。动任何跨切代码前先读 `CLAUDE.md` §0–§2。

---

## 0 · 三条交付门（违反 = 不许 push / 不算完成）

### G-VERIFY · 未验证不交付
push 前**必须**在能联网的环境跑全绿，缺一不可：

```bash
pnpm test              # L1 contracts + ui
pnpm test:ai           # L2 apps/ai pytest
pnpm -F web typecheck  # tsc --noEmit
pnpm -F web build      # 生产 build
```

- **「沙箱无网 / 装不上依赖 / DNS 不可用」不是放行理由。** 换能联网的机器跑，或把改动停在分支
  等门禁过了再合，**绝不带未知红推主干**。
- 改动文档里写「typecheck 未完成 / 预览未完成」却同时勾「已提交并推送」——这就是 G-VERIFY 违例
  （V0.02 实际发生，见 `docs/10` #6）。交付说明里只能写**已实测的结果**，不能写承诺。

### G-CDS · 正常开发不得跳过 CDS（CLAUDE.md §0.8）

- 正常开发提交的标题与正文不得添加 CDS 识别的跳过标记或 `skip-checks: true` 末尾 trailer；构建、预览和正式发布沿用 CDS 原生流程。
- 历史隔离日志中的跳过部署做法已于 **2026-10-12 停止使用**，只用于追溯，不得作为当前提交或部署指令。需要暂停部署时按用户当次要求处理，不得自行沿用旧策略。
- 首次进入新克隆或工作区时运行 `node scripts/install-cds-push-guard.cjs`。普通 `git push` 自动检查本次推送的每个分支末端提交；旧祖先、删除分支及标签不参与本门禁。
- 推送前可运行 `node scripts/cds-pre-push.cjs --check-head`；不得使用 `--no-verify` 绕过。安装器遇到已有非本项目钩子或自定义 `core.hooksPath` 会保留原设置并停止，需完成钩子整合后再推送。
- Git 历史不重写。文档可以保留历史标记，提交信息中不要引用这些字面量。具体边界见 [CDS 提交规则](docs/cds-push-policy.md)。

### G-RELEASE · 项目发布合同不可绕过

- 正式发布唯一入口为仓库根 `cds-release.sh`，项目自行维护发布逻辑，CDS 默认只执行目标提交中的该文件。
- 改代码或资源产物时，必须同步确认 `bash cds-release.sh check` 和 `node --test scripts/test-project-release.mjs` 通过；两者均在 PR CI 和镜像 CI 执行。
- 禁止改服务器独立脚本、换成 CDS 自动推断的部署类型、删掉/跳过发布检查来伪造成功；脚本退役资源时按当前 manifest 校验，不维护旧文件白名单。
- 发布必须同一完整 SHA 的 CI/镜像通过，再用 CDS 发布；核对实际 Web/AI/Worker 版本、生产数据卷、最终 HTTPS 页面和资源。只看 running 或健康接口不算完成。
- 发布失败先修项目合同并经 PR/CI 验证，不以 SSH 临时补丁取代正常交付。CDS 独立脚本仅是明确选择的备选，不能自动兜底。

### G-AUTHORITATIVE · 服务端权威（CLAUDE.md §0.3）
- **租户 / 品牌 / 当前项目等"会被刷新和分享的状态"必须服务端权威**：落 cookie 或进 URL，
  让 SSR / 刷新 / 深链 / 分享链接解析到同一个值。**只存 `localStorage` = 双事实源**（客户端一套、
  服务端守卫另一套），禁止（V0.02 多品牌切换犯过，见 `docs/10` #5）。
- **任何长耗时调用（AI / 外部）不得在 HTTP handler 里 `await`**：handler 只 auth→快检→落 PENDING→
  enqueue→返回 202，真正的活在 worker 跑（CLAUDE.md §0.3 四子规则）。

### G-REAL · 不造假数据（CLAUDE.md §0.1）
- 取证材料里**绝不**出现 `IMAGE_PROVIDER=mock` / `VLM_PROVIDER=mock`；不 `INSERT` 绕过真 worker
  伪造 `Generation*/Asset`；不用 `public/` 占位 SVG 冒充生成结果。
- 验收 = 真 provider → 真 API → 真 DB。静态 Demo（`demo/*.html`）只能当**交互草图审阅件**，
  不得当验收证据，也别和真页面混在主干长期漂。
- 例外：**交互自测**（点按钮/拖拽/编辑是否工作，见 G-INTERACT）允许用 mock provider 在本地跑——
  那是测「交互行为」不是测「生成质量」。但**对外取证截图**仍禁 mock。

### G-INTERACT · 交互类 UI 必须真浏览器点过（编译绿 ≠ 能用）
改动**自定义画布 / 可拖拽 / 可缩放 / 可就地编辑 / 浮层工具条**类 UI（典型 `workspace/OpenCanvas.tsx`、
`page.tsx`、`MaskPaintCanvas.tsx`）时，**`typecheck/build/L1` 三绿不算完成**——它们一个都不碰指针事件、
焦点结算、`setPointerCapture`、RSC 软导航。这类 bug 只有**真浏览器逐功能点一遍**才暴露（本仓库
2026-06-27/28 一轮连续 4 个交互 bug 全部漏过三绿，根因见 `docs/11`）。

- **完成判据**：本地起栈 + headless Chromium **直连 `127.0.0.1`**（沙箱 MITM 代理会关掉到外网预览域的
  浏览器连接，但 `localhost` 在 noProxy → 这是沙箱内唯一能自测交互的路径），逐功能点过且断言通过。
- **现成 harness**：[`tests/interaction/canvas-functions.mjs`](./tests/interaction/canvas-functions.mjs)
  （+ 同目录 README 一键起栈/造数/跑测）。改画布**先把它跑绿**，别从零写。
- **四类必查反模式**（详见 `docs/11` §A）：① 画布内浮层外层 `onPointerDown` 必 `stopPropagation`；
  ② 浅层 URL 同步用 `history.replaceState` 不用 `router.replace`；③ 长异步操作 arm→confirm + 有界
  超时出口（§0.3/§2.4）；④ `setPointerCapture` 会吞原生 `dblclick`（手动双击检测）、`autoFocus` 会被
  in-flight click 立刻 blur（延后一帧聚焦）、点普通 `div` 不 blur input（点框外主动 blur 提交）。

---

## 1 · 多租户隔离（binding · CLAUDE.md §3.5）

1. 每个数据查询必须 **workspace 作用域 + 成员校验**（`requireWorkspaceRole` / `requireOwnedWorkspace`）。
2. **任何客户端传入的 workspace/资源 id 必须校验归属**再使用——cookie 里的品牌 id 也要先过
   `Membership` 校验（`getOrCreateActiveBrand` 已立此规），否则是 IDOR。
3. 配额 / 计费按 **workspace owner（租户）** 计，不按发起的协作者。
4. AI 服务（`apps/ai` FastAPI `/v1/*`）**永不直接对外**，只走内部 `AI_SERVICE_URL`。

---

## 2 · 契约 = 唯一 wire 格式源
`packages/contracts/src/*.ts`（Zod）与 `apps/ai/app/schemas.py`（Pydantic）是镜像——
**任何契约改动两边同时改**，否则 L1 的 null-vs-optional 测试会红。别在路由 / 表单 / worker /
AI 请求体里造契约外的字段。

## 3 · 共享函数别为单页改默认
一个页面的展示偏好不要去改 `lib/` 里被多处调用的共享函数的默认行为。需要差异化就**加显式参数**
（如 `getConfirmedRules(wsId, { order })`），让确定性默认服务于快照 / 合规 / 导出，特例只在调用点 opt-in。
V0.02 把 `getConfirmedRules` 默认排序从 `createdAt asc` 翻成 `updatedAt desc`，连规则快照和合规校验
都被牵连（`docs/10` #4）。

## 4 · 紫色设计语言（CLAUDE.md §0.6）
唯一品牌色 violet `#7C5CFF`；全部走 `packages/ui` 的 16 语义 token，**禁止**硬编码 `bg-[#...]` /
`text-yellow-600`，禁止重新引入 burgundy / 暖色。复用 `packages/ui` primitives。

---

## 5 · 完成任务时（CLAUDE.md §4）
1. G-VERIFY 全绿。
2. commit 用真实 subject（非 "WIP"），分支 `claude/<slug>`；**不建 PR 除非用户明确要求**。
3. 更新 `docs/worklog/progress.md` 对应记录 + 同步对应 `docs/` SSOT。
4. **提需求调整自带归因代号**（N/S/I/O/R/E）记入 `docs/10_需求调整归因表.md`。

## 工作日志位置（2026-10-16 工程整理）

计划、进展、调查分别维护在 `docs/worklog/task_plan.md`、`docs/worklog/progress.md`、`docs/worklog/findings.md`。根 README 仅维护使用说明；不要重新把历史进度堆回首页。
