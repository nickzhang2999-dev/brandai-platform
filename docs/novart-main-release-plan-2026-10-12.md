# Novart 核心合并与正式发布计划

日期：2026-10-12。用户已确认：**先把已验证的核心合并 main，再按优先级补齐产品能力。** 源码合并、独立预览部署、公司正式站发布分别验收，不能互相代替。

## 当前状态

- **最终更新：main账号/画布验收已完成。** 用户授权后新增专用普通账号与独立测试品牌；纠正main专用模式Next启动的公开origin，同4b88镜像最新run `dr_df058efa5e47ab986436e9c3` complete07:04:51Z。真实UI13项（文字/画笔/组合/图层/保存重新登录恢复/SVG与PNG）通过，原12核心表在明确过滤新增作用域后保持。CDS主列表按钮仍可丢弃 `/studio`，请使用官方完整地址；正式站仍因非Git目录未发布。以下账号待补为早前状态。
- **最新：公司 main 已运行4b88。** 获用户授权后，run `dr_e4915a56693c53a5c4d379c3` 于06:40:25Z完成；不可变镜像、三容器完整SHA、33迁移及原12核心表保持通过，Web入口原生分支配置 `/studio`。main注册关闭且用户账号不在该预览库，真实登录后画布/保存恢复/导出仍待合法账号验收。正式预检已绑定该产物，唯一blocking仍为生产 target 目录非Git；未正式发布。下方“公司旧运行不变”是合并时历史状态。
- 核心已于05:41Z正常快进合并main，实际远端main与整合分支核心为 `4b88be6fd340bc090e02ca9bec1f562bb0ba42a0`。两真实签名CDS推送skipped，公司运行与共享infra保持；main基础CI38209036645与main镜像流水线38209036689均整轮成功，源码/容器两轮各API95/UI17、三镜像fullSHA发布通过，额外provider调用0。后续实际结果仅补整合分支文档，main保持已验证核心4b88；下方9dcc“未push”是本批合并前状态。
- 已部署独立核心：`55ffda3e29f40fba14e7fd78d4bddf39302e5d6f`；run `dr_748b9d7e343e16a9efc616ff` 于2026-10-12 05:10:25.528Z完成。三应用镜像和运行环境完整SHA一致，Garage固定55e原双卷healthy，公司七字段前后不变。
- 云端55ff源码和镜像内两轮API95/UI17均通过，部署后的runtime/入口与版本化bootstrap来源核对通过；**公网普通3项、禁用worker1项、已有激活worker但未控制页面2项，共6项全部通过**，当前revision28文档保持，业务写入和额外模型调用为0。
- 实际bootstrap摘要来自部署manifest（4cd3…）；本地7881…因映射key顺序不同，源码主体和语义map已严格匹配，不直接以本地整文件hash判线上旧版本。
- main流水线候选已提交为 `9dcc11ad403c36cb7f6f896faa0222ddb8231c94`，本地required L1 1000、Windows现有venv AI365、完整typecheck/build均exit0；此时**尚未push main，尚未正式发布**，不能将本地候选或55ff分支CI替代最终main SHA云端检查。
- 此前只读fetch的main基准为 `e99919a64cd212d5d1b083fd7210842a1962d935`；合并前仍须fresh读取并核对是否前进。
- main镜像流水线保留原preview job及完整source/container gate，代码merge命中paths。原公司source启动链未导出Studio资源；专用镜像已包含同批Next与manifest资源。正式目标怎样消费镜像或生成资源仍须核对。
- 正式preflight在补齐官方previewUrl后artifact pass；唯一blocking为 `/opt/brandai-platform-prod`非Git根目录，project-identity为旧target身份快照warn。公司repo绑定正确；没有改target或触发正式release。
- 公司Web profile release显式seed/db push，未改未执行；不能将该配置等同于内容尚未确认的正式SSH脚本。
- 原四项工作区状态保留，实际哈希保持，未修改或纳入本批提交：`cds-compose.yml`、`docs/10_需求调整归因表.md`、`docs/novart-workbench-preview.md`、`packages/ui/tests/__snapshots__/business.test.tsx.snap`。

## 核心完成证据与边界

| 版本 | 已实际完成 | 不代表 |
|---|---|---|
| `55e07ac` | 独立环境真实上传、单次真实图片生成、结果归档；同一受理任务续验完成加入画布、保存、重新登录恢复、SVG/PNG 一致。续验未再次上传或调用模型 | EXACT、真实整图修改、VLM 检查、识别、手册解析全部通过 |
| `68cb239` | 自研画布工具与高级属性保存恢复；绑定原项目的只读续验 5 项通过；旧 CDS 入口至新版首页、项目库、自研画布的真实浏览器验收 5 项通过 | 用户所有浏览器状态下均无启动故障 |
| `55ffda3` | [云端 CI 38203197224](https://github.com/nickzhang2999-dev/brandai-platform/actions/runs/38203197224) 成功，两轮API95/UI17；独立部署及三镜像/环境SHA、runtime/入口、实际manifest来源核对通过，公司七字段保持；三模式公网6项通过，工具栏稳定至少10秒，当前revision28不变 | 历史revision20从未变化，或公司main/正式站已发布 |

原先真实生成整轮在“上传素材列表应含生成图”的错误假设处失败，该记录保留；后续通过绑定原项目和原单次生成回执的续验完成剩余链路。上传列表目前只含上传素材，生成素材由任务结果与 Asset 读取接口提供，不把失败记录改写为整轮成功。

## 执行顺序与验收

### 1. 核心先合并 main

- [x] main 构建补丁已纳入明确本地候选 `9dcc11ad403c36cb7f6f896faa0222ddb8231c94`；P0未混入。尚未push/合并。
- [x] 公司 main 使用完整4b88 CI不可变镜像，资源清单与公网实际脚本绑定容器及Git源码；生产发布入口仍待适配和校验。
- [x] 本地候选required L1 1000、现有Windows venv AI365、Web typecheck/build已exit0。
- [x] 最终main精确4b88 SHA的source/container数据库、Worker、存储与UI完整CI38209036689通过，两轮各API95/UI17，三镜像完整SHA发布；不以旧55ff或integration对照代替。
- [x] 合并前再次读取远端main=e99919a，确认可快进；一次正常原子push至4b88，实际远端读回一致，保留四项原未提交文件与16项冻结哈希。
- [x] 精确4b88的四项官方dry-run与真实main/integration签名skipped回执已核对；公司现有三个部署记录、profiles与共享infra未变。main源码合并不触发公司旧seed/db push启动链。

### 2. 核心发布与启动问题收尾

- [x] 独立预览已固定55ff fullSHA、三镜像和实际容器manifest，公网bootstrap正文/源码主体/语义map已核对。
- [x] 公网三种真实浏览器场景共6项、版本URL及实际资源正文来源已验收。
- [x] 真实只读浏览器逐个验证普通冷/暖启动、旧 CDS 入口、禁止 Service Worker、已有 active 但未控制页面的情形；首页进入已有项目，自研工具栏稳定至少 10 秒，当前revision28文档不变。保留旧revision20差异和失败记录，不宣称历史内容未变。
- [ ] 正式环境先核对目标 profile、数据库/Redis/对象存储作用域、加密材料、备份与可回滚版本；不复制或覆盖公司共享业务数据。
- [ ] 明确新增迁移先于依赖它们的 Worker 启动。五个新增迁移主要是表、索引和字段，但仍需按正式环境流程执行和核验。
- [ ] 正式发布后分别核对正式站运行 SHA、登录、新首页、已有项目、保存恢复和导出；独立预览通过不能替代此项。

### 3. P0：完整品牌知识 → 识别/手册解析 → 用户管理

按顺序完成，独立列出验收结果：

1. **完整品牌知识**：新工作台可进入同一 workspace 的规则库；规则新增、编辑、删除、确认/拒绝、版本恢复、规则级禁用规范和禁用/慎用词持久化。WorkbenchBrandDraft 转为待确认 BrandRule，明确显示同类型确认会替换旧规则；未经确认的草稿不能冒充生成约束。
2. **品牌识别与手册解析**：复用现有异步任务和 Worker，真实 VLM 缺配置时明确不可用。受理后刷新/离页可恢复，失败及超时有出口；解析证据、裁图和草稿真实入库。真实图片识别、真实 PDF 解析各自验收，不能用图片生成成功代替。
3. **用户管理**：在同一产品域名提供 `/manage/login` 和独立管理页面；明确管理员与普通用户边界，登录回跳、服务端权限、用户操作及审计一致。此路径是确认的待实现范围，不宣称现已上线。

所有 P0 均要求跨 workspace 访问被拒绝、低权限用户不能写入、刷新和深链仍指向同一品牌；不因复用旧组件而继承 owner-only 页面限制或缺失权限校验。

### 4. P1：蒙版与分层

- [ ] 蒙版编辑、保存恢复和实际修改任务绑定同一图片版本；失败保留原图与草稿。
- [ ] 图层拆分真实异步处理，图层顺序、素材引用、保存恢复和导出正确；服务未配置时不提供假成功。

### 5. P2：Campaign Kit 与模板/素材库

- [ ] Campaign Kit 从明确项目和品牌规则生成任务，进度、失败、结果归属及计量一致。
- [ ] 模板与素材库可检索、引用、复用并正确持久化，跨品牌隔离；模板套用与生成结果可追踪。

**审核运营：待排期和验收范围确认。** 不计入当前核心完成度，也不以已有管理页面代替完整审核、发布和运营流程。

## 发布目标不能混淆

| 目标 | 作用与更新方式 | 本计划中的状态 |
|---|---|---|
| 独立 Novart 产品预览 | `novart-product-integration-claude-novart-product-integration.geole.me`，独立产品项目与配置，用于验证候选 | 55ff已部署且runtime/manifest通过；三种公网浏览器模式共6项通过 |
| 公司 main 分支预览 | `https://main-brandai-platform.geole.me/studio`；完整4b88 immutable镜像 | 最新dr_df058运行/来源配置通过，专用普通账号及真实UI13项、原数据保持均已验收；主列表按钮丢路径未修，须完整链接 |
| 公司正式站 | `www.novartlab.com`；仓库记录的 CDS 发布目标为 `brandai-novartlab-local-prod`，通过 SSH 执行 `./cds-release-novartlab.sh` | 需重新核对实际 target/profile、发布脚本和回滚信息；main 合并不等于正式发布 |

正式 target 信息依据仓库 `CLAUDE.md` §4 的发布说明，本计划未连接 SSH 或执行发布。平台强制审批按真实返回处理；配置缺失、待审批、未测试项目均如实保留。
