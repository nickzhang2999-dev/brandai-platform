/**
 * 工作台开放世界画布 —— 逐功能浏览器真测 harness（本地 localhost，绕过沙箱 MITM 代理）。
 *
 * 背景 / 为什么需要它：见 docs/11_前端画布交互经验与本地真测.md。
 * typecheck/build/L1 不碰指针/焦点/路由，画布交互 bug 只有真浏览器点一遍才暴露。
 * 这个 harness 把那「一遍」固化下来，改画布后先把它跑绿再交付。
 *
 * 前置（详见同目录 README.md）：
 *   1. 本地起栈：postgres + redis + apps/ai(mock) + worker + web(:3000)。
 *   2. 用 README 里的 curl 段登录 + 造 workspace/project/generation，得到：
 *        WS / PROJECT / GEN 三个 id + authjs.session-token。
 *   3. 用环境变量喂进来：
 *        BASE_URL(默认 http://127.0.0.1:3000) WS= PROJECT= GEN= SESSION_TOKEN=
 *        CHROME(默认 /opt/pw-browsers/chromium-1194/chrome-linux/chrome) OUT(截图目录)
 *   4. node tests/interaction/canvas-functions.mjs
 *
 * 依赖：playwright-core（沙箱 chromium 已装；本仓库未把它列入 deps，按需 `npm i -D playwright-core`）。
 */
import { chromium } from "playwright-core";
// localhost 绝不能走 MITM 代理（否则连不上本地 web）。
for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "ALL_PROXY", "all_proxy"])
  delete process.env[k];

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const EXE = process.env.CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const OUT = process.env.OUT || ".";
const { WS, PROJECT, GEN, SESSION_TOKEN } = process.env;
if (!WS || !PROJECT || !GEN || !SESSION_TOKEN) {
  console.error("缺少 WS / PROJECT / GEN / SESSION_TOKEN 环境变量，见同目录 README.md");
  process.exit(2);
}
const host = new URL(BASE).hostname;

const R = [];
const b = await chromium.launch({ executablePath: EXE, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await b.newContext({ viewport: { width: 1500, height: 950 } });
await ctx.addCookies([
  { name: "authjs.session-token", value: SESSION_TOKEN, domain: host, path: "/", httpOnly: true, secure: false, sameSite: "Lax" },
  // 关键：/workspace 的 wsId 由 brand cookie(getOrCreateActiveBrand) 解析，必须钉住，否则落到别的旧品牌。
  { name: "brandai-active-brand", value: WS, domain: host, path: "/", httpOnly: false, secure: false, sameSite: "Lax" },
]);
const page = await ctx.newPage();
const byKind = (k) => page.locator(`[data-testid=canvas-item][data-kind="${k}"]`).count();
const items = () => page.locator("[data-testid=canvas-item]").count();
const zoom = () =>
  page.evaluate(() => {
    const bt = document.querySelector('button[aria-label="缩小"]');
    return bt?.parentElement?.querySelector("span.font-mono")?.textContent || "";
  });
const stage = async () => page.locator("div.rounded-\\[28px\\]").first().boundingBox();
const clickEmpty = async (fx, fy) => { const s = await stage(); await page.mouse.click(s.x + s.width * fx, s.y + s.height * fy); };
async function step(name, fn) {
  try { const d = await fn(); R.push({ name, ok: !!(d && d.ok) }); console.log(`${d && d.ok ? "PASS" : "FAIL"} | ${name} | ${d?.detail || ""}`); }
  catch (e) { R.push({ name, ok: false }); console.log(`FAIL | ${name} | ERR ${e.message.split("\n")[0].slice(0, 70)}`); }
}

await page.goto(`${BASE}/workspace?project=${PROJECT}&gen=${GEN}`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector("[data-testid=canvas-item]", { timeout: 30000 });
await page.waitForTimeout(1200);

await step("页面加载+画布出现变体", async () => { const n = await byKind("image"); return { ok: n >= 1, detail: `image=${n}` }; });
// 抖动回归：6s 空闲内不应有 /workspace 软导航洪泛
await step("无导航环抖动", async () => {
  let n = 0; const h = (r) => { const u = r.url(); if (u.includes("/workspace") && (r.resourceType() === "document" || u.includes("_rsc"))) n++; };
  page.on("request", h); await page.waitForTimeout(6000); page.off("request", h);
  return { ok: n === 0, detail: `6s 空闲 /workspace 请求=${n}` };
});
await step("放大(+)", async () => { const z = await zoom(); await page.locator('button[aria-label="放大"]').click(); await page.waitForTimeout(250); return { ok: parseInt(await zoom()) > parseInt(z), detail: `${z}→${await zoom()}` }; });
await step("缩小(-)", async () => { const z = await zoom(); await page.locator('button[aria-label="缩小"]').click(); await page.waitForTimeout(250); return { ok: parseInt(await zoom()) < parseInt(z) }; });
await step("100%复位", async () => { await page.locator('button:has-text("100%")').click(); await page.waitForTimeout(250); return { ok: (await zoom()) === "100%" }; });
await step("适配fit", async () => { await page.locator('button:has-text("适配")').click(); await page.waitForTimeout(350); return { ok: (await zoom()) !== "" }; });
await step("加矩形", async () => { const s = await byKind("shape"); await page.locator('button[aria-label="加矩形"]').click(); await clickEmpty(0.5, 0.85); await page.waitForTimeout(250); return { ok: (await byKind("shape")) === s + 1 }; });
await step("加圆形", async () => { const s = await byKind("shape"); await page.locator('button[aria-label="加圆形"]').click(); await clickEmpty(0.62, 0.85); await page.waitForTimeout(250); return { ok: (await byKind("shape")) === s + 1 }; });
await step("加文字", async () => { const t = await byKind("text"); await page.locator('button[aria-label="加文字"]').click(); await clickEmpty(0.74, 0.85); await page.waitForTimeout(250); return { ok: (await byKind("text")) === t + 1 }; });
await step("双击编辑文字", async () => {
  const t = page.locator("[data-testid=canvas-item][data-kind=text]").first(); const bb = await t.boundingBox();
  await page.mouse.dblclick(bb.x + bb.width / 2, bb.y + bb.height / 2); await page.waitForTimeout(400);
  if (!(await page.locator("[data-testid=canvas-item] textarea").count())) return { ok: false, detail: "未进编辑" };
  await page.locator("[data-testid=canvas-item] textarea").first().fill("改后文字OK");
  const s = await stage(); await page.mouse.click(s.x + s.width * 0.85, s.y + s.height * 0.85); await page.waitForTimeout(400);
  const has = await page.locator("[data-testid=canvas-item][data-kind=text]").filter({ hasText: "改后文字OK" }).count();
  return { ok: has > 0, detail: `写回=${has > 0}` };
});
await step("拖拽元素", async () => { const sh = page.locator("[data-testid=canvas-item][data-kind=shape]").first(); const a = await sh.boundingBox(); await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down(); await page.mouse.move(a.x + a.width / 2 + 90, a.y + a.height / 2 + 30, { steps: 5 }); await page.mouse.up(); await page.waitForTimeout(250); const c = await page.locator("[data-testid=canvas-item][data-kind=shape]").first().boundingBox(); return { ok: Math.abs(c.x - a.x) > 30, detail: `dx=${Math.round(c.x - a.x)}` }; });
await step("缩放手柄resize", async () => { const sh = page.locator("[data-testid=canvas-item][data-kind=shape]").first(); const a = await sh.boundingBox(); await page.mouse.click(a.x + a.width / 2, a.y + a.height / 2); await page.waitForTimeout(300); const sel = page.locator('[data-testid=canvas-item][data-selected="1"]').first(); const r = await sel.boundingBox(); await page.mouse.move(r.x + r.width, r.y + r.height); await page.mouse.down(); await page.mouse.move(r.x + r.width + 70, r.y + r.height + 70, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(300); const r2 = await page.locator('[data-testid=canvas-item][data-selected="1"]').first().boundingBox(); return { ok: r2.width - r.width > 20 || r2.height - r.height > 20 }; });
await step("置顶图层", async () => { await page.locator('button[title="置顶"]').click(); await page.waitForTimeout(300); const all = await page.locator("[data-testid=canvas-item]").elementHandles(); let i = -1; for (let k = 0; k < all.length; k++) if ((await all[k].getAttribute("data-selected")) === "1") i = k; return { ok: i === all.length - 1 }; });
await step("置底图层", async () => { await page.locator('button[title="置底"]').click(); await page.waitForTimeout(300); const all = await page.locator("[data-testid=canvas-item]").elementHandles(); let i = -1; for (let k = 0; k < all.length; k++) if ((await all[k].getAttribute("data-selected")) === "1") i = k; return { ok: i === 0 }; });
await step("方向键微移", async () => { const a = await page.locator('[data-testid=canvas-item][data-selected="1"]').first().boundingBox(); await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowRight"); await page.waitForTimeout(200); const c = await page.locator('[data-testid=canvas-item][data-selected="1"]').first().boundingBox(); return { ok: Math.abs(c.x - a.x) >= 1 }; });
await step("删除选中(按钮)", async () => { const c = await items(); await page.locator('button[title="删除选中"]').click(); await page.waitForTimeout(300); return { ok: (await items()) === c - 1 }; });
await step("Delete键删除", async () => { const sh = page.locator("[data-testid=canvas-item][data-kind=shape]").first(); if (!(await sh.count())) return { ok: false }; const a = await sh.boundingBox(); await page.mouse.click(a.x + a.width / 2, a.y + a.height / 2); await page.waitForTimeout(200); const c = await items(); await page.keyboard.press("Delete"); await page.waitForTimeout(300); return { ok: (await items()) === c - 1 }; });
await step("选中变体→操作条", async () => { await page.locator("[data-testid=canvas-item][data-kind=image]").first().click(); await page.waitForTimeout(500); return { ok: (await page.locator('button:has-text("出图")').count()) > 0 }; });
await step("改色arm(不立即出图)", async () => { await page.locator('button:has-text("改色")').first().click(); await page.waitForTimeout(300); const armed = await page.locator('button[aria-pressed="true"]:has-text("改色")').count(); const en = await page.locator('button:has-text("出图")').first().isEnabled(); return { ok: armed > 0 && en }; });
await step("出图→真改图→新子版本", async () => { const v = await byKind("image"); await page.locator('input[placeholder*="描述"]').first().fill("暖色调"); await page.locator('button:has-text("出图")').first().click(); let g = false; for (let i = 0; i < 18; i++) { if ((await byKind("image")) >= v + 1) { g = true; break; } await page.waitForTimeout(2000); } return { ok: g, detail: `image ${v}→${await byKind("image")}` }; });
await step("局部重画→蒙版层", async () => { await page.locator("[data-testid=canvas-item][data-kind=image]").first().click(); await page.waitForTimeout(400); await page.locator('button:has-text("局部重画")').first().click(); await page.waitForTimeout(800); const m = (await page.locator("canvas").count()) > 0 || (await page.locator("text=/涂抹|画笔|蒙版|重绘|擦除/").count()) > 0; return { ok: m }; });

await page.screenshot({ path: `${OUT}/canvas-functions.png` }).catch(() => {});
const pass = R.filter((r) => r.ok).length;
console.log(`\n=== ${pass}/${R.length} PASS ===`);
console.log("FAILS:", R.filter((r) => !r.ok).map((r) => r.name).join(", ") || "none");
await b.close();
process.exit(R.every((r) => r.ok) ? 0 : 1);
