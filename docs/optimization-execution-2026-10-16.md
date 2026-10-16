# 优化执行记录 · 2026-10-16

依据：用户提供的 `D:/coding/公司/brandai-优化执行计划-2026-10-16.md`，并明确要求执行。起点为 `devUpdate1012@83a5dca`。原7份文档按原字节SHA复核后单独提交 `2cf3932 docs: record 2026-10-15 worklog`，没有改写内容。

## 执行边界

- 不访问私密账号目录；不读取或输出凭据，不调用付费模型，不启动本机Docker。
- 不合入devUpdate1012/main，不改cds-compose.yml，不执行共享/线上迁移或改密钥；这些按原计划在具体结果可审阅后另行确认。
- 普通Git提交/推送走现有门禁；当前阶段为 `fix/p1-remove-captured-bundle`。
- 阶段2–5从devUpdate1012建立独立分支。若需继承前阶段，先完成前阶段验收并按计划取得合入授权，不擅自将其视作已合并。
- 部署用平台返回的地址，核对同提交构建和实际运行，不使用文中历史域名模板。

## 阶段状态

| 阶段 | 状态 | 验收与交付 |
| --- | --- | --- |
| P1 自有shell迁移、移除抓取包 | 本地实现及复验通过；尚未推送/部署 | 删除前后四门禁全绿；目录删除单独提交d52b8a2。新阶段分支缺独立预览数据库，待确认隔离初始化后继续云端验收 |
| P2 安全 | 未开始 | storageKey、错误脱敏、管理员初始化、权限、上传、启动密钥校验 |
| P3 任务可靠性 | 未开始 | 异步预检、Abort、无自动付费重试、清理与轮询、生产存储 |
| P4 前端统一 | 未开始 | token、错误状态、导航/重定向先验证后删除旧页面 |
| P5 工程质量 | 未开始 | lint、契约、只读孤儿审计、隔离迁移、文档/测试归位 |

## 已发现的执行差异

1. 当前Branch Image及被调用工作流都有固定分支条件，阶段分支须精确接入，不能仅改push过滤。
2. 多尺寸任务计划最长37分钟；现有Generation清理器按createdAt10分钟失败，UI6分钟。P3需协调任务deadline/租约与展示等待，避免误杀活跃任务或误导重复收费。
3. 当前根目录无.dockerignore，镜像专用忽略文件在deploy/novart；以实际文件为准，不创建无作用配置。
4. P1迁移必须保留当前Studio品牌、上传、生成、保存确认、归档及账号设置交互；不能把旧抓取包复制到新目录充当迁移。

## P1 分工

- Shell owner：apps/web/studio-shell及exporter；不提前删除旧目录。
- Test/CI owner：迁移生产行为测试、替换纯旧包授权测试，接入精确阶段分支。
- Read-only reviewer：检查Docker、路由、脚本、构建及残留依赖。
- Root：静态资源/路由、集成、构建验收、分任务提交、删除前范围校验、发布与日志。

## 验证结果

删除前、删除后各完成一轮四门禁。删除后结果：contracts 1612、UI 34、AI 500全部通过，Web类型检查与生产构建exit0。AI有1条既有Starlette/httpx弃用警告；构建使用已有低内存开关，未启用本机Docker。构建中的本地服务连接告警不代表真实数据库/模型验收。

本轮测试等价执行说明：根脚本pnpm test调用turbo run test；Windows pnpm透传双横线出现参数歧义后，改用node node_modules/turbo/bin/turbo run test --force -- --maxWorkers=1 --minWorkers=1，强制实际运行无缓存。AI使用apps/ai/.venv/Scripts/python.exe -m pytest -q，等价于计划Unix虚拟环境入口。类型和构建实际执行pnpm -F web typecheck、pnpm -F web build。

```text
@brandai/ui:test:       Tests  34 passed (34)
@brandai/contracts:test:       Tests  1612 passed (1612)
 Tasks:    2 successful, 2 total
Cached:    0 cached, 2 total
500 passed, 1 warning in 5.12s
L1 test passed
AI test passed
Typecheck passed
Build passed
```

其它验收：
- 实际Chromium工作台6组共66项通过；删除后再验核心画布52、引擎9项通过。上传深链覆盖8种视口，正常打开素材面板，保留workspace/build参数，不异步强开系统文件选择器。
- 导出3、CI分支2、启动/SW迁移20、父窗口恢复7、归档6、首页交接协议11项通过。
- 重新导出24个自有资源，manifest.external为空；编译目录搜索lovart或lib-tldraw为0，git ls-files previews输出为空。
- 独立只读复核未发现构建/运行/CI残留依赖；历史文档已标记旧入口停用。
- 上述浏览器使用隔离的本地HTTP测试回执，只证明交互和真实文件编码，不冒充真实SQL/S3/模型质量。模型调用0。

本地证据：.novart-build/p1-after-delete-{test,ai,typecheck,build}.log；p1-after-delete-owned-browser.json、p1-after-delete-engine-browser.json；另有p1-{home-brand-leave,studio-layout,brand-switcher,brand-creation-recovery,handoff-pages,brand-library-shell}.json。

## 提交与远端边界

| 提交 | 内容 |
| --- | --- |
| 2cf3932 | 原7份日志按原字节单独保存 |
| e0725bd | 21个自有shell源文件、离线导出及启动适配 |
| 6ce5de0 | 移除无效canvas.html路由和旧授权入口 |
| 601a3c1 | 精确接入5个阶段分支CI，迁移测试 |
| d52b8a2 | 门禁通过后单独删除旧预览包176文件，清理镜像忽略项 |

CDS只读预检发现：项目a8a098f7193a启用githubAutoDeploy和push事件；P1分支尚不存在，默认Web/worker/AI模式是dev/release/release，项目DATABASE_URL默认数据库为brandai。现有dev的隔离覆盖不会自动证明新P1分支也隔离。因存在自动部署到共享库的风险，本轮尚未推送，未创建/部署CDS分支、未改配置/密钥、未执行线上迁移。此为配置边界，不是已确认CDS故障。

下一步具体方案：为fix/p1-remove-captured-bundle设置独立预览数据库brandai_p1_remove_captured_bundle、独立队列和存储前缀，使用已通过同提交CI的预构建镜像。不得复制旧分支的业务数据或直接继承共享库；空库表结构初始化属于线上迁移，按原计划0.8先取得帅帅确认。预览通过后，再单独确认是否合入devUpdate1012；main本阶段不动。

尚未验证：本阶段远端CI、镜像发布、公网/studio与/studio-editor；P2–P5。不能用昨天devUpdate1012@83a5dca的预览代替本阶段。

## 用户决定 · 2026-10-16

帅帅对P1独立预览环境确认问题选择「暂时只保留本地成果」。因此独立预览数据库初始化、CDS配置、推送和部署均暂不执行；上面的隔离发布方案保留为后续方案，不视为获得授权。P1实现与验证提交保留在本地fix/p1-remove-captured-bundle，不合入devUpdate1012/main。P2–P5状态不变，未实施。
