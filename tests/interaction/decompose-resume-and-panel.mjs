/**
 * 第六 / 七轮 review 的三条行为红绿（一次性脚本，跑完随 PR 一起留档）。
 *
 *  A) 不透明度滑杆：拖到底再松手，落库的值必须是**松手的位置**。
 *     旧写法 `disabled={busy}` 会在第一次 onChange 发出 PATCH 后立刻禁用输入框，
 *     浏览器随即中断这次拖拽，值停在划过的第一个中间档。
 *  B) 客户端中间态上界到点之后：按钮必须仍然锁着（别让用户重复下单），
 *     `?decomposeTask=` 三个参数必须仍在地址栏（刷新还能接着跟）。
 *  C) 刷新续跑时任务 GET 抖了一下（502）：线索同样不许被删——「这次没问到」不等于
 *     「那一单不存在」。反过来服务端明确说 404 时必须收摊，两端都要验。
 *
 * **这是手动红绿驱动脚本，不是守卫**：它只打印观测值，不做断言，而且 B 那条要先把
 * `POLL_CAP_MS` 与 mock 分解耗时临时改短/改长才有意义（见下面的「怎么跑」）。别把它
 * 接进 CI —— 一个会静默空跑的绿灯比没有测试更糟。
 *
 * 怎么跑（前置起栈与登录见同目录 README.md，额外要 SET=图层组 id）：
 *   A) 直接跑：`ONLY=A node tests/interaction/decompose-resume-and-panel.mjs`
 *      读数看「服务端」那一栏 —— 松手位置是 0，落库就必须是 0。
 *      红：把 LayerPanel 的滑杆改回 `disabled={busy}` + onChange 直接 PATCH。
 *   B) 先临时改两处：`POLL_CAP_MS` 调到 5 秒、mock 的 `decompose()` 前加 25 秒 sleep，
 *      再 `ONLY=B node …`。到点后 URL 三个参数必须还在、按钮必须还锁着。
 *      红：把上界那条 effect 改回「`setDecomposeTaskId(null)` + `syncDecomposeTaskUrl(null)`」。
 *   C) 同样要先加 mock 的 25 秒 sleep，再 `ONLY=C node …`（502 抖动）、
 *      `MODE404=1 ONLY=C …`（一直 404）、`MODE404=2 ONLY=C …`（先抖后 404）。
 *      红：把续跑的 `.catch` 改回「任何失败都 `syncDecomposeTaskUrl(null)`」。
 */
import { chromium } from "playwright-core";
for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "ALL_PROXY", "all_proxy"])
  delete process.env[k];

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const EXE = process.env.CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const { WS, PROJECT, GEN, SESSION_TOKEN, ONLY } = process.env;
if (!WS || !PROJECT || !GEN || !SESSION_TOKEN) {
  // 缺环境变量就硬失败,不许"什么都没跑"还退 0。
  console.error("缺少 WS / PROJECT / GEN / SESSION_TOKEN，见同目录 README.md");
  process.exit(2);
}
const host = new URL(BASE).hostname;

const b = await chromium.launch({ executablePath: EXE, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await b.newContext({ viewport: { width: 1500, height: 950 } });
await ctx.addCookies([
  { name: "authjs.session-token", value: SESSION_TOKEN, domain: host, path: "/", httpOnly: true, secure: false, sameSite: "Lax" },
  { name: "brandai-active-brand", value: WS, domain: host, path: "/", httpOnly: false, secure: false, sameSite: "Lax" },
]);
const page = await ctx.newPage();
await page.goto(`${BASE}/workspace?project=${PROJECT}&gen=${GEN}`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector("[data-testid=canvas-item]", { timeout: 30000 });
await page.waitForTimeout(1500);

/** 选中一块图层（带 data-layer-set 的画布元素）。 */
async function selectLayerTile() {
  const tile = page.locator("[data-testid=canvas-item][data-layer-set]").first();
  if (!(await tile.count())) return false;
  const box = await tile.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(500);
  return true;
}

/** 选中一块非矢量、非图层的普通出图（分解的源）。 */
async function selectRasterTile() {
  const tiles = page.locator("[data-testid=canvas-item]");
  for (let i = 0; i < (await tiles.count()); i++) {
    const t = tiles.nth(i);
    if (await t.getAttribute("data-layer-set")) continue;
    const src = await t.locator("img").first().getAttribute("src").catch(() => null);
    if (!src || src.startsWith("data:image/svg")) continue;
    const box = await t.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(500);
    return true;
  }
  return false;
}

if (ONLY !== "B" && ONLY !== "C") {
  // ---- A) 滑杆 ----
  await selectLayerTile();
  const panelBtn = page.getByRole("button", { name: "图层面板" });
  if (await panelBtn.count()) await panelBtn.first().click();
  await page.waitForSelector("[data-testid=layer-panel]", { timeout: 15000 });
  await page.waitForTimeout(800);

  const slider = page.locator('[data-testid=layer-row] input[type=range]').first();
  const sb = await slider.boundingBox();
  // 从当前位置按住往左拖到最左端(0)，中途多走几步，松手。
  await page.mouse.move(sb.x + sb.width - 2, sb.y + sb.height / 2);
  await page.mouse.down();
  for (let i = 0; i < 8; i++) {
    await page.mouse.move(sb.x + sb.width - 2 - ((sb.width - 4) / 8) * (i + 1), sb.y + sb.height / 2);
    await page.waitForTimeout(60);
  }
  await page.mouse.up();
  await page.waitForTimeout(2500);
  const shown = await slider.inputValue();
  const disabledMidDrag = await slider.isDisabled();
  // 服务端权威值:重新拉一次面板数据。
  const server = await page.evaluate(async ([ws, gen, set]) => {
    const r = await fetch(`/api/workspaces/${ws}/generations/${gen}/layer-sets/${set}`);
    const j = await r.json();
    return j.layers?.[0]?.opacity;
  }, [WS, GEN, process.env.SET]);
  console.log(`A 滑杆 | 松手位置=0 界面=${shown} 服务端=${server} 拖后禁用=${disabledMidDrag}`);
}

if (ONLY !== "A" && ONLY !== "C") {
  // ---- B) 上界到点之后 ----
  await page.goto(`${BASE}/workspace?project=${PROJECT}&gen=${GEN}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("[data-testid=canvas-item]", { timeout: 30000 });
  await page.waitForTimeout(1500);
  await selectRasterTile();
  const open = page.getByRole("button", { name: "图层分解" });
  if (!(await open.count())) {
    console.log("B | 没找到「图层分解」入口（多半选中的是图层而不是源图）");
  } else {
    await open.first().click();
    await page.getByRole("button", { name: "开拆" }).click();
    await page.waitForTimeout(1200);
    const urlAfterSubmit = new URL(page.url()).searchParams.get("decomposeTask");
    // 等到上界烧掉（脚本跑时 POLL_CAP_MS 被临时调短）。
    await page.waitForTimeout(12000);
    const params = await page.evaluate(() => {
      const p = new URLSearchParams(location.search);
      return [p.get("decomposeTask"), p.get("decomposeGen"), p.get("decomposeProject")];
    });
    const btn = page.getByRole("button", { name: /图层分解|分解中…/ });
    const label = (await btn.count()) ? await btn.first().innerText() : "(无)";
    const locked = (await btn.count()) ? await btn.first().isDisabled() : null;
    console.log(
      `B 上界 | 提交后 task=${urlAfterSubmit ? "有" : "无"} | 到点后 URL=${JSON.stringify(params)} 按钮="${label}" 锁着=${locked}`,
    );
  }
}

if (ONLY === "C") {
  // ---- C) 刷新续跑时任务 GET 抖了一下(502)：线索不许被删 ----
  // 前置同 B：mock 分解要慢到这次分解还活着。
  await page.goto(`${BASE}/workspace?project=${PROJECT}&gen=${GEN}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("[data-testid=canvas-item]", { timeout: 30000 });
  await page.waitForTimeout(1500);
  await selectRasterTile();
  await page.getByRole("button", { name: "图层分解" }).first().click();
  await page.getByRole("button", { name: "开拆" }).click();
  await page.waitForTimeout(1500);
  const before = await page.evaluate(() => new URLSearchParams(location.search).get("decomposeTask"));

  // 只让**续跑那一次** GET 挂掉,之后放行,模拟一次网络抖动。
  // MODE404=1 时改成「服务端一直说没有这个任务」,验证另一端:那种情况必须收摊。
  const gone = process.env.MODE404 || "";
  let blocked = 0;
  await page.route("**/api/workspaces/*/tasks/*", async (route) => {
    // MODE404=2:先抖一下(502)让续跑分支挂上轮询,之后一律 404 —— 验证
    // 「问不到就先当它还在跑,真没了会在轮询里拿到 404 并收摊」这句话成立。
    if (gone === "2" && blocked++ >= 1)
      return route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"Task not found"}' });
    if (gone === "1")
      return route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"Task not found"}' });
    if (blocked++ < 1)
      return route.fulfill({ status: 502, contentType: "application/json", body: '{"error":"bad gateway"}' });
    return route.fallback();
  });
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("[data-testid=canvas-item]", { timeout: 30000 });
  await page.waitForTimeout(3000);

  const params = await page.evaluate(() => {
    const p = new URLSearchParams(location.search);
    return [p.get("decomposeTask"), p.get("decomposeGen"), p.get("decomposeProject")];
  });
  const btn = page.getByRole("button", { name: /图层分解|分解中…/ });
  const label = (await btn.count()) ? await btn.first().innerText() : "(无)";
  const locked = (await btn.count()) ? await btn.first().isDisabled() : null;
  console.log(
    `C ${gone === "1" ? "404" : gone === "2" ? "抖动→404" : "抖动"} | 提交后 task=${before ? "有" : "无"} | 刷新后 URL=${JSON.stringify(params)} 按钮="${label}" 锁着=${locked}`,
  );
}

await b.close();
