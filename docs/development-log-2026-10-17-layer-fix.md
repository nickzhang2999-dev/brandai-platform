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

## 部署回执

- 修复提交57c679556f704b27edd16855159279cb750a31b3，正常守卫推送到devUpdate1012。
- [Branch Image 39016728629](https://github.com/nickzhang2999-dev/brandai-platform/actions/runs/39016728629) 完整成功。
- CDS镜像状态在CI成功后仍为waiting，经官方dry-run/claim/deploy认领本次成功镜像；没有改环境、Compose或共享数据库。
- 部署运行dr_6395d3f5afa3e292ea4d1e5e，phase=complete、failure=null；版本dv_983275195eab5ffc1a0a9106，运行提交及CI目标均为57c6795。
- 真实单张验收已准备故障原图，通过正常登录及品牌/项目权限读取，SHA-256与故障收据一致；只复制到新验收项目，不改原项目。

## 真实验收发现的第二处阻断：淡透明图层

对故障原图副本只提交一次AUTO任务。实际HttpVLMProvider分析成功（5580ms），选择9组；FalLayerProvider返回9张PNG。数据库保留了规划和真实模型输出，但发布图层为0，卡在归档。

只读检查已生成图片：原图1024×1024，模型输出9张640×640；其中第2、3张alpha最大值为4/255，其余有明显内容。旧inspectStudioLayer及PSD编码器把alpha<64全部当成空白，导致拒绝整组。该问题是本产品校验逻辑，不能归咎CDS或说模型未调用。模型输出统一归一化到原画幅，放大不等于恢复原生1024细节。

修复：图层边界/是否为空按alpha>0；inkCoverage仍按既有64阈值衡量；保留所有真实像素、不放大透明度、不丢层。整个发布组仍须至少两层具有阈值以上的内容，并具有透明内容；全透明层、普通全不透明图组仍拒绝。PSD准备及独立编码线程同步修复。归档失败保留受控的本地校验原因，不泄露未知异常或模型地址。

注意：非零alpha只证明模型返回像素，不证明每一层都有独立语义；两张极淡结果可能是模型低质量输出，不能伪称9个完美独立元素。此轮不重新付费生成，而通过原有24小时归档恢复窗口重新保存已有结果。

新增回归：alpha=1/4/63完整保留、实际PSD二进制编码及读取后透明度不变、正常内容组保留附带淡层、全淡噪点组拒绝且原因可见。定向81项及完整Web1605/contracts293/UI34、AI557、types通过；lint0错误14项已有警告。低内存生产构建通过。本次部署/真实归档恢复结果随后记录。
