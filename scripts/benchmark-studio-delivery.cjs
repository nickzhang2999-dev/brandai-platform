const path = require("path"),
  fs = require("fs"),
  crypto = require("crypto");
const { chromium } = require(
  path.join(process.cwd(), "apps/web/node_modules/playwright"),
);
const dir = process.env.DF_LOCAL_RUN;
if (!dir || !path.isAbsolute(dir))
  throw Error("DF_LOCAL_RUN must point to an isolated local fixture");
const { port, tag } = JSON.parse(fs.readFileSync(path.join(dir, "run.json")));
const env = Object.fromEntries(
  fs
    .readFileSync(path.join(dir, "private-runtime.env"), "utf8")
    .trim()
    .split(/\r?\n/)
    .map((s) => [s.split("=")[0], s.slice(s.indexOf("=") + 1)]),
);
if (
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535 ||
  !/^dfp0-[a-z0-9-]+$/.test(tag)
)
  throw Error("invalid isolated runtime");
const base = "http://127.0.0.1:" + port,
  editor =
    "/studio-editor?workspaceId=bench_brand&projectId=" +
    encodeURIComponent(process.env.REVIEW_PROJECT || "bench_project") +
    "&surface=canvas";
const file = path.join(dir, "browser-" + process.env.REVIEW_PROJECT + ".jsonl");
if (fs.existsSync(file)) throw Error("sample already exists");
const startedAt = Date.now();
if (!/^perf_[a-z0-9]+$/.test(process.env.REVIEW_PROJECT || ""))
  throw Error("expected isolated project");
function record(type, data = {}) {
  fs.appendFileSync(
    file,
    JSON.stringify({ t: Date.now(), type, ...data }) + "\n",
  );
}
(async () => {
  const os = require("os"),
    profile = fs.mkdtempSync(path.join(os.tmpdir(), "df-p0-edge-"));
  const child = require("child_process").spawn(
    process.env.DF_BROWSER_PATH ||
      path.join(
        process.env["ProgramFiles(x86)"],
        "Microsoft/Edge/Application/msedge.exe",
      ),
    [
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      "--user-data-dir=" + profile,
      "--headless=new",
      "--window-size=1920,1080",
      "--disable-background-networking",
      "--no-first-run",
      "--disable-sync",
      "about:blank",
    ],
    { stdio: "ignore", windowsHide: true },
  );
  let browser, traceReader;
  try {
    const portFile = path.join(profile, "DevToolsActivePort");
    for (let i = 0; i < 150 && !fs.existsSync(portFile); i++)
      await new Promise((r) => setTimeout(r, 100));
    const [port, ep] = fs.readFileSync(portFile, "utf8").trim().split(/\r?\n/);
    if (!/^\d+$/.test(port) || !ep.startsWith("/devtools/browser/"))
      throw Error("browser startup");
    browser = await chromium.connectOverCDP("ws://127.0.0.1:" + port + ep, {
      noDefaults: true,
    });
    const context = browser.contexts()[0],
      page = await context.newPage();
    page.on("response", async (r) => {
      if (!/conversation|generation|document|assets.*raw/.test(r.url())) return;
      const u = new URL(r.url());
      try {
        const j = r.headers()["content-type"]?.includes("json")
          ? await r.json()
          : {};
        const pick = (x) => ({
          requestId: x?.requestId,
          generationId: x?.generationId,
          mutationId: x?.mutationId,
          messageId: x?.messageId,
          status: x?.status,
          error:
            typeof x?.error === "string" ? x.error.slice(0, 150) : undefined,
          sourceShapeId: x?.sourceShapeId,
          revision: x?.revision,
          results: x?.results?.map((y) => [
            y.assetId,
            y.versionId,
            y.assetSha256,
          ]),
        });
        record("http", {
          url: u.pathname,
          status: r.status(),
          method: r.request().method(),
          ...pick(j),
          messages: j.messages?.map((m) => ({
            ...pick(m),
            generation: pick(m.generation),
          })),
          tasks: j.requests?.map(pick),
        });
      } catch {}
    });
    let stage = "login",
      injected = false,
      recovered = false,
      armed = false;
    page.on("requestfinished", async (req) => {
      const url = new URL(req.url());
      const m = /\/assets\/([^/]+)\/raw$/.exec(url.pathname);
      if (!m) return;
      try {
        const res = await req.response();
        if (
          res.status() !== 200 ||
          !(res.headers()["content-type"] || "").startsWith("image/")
        )
          return;
        const bytes = await res.body();
        if (bytes.length)
          record("asset_readable", {
            asset: m[1],
            sha: crypto.createHash("sha256").update(bytes).digest("hex"),
            at: Math.round(req.timing().startTime + req.timing().responseEnd),
          });
      } catch {}
    });
    await page.exposeFunction("p0visible", (x) => record("canvas_visible", x));
    await page.exposeFunction("p0click", (x) => record("click", x));
    await page.addInitScript(() => {
      const seen = new Set();
      setInterval(() => {
        if (document.hidden) return;
        const scene = document.querySelector("[data-testid=owned-canvas]");
        if (!scene) return;
        for (const item of scene.querySelectorAll(
          "[data-owned-id][data-kind=image]",
        )) {
          const el = item.querySelector("image,img"),
            src = el?.getAttribute("href") || el?.getAttribute("src");
          if (!src || seen.has(src)) continue;
          const asset = /\/assets\/([^/]+)\/raw/.exec(src)?.[1];
          if (!asset) continue;
          function visible() {
            const a = el.getBoundingClientRect(),
              b = scene.getBoundingClientRect();
            return (
              el.isConnected &&
              !document.hidden &&
              el.checkVisibility({
                checkOpacity: true,
                checkVisibilityCSS: true,
              }) &&
              Math.min(innerWidth, a.right, b.right) >
                Math.max(0, a.left, b.left) &&
              Math.min(innerHeight, a.bottom, b.bottom) >
                Math.max(0, a.top, b.top)
            );
          }
          if (!visible()) continue;
          seen.add(src);
          const img = new Image();
          img.src = src;
          img
            .decode()
            .then(() =>
              requestAnimationFrame(() => {
                if (!visible()) {
                  seen.delete(src);
                  return;
                }
                window.p0visible({
                  asset,
                  shape: item.dataset.ownedId,
                  at: Date.now(),
                  width: img.naturalWidth,
                  height: img.naturalHeight,
                });
              }),
            )
            .catch(() => seen.delete(src));
        }
      }, 100);
    });
    await page.route("**/studio/generation?**", async (route) => {
      if (
        route.request().method() !== "GET" ||
        !armed ||
        new URL(route.request().url()).searchParams.has("requestId")
      )
        return route.continue();
      if (!injected) {
        injected = true;
        record("injected503");
        fs.writeFileSync(path.join(dir, "release-siblings"), "1");
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: '{"error":"local-read-fault"}',
        });
      }
      return route.continue();
    });
    page.on("response", (r) => {
      if (
        injected &&
        !recovered &&
        r.status() === 200 &&
        new URL(r.url()).pathname === "/studio/generation" &&
        r.request().method() === "GET"
      ) {
        recovered = true;
        record("read_recovered");
      }
    });
    try {
      await page.goto(
        base + "/login?callbackUrl=" + encodeURIComponent(editor),
      );
      await page.locator("#login-email").fill("owner@example.invalid");
      await page.locator("#login-password").fill(env.LAB_LOGIN);
      await page.locator("form button[type=submit]").click();
      await page.getByTestId("owned-canvas").waitFor({ timeout: 120000 });
      // Observe first authorized read separately from the editor's normal query and HTTP cache.
      traceReader = require("child_process").spawn(
        "docker",
        ["exec", tag + "-app", "tail", "-n", "0", "-F", "/tmp/p0-worker.log"],
        { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
      );
      const traceLines = require("readline").createInterface({
        input: traceReader.stdout,
      });
      traceLines.on("line", async (line) => {
        const label = "[studio-delivery] ";
        if (!line.startsWith(label)) return;
        try {
          const event = JSON.parse(line.slice(label.length));
          fs.appendFileSync(
            path.join(dir, "worker-stage-events.jsonl"),
            JSON.stringify(event) + "\n",
          );
          if (
            event.stage !== "asset_persisted" ||
            !/^[a-zA-Z0-9_-]+$/.test(event.assetId)
          )
            return;
          const response = await page.request.get(
            base +
              "/api/workspaces/bench_brand/assets/" +
              event.assetId +
              "/raw",
          );
          const bytes = await response.body();
          record("read_probe", {
            requestId: event.requestId,
            asset: event.assetId,
            status: response.status(),
            at: Date.now(),
            sha: response.ok()
              ? crypto.createHash("sha256").update(bytes).digest("hex")
              : null,
          });
        } catch {
          record("probe_error");
        }
      });
      const prompt = page.getByRole("textbox", {
        name: "对话设计需求",
        exact: true,
      });
      async function send(n, text) {
        stage = "submit-" + n;
        await page.getByRole("tab", { name: "对话改图", exact: true }).click();
        await prompt.fill(text);
        const res = page.waitForResponse(
          (r) =>
            r.request().method() === "POST" &&
            new URL(r.url()).pathname.includes("studio-conversation") &&
            !r.url().includes("/draft"),
          { timeout: 45000 },
        );
        record("input", { n });
        const button = page.getByRole("button", { name: "发送", exact: true });
        await button.evaluate(
          (b, n) =>
            b.addEventListener(
              "click",
              () => window.p0click({ n, at: Date.now() }),
              { capture: true, once: true },
            ),
          n,
        );
        await button.click();
        const r = await res;
        const j = await r.json();
        record("submit", {
          n,
          status: r.status(),
          messageId: j.messageId,
          mutationId: j.mutationId,
        });
        if (!r.ok()) throw Error(JSON.stringify(j).slice(0, 260));
      }
      const msgs = [
        "生成一张正方形海报，米白底，中央红色实心方块。编号 DFJ1",
        "生成一张正方形海报，米白底，中央蓝色实心圆。编号 DFJ2",
        "生成一张正方形海报，米白底，中央绿色三角形。编号 DFJ3",
      ];
      for (let i = 0; i < 3; i++) await send(i + 1, msgs[i]);
      armed = true;
      stage = "foreground-read-recovery";
      for (let i = 0; i < 120 && !recovered; i++)
        await page.waitForTimeout(250);
      if (!recovered) throw Error("no foreground recovery");
      stage = "no-touch-visibility";
      await page.waitForFunction(
        () =>
          document.querySelectorAll(
            "[data-kind=image] img,[data-kind=image] image",
          ).length > 0,
        {},
        { timeout: 60000 },
      );
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
      const other = await context.newPage();
      await other.bringToFront();
      const { windowId } = await cdp.send("Browser.getWindowForTarget");
      if (!(await page.evaluate(() => document.hidden)))
        await cdp.send("Browser.setWindowBounds", {
          windowId,
          bounds: { windowState: "minimized" },
        });
      for (
        let i = 0;
        i < 35 && !(await page.evaluate(() => document.hidden));
        i++
      )
        await new Promise((r) => setTimeout(r, 100));
      record("background", {
        observed: await page.evaluate(() => document.hidden),
      });
      await cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "normal" },
      });
      await page.bringToFront();
      await page.waitForFunction(() => !document.hidden, null, {
        polling: 100,
        timeout: 6000,
      });
      record("foreground", { observed: true });
      await other.close();
      stage = "wait-second-and-third";
      const images = page.locator("[data-kind=image][data-owned-id]");
      await images.nth(1).waitFor({ timeout: 75000 });
      const imageInfo = async () =>
        images.evaluateAll((nodes) =>
          nodes.map((n) => ({
            id: n.getAttribute("data-owned-id"),
            url:
              n.querySelector("image")?.getAttribute("href") ||
              n.querySelector("img")?.getAttribute("src"),
          })),
        );
      async function savedAssets() {
        const items = await imageInfo();
        for (const a of items) {
          if (a.url) {
            const r = await page.request.get(new URL(a.url, base).href);
            const bytes = await r.body();
            a.sha = crypto.createHash("sha256").update(bytes).digest("hex");
          }
        }
        return items;
      }
      let rows = await savedAssets();
      const events = fs
        .readFileSync(path.join(dir, "model.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse);
      const second = rows.find(
        (x) =>
          x.sha ===
          events.find(
            (x) =>
              x.n === 2 &&
              x.event === "returned" &&
              x.t * 1000 > startedAt - 100,
          )?.sha,
      );
      if (!second)
        throw Error("second not matched by hash " + JSON.stringify(rows));
      record("before-edit", { rows });
      await page.getByText("适合画布", { exact: true }).click();
      await page.locator('[data-owned-id="' + second.id + '"]').click();
      stage = "select-second";
      const active = page.getByRole("button", {
        name: "取消修改对象",
        exact: true,
      });
      if (!(await active.isVisible())) {
        const join = page.getByRole("button", {
          name: "加入对话",
          exact: true,
        });
        if (await join.isVisible()) await join.click();
        const action = page.getByRole("button", {
          name: /设为修改对象|以此图修改|对话改图|修改此图/,
        });
        if ((await action.count()) === 1) await action.click();
      }
      await active.waitFor({ timeout: 6000 });
      await send(
        4,
        "修改这张蓝色圆形海报，只在圆心添加一条黄色横线，保持尺寸。编号 DFJ4",
      );
      await images.nth(2).waitFor({ state: "attached", timeout: 75000 });
      record("after-edit", { rows: await savedAssets() });
      fs.writeFileSync(path.join(dir, "release-one"), "1");
      stage = "reopen";
      for (let k = 0; k < 35 && (await images.count()) < 4; k++) {
        await page.getByText("适合画布", { exact: true }).click();
        await page.waitForTimeout(800);
      }
      await images.nth(3).waitFor({ state: "attached", timeout: 12000 });
      await page.getByText("适合画布", { exact: true }).click();
      await page.waitForTimeout(800);
      await page.waitForFunction(
        () =>
          document.querySelector("[data-testid=owned-editor]")?.dataset
            .saveState === "saved",
      );
      await page.goto("about:blank");
      await page.goto(base + editor);
      await page.getByText("适合画布", { exact: true }).click();
      await images.nth(3).waitFor({ state: "attached", timeout: 60000 });
      await page.waitForTimeout(1200);
      record("reopen", { rows: await savedAssets() });
      await page.screenshot({
        path: path.join(dir, "designer-" + process.env.REVIEW_PROJECT + ".png"),
      });
    } catch (e) {
      record("failure", { stage, error: e.message.split("\n")[0].slice(0, 220) });
      console.log(stage, e.message.split("\n")[0].slice(0, 200));
      process.exitCode = 1;
    }
  } finally {
    traceReader?.kill();
    if (browser) {
      const c = await browser.newBrowserCDPSession().catch(() => null);
      await c?.send("Browser.close").catch(() => {});
      await browser.close().catch(() => {});
    }
    child.kill();
    if (
      path.dirname(profile) === os.tmpdir() &&
      path.basename(profile).startsWith("df-p0-edge-")
    )
      await fs.promises
        .rm(profile, { recursive: true, force: true, maxRetries: 3 })
        .catch(() => {});
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
