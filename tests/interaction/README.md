# 画布交互真测 harness（本地 localhost · 沙箱可跑）

> 为什么：`typecheck/build/L1` 不碰指针/焦点/路由，画布交互 bug 只有真浏览器点一遍才暴露。
> 背景与 bug 模式见 [`docs/11_前端画布交互经验与本地真测.md`](../../docs/11_前端画布交互经验与本地真测.md)。
> 改 `apps/web/src/app/(brandai)/workspace/OpenCanvas.tsx` / `page.tsx` 后，**先把这个跑绿再交付**。

沙箱 MITM 代理会关掉 Chromium 到外网预览域；`localhost`/`127.0.0.1` 在 noProxy → 本地起栈直连是唯一能自测交互的路径。

---

## 一键流程

### 0) 依赖
```bash
npm i -D playwright-core            # 仓库未默认带；沙箱 chromium 在 /opt/pw-browsers
```

### 1) 起栈（无 docker；postgres 必须以 postgres 用户跑）
```bash
PGBIN=/usr/lib/postgresql/16/bin; PGDATA=/var/lib/postgresql/brandai-pgdata
sudo -u postgres $PGBIN/initdb -D $PGDATA -U postgres --auth=trust -E UTF8     # 首次
sudo -u postgres $PGBIN/pg_ctl -D $PGDATA -l /var/lib/postgresql/pg.log -o "-p 5432" -w start
psql -h 127.0.0.1 -U postgres -c "CREATE ROLE brandai LOGIN PASSWORD 'brandai' SUPERUSER;" || true
psql -h 127.0.0.1 -U postgres -c "CREATE DATABASE brandai OWNER brandai;" || true
redis-server --port 6379 --daemonize yes

cat > .env <<'EOF'
DATABASE_URL="postgresql://brandai:brandai@127.0.0.1:5432/brandai?schema=public"
REDIS_URL="redis://127.0.0.1:6379"
AUTH_SECRET="dev-secret-local-e2e"
AUTH_URL="http://localhost:3000"
AUTH_ALLOW_DEMO="1"
ADMIN_EMAILS="you@example.com"
AI_SERVICE_URL="http://localhost:8000"
IMAGE_PROVIDER="mock"
VLM_PROVIDER="mock"
QUOTA_V1="0"
NEXT_PUBLIC_ASSET_PROXY="0"
EOF

pnpm db:push && pnpm db:seed                                   # throwaway 库用 push，别用 migrate dev(会交互卡住)
(cd apps/ai && IMAGE_PROVIDER=mock VLM_PROVIDER=mock ./.venv/bin/uvicorn app.main:app --port 8000 &)
pnpm -F web worker &
pnpm -F web dev &                                              # 等日志出现 "Ready in" 再继续
```
> dev server 陷阱：验证修复时若"没生效"，先怀疑在测旧代码。**杀干净再起**：
> `pkill -9 -f next-server` → `rm -rf apps/web/.next` → 重启 → 等 `Ready in`。别信"秒起"的 WEB UP。

### 2) 登录 + 造数据（拿 WS / PROJECT / GEN / token）
```bash
B=http://127.0.0.1:3000; J=/tmp/ck.txt; rm -f $J
CSRF=$(curl -s -c $J "$B/api/auth/csrf" | python3 -c "import sys,json;print(json.load(sys.stdin)['csrfToken'])")
curl -s -b $J -c $J -L -X POST "$B/api/auth/callback/credentials" -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode "csrfToken=$CSRF" --data-urlencode "email=you@example.com" --data-urlencode "callbackUrl=$B/workspace" >/dev/null
WS=$(curl -s -b $J -X POST "$B/api/workspaces" -H 'content-type: application/json' -d '{"name":"测试","industry":"F&B","websiteUrl":"https://example.com"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
PROJECT=$(curl -s -b $J -X POST "$B/api/workspaces/$WS/projects" -H 'content-type: application/json' -d "{\"workspaceId\":\"$WS\",\"name\":\"C\",\"campaign\":\"c\",\"product\":\"p\",\"channel\":\"电商\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
GEN=$(curl -s -b $J -X POST "$B/api/workspaces/$WS/generations" -H 'content-type: application/json' -d "{\"projectId\":\"$PROJECT\",\"sceneType\":\"ECOM_MAIN\",\"sellingPoint\":\"x\",\"scene\":\"门店\",\"versionCount\":3}" | python3 -c "import sys,json;print(json.load(sys.stdin)['generation']['id'])")
TOKEN=$(grep authjs.session-token $J | tail -1 | awk '{print $NF}')
echo "WS=$WS PROJECT=$PROJECT GEN=$GEN"   # 等几秒让 mock 出图到 SUCCEEDED
```

### 3) 跑测
```bash
WS=$WS PROJECT=$PROJECT GEN=$GEN SESSION_TOKEN=$TOKEN OUT=/tmp \
  node tests/interaction/canvas-functions.mjs
```
预期：除「加图片上传」（本地无对象存储→500，部署环境正常）外全 PASS。

---

## 覆盖的功能
缩放（放大/缩小/100%/适配）· 无导航环抖动回归 · 放置（矩形/圆/文字）· 双击编辑文字 ·
拖拽 · 缩放手柄 · 图层（置顶/置底）· 方向键微移 · 删除（按钮 + Delete 键）·
选中变体→操作条 · 改色 arm（不立即出图）· 出图→真改图→新子版本 · 局部重画→蒙版层。
