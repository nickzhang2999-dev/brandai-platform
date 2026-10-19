# 交接给 GPT · 2026-10-19

接手人：GPT。交接人：小克（Claude Code）。本文件取代 `handoff-remaining-2026-10-17.md`。

## 0. 当前状态

- 工作目录：`D:/coding/公司/brandai-layer-ux`
- 分支：`fix/layer-faint-and-model-prefix`，HEAD `09c0043`（本文件提交后会再多一个文档提交）
- 远端：`origin/devUpdate1012` 停在 `2492b43`，本地领先 10 个提交，推送是快进
- 工作区干净，没有数据库迁移
- 本机门禁（`09c0043`）：contracts 293、UI 39、Web 1666 全部通过；typecheck 通过；lint 0 错误、14 条历史警告；低内存构建通过；首页协议 21 项通过。AI 561 项在 `059d62c` 上通过，之后的改动没有涉及 AI。

本地领先的提交：

| 提交 | 内容 |
| --- | --- |
| `d5b1393` | 几乎透明的图层加标记；推理模型名兼容网关前缀 |
| `31464e2` | 首页需求带进新项目的对话草稿 |
| `0492c77` | 编辑器文案「受理/回执」改为「已提交/结果」 |
| `48c60bb` | 分层失败卡片提供「用同样设置重新分层」（仍需手动提交） |
| `08c85a5` | 生成结果自动放上画布 |
| `b8e875a` `e73c42f` | 文档 |
| `24e92b0` | 生成卡片显示「已应用 N 条品牌规则」 |
| `059d62c` | 按 10-19 反馈收拢画布与对话（见 `development-report-2026-10-19-canvas-conversation.md`） |
| `09c0043` | 句中提问不再触发生成；首页文案去术语 |

## 1. 推送（需要帅帅同意）

**必须先得到帅帅明确同意再推。** 推送 `devUpdate1012` 会触发 CDS 自动部署到预览环境。

仓库规则（`CLAUDE.md`）：

- 提交信息不要带 `[skip cds]` 一类跳过标记
- 新克隆先运行 `node scripts/install-cds-push-guard.cjs`
- 改 `cds-compose.yml` 要人工审批。本批改动没有碰它
- 健康检查用 `/api/health`

推送后：

1. 确认 CI 通过，CDS 部署的版本等于 HEAD。
2. 在预览环境登录，做一遍只读走查：打开已有项目，确认右侧只剩一个对话输入框；选中图片后能看到「修改」「AI 分层」；调整尺寸时比例锁可以用；新图排在已有内容下方。

这一步不需要调用模型。

## 2. 首页「开始创作」真实验收（会花钱，需单独授权）

`059d62c` 改了首页：点「开始创作」后会建项目，并**自动提交第一次生成**。这一步会真实调用模型、消耗额度。

**需要帅帅单独授权**，并确认每次验收最多调用几次模型。

验收项目：

- 只输入文字：项目创建，对话里出现用户消息和生成进度，结果自动放上画布
- 刷新页面：不重复提交
- 输入为空：只建项目，不生成

报告第 7 节说明这一步之前只用了合成后端，从未连真实服务。

## 3. 非方图分层失败（只读调查，先不改代码）

**现象**：反馈 PPT 第 2 页里一张街景图，「2 层分解」和「按内容拆分 3 层」都失败。报错来自 `apps/web/src/lib/studio-decomposition-images.ts` 的完整画幅校验：比例要求整数精确相等，并且图层不能大于原图。

**已知**：10-17 那张 1024×1024 方图的完整链路已经验收通过，见 `D:/coding/公司/DeepFlare-分层验收-2026-10-17/真实验收回执.json`。所以不是所有图片都会失败。

**要做的**：只读查出那次失败任务的原图尺寸、每个返回图层的尺寸和原始输出。`059d62c` 以后，错误信息里会带上这些尺寸，但旧任务里没有。

**不要做的**：

- 不要在拿到证据前放宽校验。差一像素也可能是裁切或填边造成的，硬拉伸会让图层错位。
- 不要为了调查重新付费调用模型。

拿到证据后，再决定是允许取整误差，还是按位置信息还原。

## 4. 剩余界面术语（纯开发，可以直接做）

生成、素材、任务提醒这几个界面脚本里还有 33 处「受理/回执」：

- `deploy/novart/studio/novart-product-generation.js`：16 处
- `deploy/novart/studio/novart-product-materials.js`：8 处
- `deploy/novart/studio/novart-product-bootstrap.js`：4 处
- `deploy/novart/studio/novart-product-task-inbox.js`：4 处
- `apps/web/studio-shell/studio.html`：1 处（`>确认原上传回执<`）

**统一说法**：「受理」改为「提交」；「回执」按语境改为「结果」或「信息」；恢复按钮统一叫「检查上次提交」「检查上次生成」「检查上次上传」。已有改法可以参考 `0492c77` 和 `09c0043`。

**有测试断言的两处**：`scripts/test-novart-layer-inbox.cjs` 引用了 `提交至回执用时` 和 `耗时待完成回执`，改文案时要同步改测试。

**查找命令**（改完后结果应为空）：

```bash
grep -noE "['\"\`>][^'\"\`<>]*(受理|回执)[^'\"\`<>]*['\"\`<]" deploy/novart/studio/*.js apps/web/studio-shell/*.js apps/web/studio-shell/*.html
```

不要改代码里的标识符、注释和接口字段，只改用户能看到的文字。

## 5. 待帅帅决定的事项

- **`task_plan.md`「部署预览后删除停用旧页面」**：标注了「用户仅本地，本轮不执行」。删页面前要先问帅帅。
- **「体验审查 P1 清单」**：统一生成入口、首页继续上个项目、对话冻结自动对账、额度显示。仓库里没有原始审查文档。其中统一生成入口已经由 `059d62c` 做掉；其余三项需要帅帅确认来源和优先级，再排期。

## 6. 本机门禁命令

```bash
cd D:/coding/公司/brandai-layer-ux
npx turbo run test --concurrency=1 --continue --force
(cd apps/ai && D:/coding/公司/brandai-devUpdate1012/apps/ai/.venv/Scripts/python.exe -m pytest -q -p no:cacheprovider)
pnpm -F web typecheck
(cd apps/web && npx eslint src --quiet)
pnpm -F web build:low-memory
node scripts/test-novart-owned-home-start.cjs
git checkout -- packages/ui/tests/__snapshots__/business.test.tsx.snap   # 测试会改写这份快照，跑完还原
```

注意事项：

- 当前工作区没有自己的 Python 虚拟环境，借用 `brandai-devUpdate1012` 的。
- 本机默认的 Playwright 浏览器缺失，浏览器用例改用本机 Chrome。
- `D:/coding/公司/私密账号` 存放账号，不要读取内容，也不要打印。

## 7. 已核对并关闭的事项

- **PSD 生产模块路径 + 真实下载**：已完成。10-17 的真实验收回执记录：commit `2492b43`，`psdHttpStatus` 为 200，9 层，`realProvider` 为 true，检查项包括 `real-psd-download-and-layer-structure-readback`。`handoff-remaining-2026-10-17.md` 里写的「PSD 仍返回 503」是更早的状态，已经过时。
- **故障原图完整链路**：同一份回执包含 `same-failing-source-readable-and-sha256-verified`、`real-analysis-and-layer-task-succeeded` 和 `real-layers-placed-saved-and-restored`，已完成。
- **真实库孤儿统计**：已由 10-17 集成发布覆盖，依据 `push-preflight-2026-10-17.md`。
