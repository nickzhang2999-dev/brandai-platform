# Novart 独立评审同源写入 403 · 2026-10-09

本记录针对独立 CDS 前端评审项目，不代表产品集成分支、公司 `main` 或正式站已修改。当前线上仍运行 `f720c4449c7a873cc352f429017709deace1572f`。热修复及运行时配置尚未部署；浏览器连接失败，未完成用户实际创建画布路径验收。

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
| Branch Image 回归接入 | requirements 安装后执行 12 项 Origin 回归的步骤已加入工作流；该版 CI 尚未实际运行 |
| CDS webhook self-test dry-run | `[skip cds]` 返回 `ignored-skip-marker`，全部部署副作用字段为 `false` |
| 实际 push 与 CI | 待验证；dry-run 不能证明真实推送已被跳过或镜像已发布 |
| 修复镜像及公开 Origin 配置部署 | 未完成，线上仍为 f720c44 |
| 公网浏览器用户路径 | 浏览器连接失败，未验收 |

历史 Linux 容器、持久卷重建及公网资源检查见 [独立评审说明](novart-workbench-preview.md)。这些历史结果不作为本次热修复的镜像、配置或浏览器验收结果。

## 后续验收判据

1. 四项仓库门禁已通过；实际 push/CI 后核对跳过标记的真实处理结果，避免联动公司项目部署，并确认独立评审精确 SHA 镜像与容器检查结果。
2. 仅更新独立评审服务，保留原持久卷；确认运行提交、包指纹与 `NOVART_REVIEW_PUBLIC_ORIGIN` 均为本次目标值。
3. 公网同一无效路径探针带真实公开 Origin 时不再被 Origin 守卫拒绝；无关 Origin、伪造转发头及不合法 Origin 仍拒绝。
4. 通过真实浏览器完成创建画布、上传、保存、刷新重开和归档恢复；确认既有评审数据继续可用后，才能更新用户路径验收状态。浏览器连通性未恢复前保持“未验收”。
