# CDS 开发记录 · 2026-10-15

## 13:42 · 旧失败任务日志的证据边界

官方container-logs返回200，但当前AI容器日志不含04:33 UTC的旧改图任务；worker当前500行也未匹配。不能据此把图片模型502归责CDS。已确认的是产品错误转译丢分类；本轮修复产品链路，CDS未做配置改动。旧提取脚本中未锚定HTTP的429可能是堆栈行号，不能作为限流事实。[调查](ai-edit-failure-diagnosis-2026-10-15.md)。

本轮只涉及 `devUpdate1012` 开发预览，产品提交 `09fdf1809fc450dc07e5c2970e3c7094d076b38f`；main、正式站、部署配置和业务数据未改。

## 成功镜像回执尚未回填

10:50（上海）读取GitHub：Branch Image38671917506已completed/success，head_sha与本次提交匹配。同期CDS源码与ciTargetSha正确，但ciImageStatus=waiting、ciWorkflowRunUrl为空，currentVersionId仍为昨天的dv_c147eb7310aad04f906ea3e7。

这份观测只证明当时CDS尚未认领成功构建，不能单凭它断言webhook丢失、配置匹配错误或平台超时。也不能将正常构建等待解释为“CDS服务器性能造成画布bug”；今天修复的状态/撤销问题均有本地独立复现。

处理：先使用平台官方claim-prebuilt dry-run，核对相同提交与真实success工作流，再认领并部署现成镜像。未伪造CI结论、绕过审批、改CDS源码或强行服务器源码编译。

结果：运行dr_a957bf6b5ec83514ab26a498于10:52:29完成，phase=complete、failure=null，currentVersionId=dv_5d39edb6b80d089a5381013c。公网Web/AI/Worker均ok，Worker提交09fdf1809fc4；已有账号实际登录与Studio入口核验通过。此记录为发布后本地回执，下一批正常提交归档。

链接：[成功工作流](https://github.com/nickzhang2999-dev/brandai-platform/actions/runs/38671917506) · [开发预览](https://devupdate1012-brandai-platform.geole.me/studio) · [完整开发日志](development-log-2026-10-15.md)。

## 11:42–11:45 · 新修复镜像再次未关联
GitHub38676285703为5d75d50完成success，但CDS将同一目标标为timed_out_no_run；当前Git5141d25仅日志，按工作流paths不产生镜像。官方认领并部署成功镜像后，运行健康版本核对为5d75d50e195a。可以确认成功回执未关联，无法仅凭这些状态确认底层事件丢失原因。未修改CDS、伪造CI结论或绕过审批。

## 精简对话发布观察 · 13:30–13:34

ffc6198的Branch Image38685884784已success，但CDS仍waiting且ciWorkflowRunUrl为空；官方dry-run校验了相同SHA的成功工作流，经官方认领/部署运行新版，公网版本和前端JS均核验。仅此状态差异有证据，不能推断具体webhook故障。此前e0d3dc6的验收失败由本仓库UI测试未打开设置菜单引起，已修正，不归因CDS。


## 14:11–14:50 · 队列与数据库隔离不一致

新分支任务出现在main旧队列已有Redis证据。产品outbox扫描共享DB是串任务机制；CDS的db-isolation/db-probe只按服务声明判断，漏掉项目级DATABASE_URL实际使用，是第二层配置可观测性问题。增加POSTGRES_DB后可原生克隆，但模板连接串的库路径没有跟随per-branch库名改写；实际SQL发现后明确指定副本路径。Web/worker已读回独立库，main未重启。39张表克隆校验一致。不能归因“服务器慢”，也不能仅凭部署成功断言数据库切换成功。[具体证据与配置](devupdate1012-database-isolation-2026-10-15.md)。


15:22–15:26：9fde897成功工作流38696804512仍未自动关联CDS，官方dry-run及claim/deploy后完成。运行版本与独立库连接均读回正确，随后真实改图成功；不是仅配置界面显示成功。发布后回执本地补记。

## 17:43–17:46 · 引擎发布成功回执未自动关联

GitHub38713351613已completed/success、head_sha=83a5dcac58bec45e6051d7e2ab1cf952678f3e7d；同期CDS ciTargetSha相同但ciImageStatus=waiting、ciWorkflowRunUrl为空，旧运行仍9fde897。官方dry-run核验后claim/deploy完成dr_6711b362b962b0e6121871a7，公网新JS/健康提交和独立数据库均验证。只记录状态关联问题，不推断webhook底层根因；没有修改CDS源码、绕过平台审批或在CDS源码构建。完整证据见当日开发日志，本段为发布后本地回执。
