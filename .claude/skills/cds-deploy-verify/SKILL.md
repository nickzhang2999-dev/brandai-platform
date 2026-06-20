---
name: cds-deploy-verify
description: >
  部署 BrandAI 到 geole.me 的 CDS 灰度并做端到端冒烟验证。当需要"把改动发到灰度
  / 部署 / 验证线上 / 真出图取证"时使用。封装了 push→deploy→等构建→登录冒烟→
  真出图的完整闭环,含 env 单键写入与"新代码上线"判据。绝不用 mock 当验收。
---

# CDS 部署 + 冒烟验证（BrandAI）

沙箱 env 已有 `CDS_HOST`、`AI_ACCESS_KEY`、`SSH_CDS_HOST`、`CDS_USERNAME/PASSWORD`，**别问用户要**。

## 关键坐标
- CDS API host：`cds.geole.me`，鉴权头 `X-AI-Access-Key: $AI_ACCESS_KEY`
- 项目：`brandai-platform`，**project id `a8a098f7193a`**
- 分支(CDS branch id)：`brandai-platform-claude-<分支slug>`，本线为 `brandai-platform-claude-brave-wright-2p3u3e`
- 灰度 URL：`https://brandai-platform-claude-brave-wright-2p3u3e.geole.me`
- `githubAutoDeploy=true`(push 会自动部署),但**显式触发更可控**。

## 一、部署（push 后）
```bash
H=cds.geole.me; K="$AI_ACCESS_KEY"; B=brandai-platform-claude-brave-wright-2p3u3e
git push origin <branch>
curl -sSk -m 40 -H "X-AI-Access-Key: $K" -X POST "https://$H/api/branches/$B/deploy" \
  | grep -oE '已拉取: [0-9a-f]+|"status":"(done|error|failed)"' | tail -3
```
HEAD 变了会全量 `next build`(~200s);仅 env/重启则秒级。**"部署成功"≠"新代码在跑"**——必须冒烟。

## 二、等"新代码上线"再验证（后台轮询，别空转 sleep）
判据按改动选：未登录 `GET /` 是否 307→`/login`(加了守卫时)、或 `/api/health` 出现新字段、或某端点反映新行为。用 `Bash(run_in_background)` 跑 `until` 轮询，命中即退出。

## 三、冒烟（每次部署后必做）
```bash
BASE=https://brandai-platform-claude-brave-wright-2p3u3e.geole.me
# 1) 健康：web/ai/worker 全 ok
curl -sSk "$BASE/api/health"   # 期望 {"web":"ok","ai":"ok","worker":{"worker":"ok","count":N}}
# 2) 登录(超管账号在聊天里,不进代码)→ csrf→callback/password→应 302
JAR=$(mktemp)
CSRF=$(curl -sSk -c "$JAR" "$BASE/api/auth/csrf" | python3 -c "import sys,json;print(json.load(sys.stdin)['csrfToken'])")
curl -sSk -b "$JAR" -c "$JAR" -X POST "$BASE/api/auth/callback/password" \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode "csrfToken=$CSRF" --data-urlencode "email=<admin-email>" \
  --data-urlencode "password=<admin-pass>" --data-urlencode "callbackUrl=$BASE/" \
  -o /dev/null -w 'login %{http_code}\n'   # 302=成功
# 3) 超管/接口：/api/admin/users 应 200;各 (brandai) 页应 200
```

## 四、CDS 项目 env（单键、安全、不破其它 26 个键）
读：`GET /api/env?scope=a8a098f7193a`(值遮罩)。写单键(用于配 provider/ADMIN_EMAILS 等)：
```bash
curl -sSk -H "X-AI-Access-Key: $K" -H 'content-type: application/json' \
  -X PUT "https://$H/api/env/<KEY>?scope=a8a098f7193a" -d '{"value":"<v>"}'
```
写后 `GET /api/env?scope=...` 核对键数不变。env 改动需 `deploy` 重启才生效。

## 五、真出图验收（No mock — CLAUDE.md §0.1 binding）
provider 在 `/admin/settings/ai`(加密入 DB,DB>env)。验收必须 真 provider→真 API→真 DB：
1. `POST /api/admin/settings/ai/test` 应返回真 provider(如 `openai OK · model=gpt-image-1`),不是 `mock`。
2. 建 Campaign(project)→`POST /api/workspaces/<ws>/generations`(202)→轮询
   `GET .../generations/<id>?jobId=<j>` 到 `SUCCEEDED`→校验 `versions[].imageUrl`
   是真图(gpt-image-1 出 ~2MB PNG;mock 只产极小占位)。
3. 截图/产出绝不能来自 `IMAGE_PROVIDER=mock`。

## 六、compose 改动
`cds-compose.yml` 改动同样经 `deploy` 生效(本 CDS 直接应用)。改 compose 后冒烟必须确认
`ai:ok`(内部路由没断)+ 相关行为。
