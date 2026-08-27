/**
 * 「下层图层选不中」A+B 两条修法的真浏览器红绿（手动驱动脚本，不是 CI 守卫）。
 *
 *  A) 图层面板点某一行 → 画布上那一层被选中。
 *  B) 叠放组里同一处重复点击 → 选择往下钻一层，到底回到最上面。
 *
 * 为什么必须真浏览器：这两条改的是**指针命中与选择**，`typecheck` / 单测一个都碰不到
 * （见 docs/11）。判据取「选中框落在哪个 versionId 上」，不是截图像素。
 *
 * 怎么跑（起栈与登录见同目录 README.md）：
 *   WS= PROJECT= GEN= SESSION_TOKEN= node tests/interaction/layer-selection.mjs
 *   红：A 把 LayerPanel 的 `onClick={() => onFocusLayer?.(...)}` 去掉；
 *       B 把 beginItemDrag 里那段「组内循环」删掉。
 */
import { chromium } from "playwright-core";
for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "ALL_PROXY", "all_proxy"])
  delete process.env[k];

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const EXE = process.env.CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const { WS, PROJECT, GEN, SESSION_TOKEN } = process.env;
if (!WS || !PROJECT || !GEN || !SESSION_TOKEN) {
  console.error("缺少 WS / PROJECT / GEN / SESSION_TOKEN，见同目录 README.md");
  process.exit(2);
}
const host = new URL(BASE).hostname;

const b = await chromium.launch({
  executablePath: EXE,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const ctx = await b.newContext({ viewport: { width: 1500, height: 950 } });
await ctx.addCookies([
  { name: "authjs.session-token", value: SESSION_TOKEN, domain: host, path: "/", httpOnly: true, secure: false, sameSite: "Lax" },
  { name: "brandai-active-brand", value: WS, domain: host, path: "/", httpOnly: false, secure: false, sameSite: "Lax" },
]);
const page = await ctx.newPage();
await page.goto(`${BASE}/workspace?project=${PROJECT}&gen=${GEN}`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector("[data-testid=canvas-item]", { timeout: 30000 });
await page.waitForTimeout(1800);

/** 当前被选中的画布元素（读选中框的宿主），返回它的 layerIndex。 */
const selectedLayerIndex = () =>
  page.evaluate(() => {
    const sel = document.querySelector("[data-testid=canvas-item][data-selected='1']");
    return sel ? sel.getAttribute("data-layer-index") : null;
  });

// 选中一块图层，让工具条出现「图层面板」
const tile = page.locator("[data-testid=canvas-item][data-layer-set]").first();
if (!(await tile.count())) {
  console.log("FAIL | 画布上没有图层组 tile（这条 generation 还没分解过？）");
  await b.close();
  process.exit(1);
}
const box = await tile.boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(400);

const panelBtn = page.getByRole("button", { name: "图层面板" });
if (await panelBtn.count()) await panelBtn.first().click();
await page.waitForSelector("[data-testid=layer-panel]", { timeout: 15000 });
await page.waitForSelector("[data-testid=layer-row]", { timeout: 15000 });
 await page.waitForTimeout(400);

// ---- A) 面板点行 → 画布选中那一层 ----
const rows = page.locator("[data-testid=layer-row]");
const rowCount = await rows.count();
const aHits = [];
for (let i = 0; i < rowCount; i++) {
  await rows.nth(i).click();
  await page.waitForTimeout(350);
  aHits.push(await selectedLayerIndex());
}
console.log(`A 面板点行 | 共 ${rowCount} 行 | 依次选中的 layerIndex = ${JSON.stringify(aHits)}`);

// ---- B) 画布同一处重复点击 → 往下钻 ----
const bHits = [];
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
for (let i = 0; i < rowCount + 1; i++) {
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(300);
  bHits.push(await selectedLayerIndex());
}
console.log(`B 重复点击 | 依次选中的 layerIndex = ${JSON.stringify(bHits)}`);
console.log(`B 判据 | 触达到的不同层数 = ${new Set(bHits.filter((v) => v !== null)).size} / ${rowCount}`);

await b.close();
