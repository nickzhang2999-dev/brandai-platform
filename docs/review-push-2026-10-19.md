# 2026-10-19 新增修改审查与推送记录

## 范围

用户授权：审查新修改，确认没有问题后推送远端。目标为现有 `origin/devUpdate1012`，本地仍在 `fix/layer-faint-and-model-prefix`，不合并 main，不发正式环境。

本次审查 `f791cd4`（非方图分层尺寸适配）、`78b3b88`（首页恢复记录按品牌分桶）；保留此前 `e69fea6` 的上传恢复、对话 r2 与交接改造，保留 `a2429f3` 文档提交。开始时工作区干净，fetch 后远端没有独有提交，本地领先 15 个提交。

## 发现和修复

1. **旧草稿的品牌归属不能由“没有项目”推断。** 原修改会把无项目记录自动交给第一个打开的品牌。无项目也可能是创建响应丢失。现仅自动迁移已通过当前品牌项目列表确认归属的记录；无归属记录原样保留、不提交、不阻塞新品牌，并给出提示。此类旧记录仍需确认原品牌后专门恢复，不能声称已自动找回。
2. **迁移需要原子性。** 原修改分三次操作读取、写入、删除，另一标签页可在中间保存新记录。现网络归属检查后，在一个 IndexedDB 写事务内重读两端、验证、写入并删除；已存在目标优先，源项目变化则停止，写入失败保留旧记录。新增回归先复现无归属自动迁移，再验证修复；真实 Chrome 覆盖双标签页与事务中止回滚。
3. **非方图适配只适用于对应模型。** 原修改对所有模型启用预测画幅。现要求持久化的模型调用回执为 `FalLayerProvider` + `fal-ai/qwen-image-layered`，其他模型仍执行原严格比例保护。取整与官方 Python ties-to-even 一致。

## 非方图依据

核对 [Qwen 的 Diffusers 实现](https://github.com/huggingface/diffusers/blob/main/src/diffusers/pipelines/qwenimage/pipeline_qwenimage_layered.py) 的 `calculate_dimensions` 及输入预处理：以 `resolution²` 为面积目标，宽高分别取整到 32 的倍数，再对整图 resize。640 档下，1920×2560 对应 544×736，与之前读取的真实返回尺寸一致；不是简单“允许相近比例”。[官方模型卡](https://huggingface.co/Qwen/Qwen-Image-Layered)也说明了 640 / 1024 档。

当前 Fal 调用未传分辨率覆盖，适配现有 640 档；不自动放行 1024 档或未知模型。实际解码仍检查大小、alpha、完整图组等，归一化至原图画幅。测试验证内容在画幅中的相对位置和透明度；它不证明模型语义分组质量，也不能还原被模型改画的细节。

## 本轮验证

| 检查 | 结果 |
| --- | --- |
| contracts / UI / Web 全量 | 306 / 39 / 1760 通过 |
| AI pytest | 597 通过，1 条既有依赖警告 |
| Web typecheck | 通过 |
| Web ESLint | 0 错误，14 条既有警告 |
| Next 生产构建（build:low-memory） | 通过 |
| 首页协议（包含迁移竞争） | 41 通过 |
| 首页 Chrome / 完整壳失败恢复 | 17 / 5 通过 |
| 对话 Chrome / 壳归档协议 | 52 / 6 通过 |

浏览器使用实际前端模块、DOM 和 IndexedDB，业务 API 为本地合成回执，外部请求与脚本错误为 0。没有把交互测试当成真实模型、数据库或在线验收。本轮付费模型调用 0；没有写线上业务数据、数据库迁移或修改模型配置。

## 推送与预览核对

正常 pre-push hook 已安装；沿用普通 Git push 和现有 CDS 自动部署，不跳过门禁、不重写历史。推送前 CDS 查询确认目标为 `brandai-platform-devupdate1012`，现运行 `2492b43`；预览 URL 由仓库 preview-url 脚本从 CDS 返回值取得：<https://devupdate1012-brandai-platform.geole.me/>。

本报告随修复提交。推送后须分别核对远端提交、镜像构建及实际预览版本，不能用 push 成功替代部署成功。本地证据：`.novart-build/review-1019-*.log`、`reports/home-creation-browser.json`、`conversation-browser-report.json`，发布回执另存 `.novart-build/review-1019-remote-status.json`。

模型主导意图的代码在此次推送范围内，但此前只读查到预览开关未启用；本轮不修改在线开关，也未开展新增付费模型评测。
