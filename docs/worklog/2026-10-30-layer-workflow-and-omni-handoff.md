# 分层工作流首批实施与 Omni 接续记录

日期：2026-10-30。工作区 `D:/coding/公司/brandai-layer-quality`，分支 `claude/layer-quality`，起点 `e5c01f79132f3b4e70737754a1110e379e9de6ea`。

用户确认按 Lovart 工作流方向实施，并要求为下一步修改 Omni 自动分析、图片审核留下接入口。参考原始 Skill 的场景判断和保护原则；不声称还原了 Lovart 服务端算法。

## 已落地

- 分层规划升级为 `semantic-layer-plan-r3`，TS / Python 同步校验。保留原图可见内容 caption，另外记录遮挡类型、判断依据、处理建议、保护项、投影归属。
- 草地等连续纹理、规则结构可建议合理补全；身份 / 商品结构、文字 / Logo、附着关系、透明反射内容不能被契约当作普通背景自动补全。模型仅提供建议，不能决定执行权限或宣称修复完成。
- r1/r2 历史记录直接读取，不补造新判断、不补跑付费分析。当前服务的健康检查要求同步升级到 r3，防止新 Web 与旧 AI 混用。
- 前端显示真实分析、拆分、检查保存阶段。精细设置折叠；旧任务按时间收进历史，当前及仍运行的任务保留可见，旧 403 不占据本次主结果。
- 对照增加深浅底色、2/4 倍放大、预览中移开任一图层；方便检查草地补丁、孤立投影、alpha 杂点。预览操作不改画布、不调用模型。
- 分开标记存储成功、重合成像素初检、独立图层尚未审核。专门的背景修复没有运行，明确显示 `NOT_PERFORMED`。
- Omni 新增版本化的分析 / AI 审核建议 / 人工审核 / 权限契约与资格检查函数，具有 Python 镜像和测试。它是后续适配入口，尚未成为线上接口或发布门禁。详见 [接续约定](../omni-analysis-review-extension.md)。

## 当前实际依赖

通过已有 CDS 登录只读查询本分支 `studioImageToolCapabilities()`：`removeBackground.available=false`，`inpaint.available=false`。未修改开关、模型或凭据，未发起付费调用。

因此本批没有做到“足球移开后草地已自然修复”。原始足球 RGBA 的基线验证、可信蒙版、局部背景修复、关联投影处理、按需澄清及局部版本返工仍未完成。必须先验证可用的编辑能力及调用预算，再用真实样本验收；仅有建议和前端预览不能代替该步骤。原计划 A–D 不能标成整体完成。

`SKILLS_DESIGN_16.md` 的场景卡片与上述执行能力是两层内容，本轮没有一次性铺开 16 套页面。

## 验证

- `pnpm test`：contracts 332、UI 42、Web 2196 通过；Web 31 项原有测试跳过（2 个文件）。
- `pnpm test:ai`：767 通过。使用已有 `brandai-workbench-preview/apps/ai/.venv/Scripts/python.exe`；当前工作区没有独立 venv。
- Web typecheck、production build 通过。
- `cds-release.sh check` 与 `scripts/test-project-release.mjs` 通过；Windows 使用 `D:/Git/bin` 的 Git Bash，系统 WSL Bash 不可用。
- Chrome 14 项交互检查通过，报告：`.novart-build/layer-quality-interactions/report.json`。使用生产组件和本地合成 PNG，验证交互与 alpha 像素，不代表真实模型质量或线上授权验收。

没有数据库迁移、线上变更、模型切换、Omni 调度修改或自动扩量。

## 接下来的实施顺序

1. 明确并小样验证当前账户的蒙版编辑 / 主体提取能力，拿到足球原图和原始 RGBA 基线。
2. 接主体蒙版、局部补全和投影策略；蒙版外回贴原像素；保存源图与修复版本关系。
3. 对确实需要参考的内容补持久化澄清步骤；普通背景不反复询问。
4. 用原计划八类样本复核独立图层和真实编辑行为，再决定上线。不能用合成图测试宣布草地质量已解决。
5. 用户切回 Omni 时，从上述独立接续文档继续，保留两边代码与任务边界。
