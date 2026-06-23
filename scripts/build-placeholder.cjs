// scripts/build-placeholder.cjs
//
// F-deploy · Readiness-window placeholder for the CDS cold build.
//
// geole.me CDS runs web as a synchronous chain (install → db:* → build →
// next start) and opens the port only at the final `next start`. A cold
// `next build` pushes that past CDS's ~248s readiness probe → the container is
// reaped before it ever serves → deploy deadlocks. scripts/web-build.sh starts
// THIS placeholder on $PORT for the duration of `next build` (guarded by
// CDS_BUILD_PLACEHOLDER) so the probe passes mid-chain; once the build finishes
// the placeholder is killed and the chain's `next start` reclaims the port.
//
// Every path returns 200 so any reasonable probe (TCP / 2xx / GET /api/health)
// is satisfied. Browsers get a self-refreshing "deploying" page.
const http = require("http");
const port = parseInt(process.env.PORT || "3000", 10);
const t0 = Date.now();

http
  .createServer((req, res) => {
    const secs = Math.round((Date.now() - t0) / 1000);
    const accept = req.headers["accept"] || "";
    if (accept.indexOf("text/html") !== -1) {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "retry-after": "5",
      });
      res.end(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
          '<meta name="viewport" content="width=device-width,initial-scale=1">' +
          '<meta http-equiv="refresh" content="5"><title>正在部署 · BrandAI</title>' +
          "<style>html,body{height:100%;margin:0}body{display:flex;align-items:center;" +
          "justify-content:center;font-family:system-ui,-apple-system,sans-serif;" +
          "background:#FAFAFC;color:#1e1e3c}.box{text-align:center;padding:2rem}" +
          ".spin{width:2.5rem;height:2.5rem;margin:0 auto 1.5rem;border:3px solid #ECECF3;" +
          "border-top-color:#7C5CFF;border-radius:50%;animation:s .9s linear infinite}" +
          "@keyframes s{to{transform:rotate(360deg)}}h1{font-size:1.15rem;margin:0 0 .5rem}" +
          'p{font-size:.85rem;color:#6a6a73;margin:.25rem 0}</style></head><body><div class="box">' +
          '<div class="spin"></div><h1>正在部署中…</h1>' +
          "<p>新版本正在构建并启动，页面将自动刷新。</p>" +
          '<p style="color:#9a9aa3">已等待 ' +
          secs +
          " 秒</p></div></body></html>",
      );
      return;
    }
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "retry-after": "5",
    });
    res.end(
      JSON.stringify({ status: "building", web: "building", elapsedMs: Date.now() - t0 }),
    );
  })
  .listen(port, "0.0.0.0", () =>
    console.log("[build-placeholder] listening on :" + port),
  );

process.on("SIGTERM", () => process.exit(0));
