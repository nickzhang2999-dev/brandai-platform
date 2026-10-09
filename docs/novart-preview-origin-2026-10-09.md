# Novart 独立评审同源写入 403 · 2026-10-09

本记录针对独立 CDS 前端评审项目，不代表产品集成分支、公司 `main` 或正式站已修改。2026-10-09 15:45（Asia/Shanghai）确认线上已运行 `2db9229f03e0262e66ac7ff8c7465111d9cb166d`，可信公开 Origin 配置生效，公网 HTTP 验收通过。浏览器连接失败，真实鼠标/键盘操作仍未验收。

## 线上证据与归因

官方 CLI `branch list --project cd9d15b4c592` 返回独立评审分支处于 `running`，服务映射端口为 `15526`。官方 `previewUrl` 为 `https://novart-workbench-preview-claude-novart-workbench-preview.geole.me`，与既有私密评审入口的 origin 一致。评审入口 GET 返回 302 并签发评审 Cookie；本文不记录入口凭证或 Cookie。

在既有独立评审授权下，对不存在的 `/api/canva/project/__readonly_origin_probe__` 发送空 JSON POST。探针不创建、修改或删除业务数据，结果如下：

| 请求 Origin | HTTP 状态 | 应用结果 |
| --- | --- | --- |
| 不发送 | 503 | 通过访问和 Origin 检查，进入未知接口兜底 |
| 上述实际公网 origin | 403 | `Cross-origin write rejected` |
| `https://unrelated.invalid` | 403 | `Cross-origin write rejected` |
| `http://127.0.0.1:15526` | 503 | 通过 Origin 检查，进入未知接口兜底 |
| `http://localhost:15526` | 403 | `Cross-origin write rejected` |
| `http://127.0.0.1:8769` | 403 | `Cross-origin write rejected` |

503 在此只用于判定请求已越过 Origin 守卫，不代表业务 API 正常。官方 CLI 容器只读检查确认，线上 `harness/share_runtime.py` 仍执行以下判断：

```python
if origin and urlsplit(origin).netloc != self.headers.get('Host'):
    return self.send({'error': 'Cross-origin write rejected'}, 403)
```

这条严格比较与探针结果共同证明：代理传给应用的 `Host` 为 `127.0.0.1:15526`，正常浏览器却发送公开 HTTPS origin，于是同源写入被误拒。现有证据说明应用对反向代理的假设不成立，**没有证明 CDS 违反其平台契约，不能直接归因为 CDS 平台 bug**。

原正向 HTTP 检查不携带 `Origin`，只验证恶意跨域请求会被拒绝，未覆盖正常浏览器经过代理的请求。归因记为 **I（应用实现缺口）叠 O（验收覆盖缺口）**；接口检查通过也不能替代真实用户操作。

## 修复与配置要求

运行时通过 `NOVART_REVIEW_PUBLIC_ORIGIN` 或 `--public-origin` 接收唯一可信公开 origin，解析并比较协议、主机及有效端口。默认端口进行规范化；格式错误、重复 Origin、`null`、路径、通配符等输入不得扩展信任范围。配置来自服务端，不从 `Forwarded` 或 `X-Forwarded-*` 请求头自动建立信任。未携带 Origin 的既有 CLI/CI 请求仍须先通过评审访问鉴权。

未配置时保留直连 Host 校验。对当前 CDS 代理，**必须把修复镜像与 `NOVART_REVIEW_PUBLIC_ORIGIN` 一起部署并验证生效**；不能只修改源码或只设置变量就宣布修复。发布时从官方 `preview-url` 获取实际入口，环境变量只填其 origin，不带路径、尾部斜杠或凭证。若公开域名变更，应重新核对配置并部署。

本次改动只服务于 `claude/novart-workbench-preview` 的独立评审运行时，与后端产品集成分支分开。不导入根产品 compose，不更新公司 main，不修改共享数据库、共享 profile 或公司业务数据；继续复用独立评审持久卷，保留既有项目、图片和访问空间。

## 当前验证状态

| 检查 | 本轮结果与边界 |
| --- | --- |
| 本地真实 HTTP 回归 | 12 项通过；热修复 worktree 重跑退出码 0，耗时 8.79 秒；包含可信公开 Origin、反代 Host 和拒绝边界，不等同公网用户路径验收 |
| 包校验和 | 172 项通过 |
| L1 | 254 项通过 |
| AI pytest | 155 项通过 |
| Web typecheck | 退出码 0 |
| Web production build | 退出码 0 |
| Branch Image 回归接入 | CI 37899305284 成功；12 项 Origin 回归、172 项校验和、Linux 启动/鉴权/反代写入/持久卷重建通过后发布镜像 |
| CDS webhook self-test dry-run | 精确 SHA 的 push 为 ignored-skip-marker，workflow_run 为 workflow-acknowledged，全部部署副作用字段为 false |
| 实际 push 与 CI | GitHub push 成功；CDS 真实签名有效投递 b3ed84bf-02dc-4832-a17c-d9a35e3c7691 为 skipped，原因明确为 [skip cds]；公司三个分支回读未变 |
| 修复镜像及公开 Origin 配置部署 | dr_3483c099da752e5cf5fc1451 完成，运行提交 2db9229、prebuilt=true，1/1 服务健康且无 drift；容器内提交、包指纹及 Origin 回读一致 |
| 公网 HTTP 验收 | 76 项通过；实际 Origin 创建/上传/保存/重开、恶意 Origin 拒绝、57 个资源响应（含 CSS import 链）均已检查 |
| 公网浏览器用户路径 | 浏览器连接失败，未验收 |

镜像 digest 为 `sha256:76b263f16626016ac4bb0e9110bd9443262816a0536b4cfcb6d711f3b9590de3`；运行包 SHA-256 为 `35170856540ae75f374245271876e28c472e23f3096074a496a0ab0ac83bbadc`，公网 `/healthz` 与 [CI 37899305284](https://github.com/nickzhang2999-dev/brandai-platform/actions/runs/37899305284) 一致。只更新独立项目环境变量并按精确 SHA 部署，没有更改公司自动部署开关或导入根 compose。

公网脚本 `check_origin_online.py` 的正常 POST 均带真实 Origin，以稳定 requestId 幂等创建自己的 `HTTP origin check` 项目及 PNG，保存明确标注的原生格式存储样本；重跑读取同一项目，不重复创建或覆盖用户编辑。本轮样本保留，未删用户数据。10 月 8 日旧样本部署前已不存在（与历史清理记录一致），已明确 skipped，不能声称本轮验证了旧样本跨重建保留；新镜像的重建持久化由本轮 Linux CI 验证。

验收脚本首次误把合法的 32 字节 CSS `@import` 入口判为失败，已改为验证非空内容并递归检查导入样式，完整重跑通过；不是页面缺失。项目环境变量 PUT 后首次回读出现 WinError 10054，重新 GET 确认已生效，再部署，没有重复盲写。单次连接中断不归因为平台服务缺陷；浏览器插件连接失败也单独保留为验收限制。

## 后续验收判据

1. 从 CDS 右侧分支“预览”重新进入，复核创建画布、中文输入、拖拽、编辑、刷新重开及归档恢复。浏览器连通性未恢复前，不能把 HTTP 结果升级成鼠标/键盘验收。
2. 产品集成分支继续独立联调真实账号、DB、存储和 worker/provider；本评审版不是该后端的验收环境。
