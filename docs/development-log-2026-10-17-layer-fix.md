# 2026-10-17 自动内容分层故障修复

## 已确认根因

线上最近两条AUTO任务在内容分析阶段失败，planning=FAILED、无结果、providerStartedAt为空，分层模型没有启动。AI容器的layer-plan请求返回502，安全日志中的上游状态为400。

实际视觉模型为gpt-5.6-sol；旧HttpVLMProvider固定发送max_tokens和temperature。一次极小原参数校验得到400、unsupported_parameter、param=max_tokens，上游要求max_completion_tokens。保持同一模型与配置，使用max_completion_tokens、low reasoning并去掉固定temperature后，一次极小校验得到200、有效JSON、finish_reason=stop。这两次是协议验证，不是图片分层质量验收。

官方接口资料：[Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[当前配置模型](https://developers.openai.com/api/docs/models/gpt-5.6-sol)。没有更换模型、密钥或CDS环境。

## 修改范围

- HttpVLMProvider按已知推理模型名称选择max_completion_tokens与low reasoning，不发送不兼容的temperature；原有其他模型请求格式保持。调用前确定参数，不增加失败后的付费重试。
- 视觉模型HTTP异常标记provider阶段，保留既有安全错误分类；无效、截断、空响应转为安全格式错误，不输出上游原文或密钥。
- 分层任务保留“内容分析/图层分解”阶段及授权、请求拒绝、限流、超时等可读原因，白名单HTTP状态可见，未知异常仍不泄露原文。
- 分层面板受理提示随对应任务轮询更新；FAILED时不再宣称任务继续，SUCCEEDED时显示可展开/下载。
- 保留原图、先分析后拆层、数据库单次调用认领、透明图层验证与按内容分组，不伪造图层，不重放用户失败任务。

## 验证

- Web1597、contracts293、UI34、AI557全部通过；typecheck及低内存生产build通过。
- lint为0错误、14项已有警告。
- 本地真实Chromium交互：正常分层流程10项，失败提示更新流程3项通过。使用隔离fixture，明确不是AI质量验收。
- 定向服务回归证明分析拒绝保留HTTP400、只分析一次、分层模型调用0；Python回归证明GPT-5请求格式与旧模型兼容、上游错误分类与单次调用边界。
- 上线后的真实图像分析、分层、保存恢复、PSD验收待回填。最多新增一次图像分层验收，不自动重新提交。

## 原理及边界

内容分析模型只提出语义分组与数量；真正分层模型输出RGBA图层，分离可见内容并可能重建被遮挡区域；系统验证透明度、尺寸、存储与归属，保存后将这些像素图层编码为PSD。PSD不是原设计源文件，扁平图中不存在的文字字体/矢量路径/遮挡细节不能保证精确恢复。元素数量也不等于有用图层数量：人物应保持完整，重复装饰可合组，必要时进一步拆分。
