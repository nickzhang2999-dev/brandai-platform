# Novart 联调记录 · Origin 403 与改图验收 · 2026-10-09

本记录区分独立前端评审修复与产品集成工作。集成分支为 `claude/novart-product-integration`；独立前端修复已推送到 `claude/novart-workbench-preview`。本轮推进的是联调与验收准备，不代表最终产品已经集成完成、部署完成或通过真实用户验收。

## 独立评审 Origin 403

线上评审版本 `f720c4449c7a873cc352f429017709deace1572f` 对写请求直接比较 `Origin.netloc` 和 `Host`。反向代理传给应用的 `Host` 为 `127.0.0.1:15526`，正常浏览器的 Origin 为官方公开评审域名，两者不一致，导致创建画布被误拒为 `403 Cross-origin write rejected`。

既有评审 Cookie 下，对不存在的 API 路径发送空 JSON POST，不产生业务写入：无 Origin 时进入 503 路由兜底；真实公开 Origin 返回 403；`http://127.0.0.1:15526` 进入同一 503 兜底；无关 Origin 被拒绝。容器只读检查确认线上存在上述严格相等比较。原正向 HTTP 验收未携带 Origin，遗漏了正常浏览器经过反向代理的条件。归因为应用 Origin 比较假设和验收覆盖缺口，不能据此认定 CDS 平台 bug。

修复提交 **`2db9229f03e0262e66ac7ff8c7465111d9cb166d` 已 push 并部署到独立前端项目**。[Branch Image CI 37899305284](https://github.com/nickzhang2999-dev/brandai-platform/actions/runs/37899305284) 成功，部署记录 `dr_3483c099da752e5cf5fc1451` 完成。容器回读提交、包 SHA 与可信公开 origin `NOVART_REVIEW_PUBLIC_ORIGIN` 一致，实际 prebuilt=true、1/1 服务健康，无 drift。本地 12 项 HTTP、172 项包校验和、L1 254、AI 155、Web typecheck/build 通过；Linux CI 也验证了反代写入及重建持久化。

15:45 公网 76 项 HTTP 检查通过：正常 POST 携带实际 Origin，创建/上传/保存/重开成功，外域、null 与伪造转发头仍拒绝，57 个资源响应及 CSS import 链检查通过。自己的幂等 `HTTP origin check` 存储样本保留，未删除用户数据。历史验收样本已在 10 月 8 日清理，本轮明确 skipped，未称其跨重建验证成功。公网浏览器连接仍不可用，所以没有将 HTTP 结果当成鼠标/键盘或 AI 验收。详细线上记录已在前端分支提交 `43f9542` 推送；运行镜像仍为已验过的 `2db9229`。

## 发布隔离证据

对上述精确 SHA 的 CDS live dry-run push 检查记录为 `ignored-skip-marker`，对应 `[skip cds]`；工作流通知记录为 `workflow-acknowledged`。相关部署副作用字段均为 `false`。这组结果说明相应检查未执行部署副作用，**工作流通知被接受不等于镜像构建或部署成功**。

公司 `main` 保持 `e99919a` 基线；本轮不修改公司 main、共享数据库或共享服务。独立评审配置及持久卷与产品集成环境分别处理，不通过覆盖公司共享 profile 或清空数据绕过问题。

实际 push 后已再次回读公司三个分支，其 `commitSha`、`githubCommitSha`、`ciTargetSha` 和 `status` 与 push 前一致。真实签名有效 webhook 投递 `b3ed84bf-02dc-4832-a17c-d9a35e3c7691` 的 dispatchReason 明确为 `[skip cds]`，不是只凭 dry-run 结论。该次独立评审热修复部署已单独完成。集成分支尚未据此推送或部署。

## 产品集成改图验收

`apps/web/scripts/verify-studio-ui.ts` 已做静态加固，目的是提高集成改图验收脚本的判定可靠性。**尚未跑通真实 provider 的端到端改图验收**，因此不能把脚本改动或静态检查写成真实改图能力通过，也不能由独立前端评审的 HTTP 回归推导产品后端闭环已完成。

2026-10-09 15:04（Asia/Shanghai）的只读配置 audit 对独立产品环境得到以下结果；该环境运行提交为 `847434758c7906565476a58e920000db39c78e8f`：

| 检查项 | 当时观察 |
| --- | --- |
| AI health | 正常 |
| `AppSetting` | 无记录行 |
| Image / VLM / Layer provider key | 未配置 |
| 对象存储配置 | 缺失 |
| 加密配置 | 存在；不记录具体值 |
| Audit 行为 | 不调用外部 provider，不写数据库 |

AI health 正常证明服务健康检查可用，不证明真实 provider、对象存储或改图链路已经可用。上述结果限定于该时间和该独立环境，不推断公司正式环境配置。真实 provider 与存储配置就绪后，仍需另行验收实际提交、异步执行、产物落库与存储、页面显示及刷新恢复。

## 工作区与待完成项

子智能体最初仅新增本文件。集成工作区原有四份未提交修改继续保留：`cds-compose.yml`、`docs/10_需求调整归因表.md`、`docs/novart-workbench-preview.md`、`packages/ui/tests/__snapshots__/business.test.tsx.snap`；本轮改图验收脚本及 Origin 修复属于另行合入的变更。未覆盖或回退上述既有修改；README 与最终运行状态由主任务统一更新。

| 项目 | 当前状态 |
| --- | --- |
| 独立前端 Origin 修复代码 | 已 push：`2db9229f03e0262e66ac7ff8c7465111d9cb166d` |
| 精确 SHA 的发布隔离检查 | 已取得跳过标记、通知确认及副作用全 false 的证据；实际 push 后公司三个分支的提交与状态字段保持不变 |
| 独立前端 Branch Image CI | 运行 `37899305284` 成功 |
| 独立前端配置与精确 SHA 部署 | 2db9229 + 可信 Origin 已生效，部署记录 dr_3483c099da752e5cf5fc1451 |
| 公网创建画布相关 HTTP 路径 | 76 项检查通过；真实浏览器鼠标/键盘操作仍未验收 |
| 集成改图脚本 | 静态加固已做，真实 provider E2E 未完成 |
| 独立产品真实 AI / 存储配置 | 15:04 audit 显示缺失，待后续处理与复核 |
| 产品整合与最终交付 | 仍在联调，本轮不宣称完工 |

## 本轮遇到的验收与环境问题

- 资源验收原先以大于 100 字节作为成功条件，误拒 32 字节的合法 CSS import 入口；已改为非空 + MIME + 递归 import 核验后重跑通过。这是验收脚本问题，不是资源缺失。
- 独立项目 Origin 环境变量 PUT 后首次 GET 回读遇 WinError 10054；重试 GET 确认成功后才部署，没有重复盲写。单次网络中断不能断言 CDS 平台服务有缺陷。
- 浏览器扩展 getTab/openTabs 仍报连接失败，遵守当前实例限制，没有换浏览器或启动 Computer Use。

## 与公司源码的本轮差异

产品后端本轮没有新增数据库或 provider 行为。集成分支增加了真实整图修改的验收链路与静态加固，复用已有 generation/归档协议；独立评审运行时增加严格的服务端 Origin 配置和回归测试。该 Origin 修复同步保留在集成 worktree，不用独立评审的文件存储代替公司后端。后续仍须提供独立环境的真实存储和 provider 配置，跑完整业务 E2E，才可评估产品上线。
