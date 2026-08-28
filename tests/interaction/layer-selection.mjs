/**
 * 「下层图层选不中」A+B 两条修法的真浏览器红绿（手动驱动脚本，不是 CI 守卫）。
 *
 *  A) 图层面板点某一行 → 画布上那一层被选中。
 *  B) 叠放组里同一处重复点击 → 选择往下钻一层，到底回到最上面（只走可见层）。
 *  C) 按住已选中的下层拖动 → 位移的是它，不是别的层。
 *
 * 为什么必须真浏览器：这三条改的是**指针命中与选择**，`typecheck` / 单测一个都碰不到
 * （见 docs/11）。判据取「选中框落在哪个 layerIndex 上」「哪一块真的位移了」，不是截图像素。
 *
 * 判据会红：三条任一不成立就打印 FAIL 并以退出码 1 结束——只打印不判的驱动等于没有证据。
 *
 * 怎么跑（起栈与登录见同目录 README.md）：
 *   WS= PROJECT= GEN= SESSION_TOKEN= node tests/interaction/layer-selection.mjs
 *   红：A 把 LayerPanel 的 `onClick={() => onFocusLayer?.(...)}` 去掉；
 *       B 把 onStageUp 里那段「组内循环」删掉；
 *       C 把那段循环搬回 beginItemDrag（按下即换层 → 拖走的是下一层）。
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
// 隐藏层在画布上 `return null`,没有 DOM 也就没有选中框——B 只可能触达看得见的那些。
const visibleCount = await page.locator("[data-testid=layer-row][data-hidden='0']").count();
// 判据只认可见行:隐藏层在画布上没有 DOM,点它那一行本来就选不出东西来(面板会
// 把原因写在 title 里),拿它当「点了没反应」判红是误判。
const visibleRows = page.locator("[data-testid=layer-row][data-hidden='0']");
const aHits = [];
for (let i = 0; i < visibleCount; i++) {
  await visibleRows.nth(i).click();
  await page.waitForTimeout(350);
  aHits.push(await selectedLayerIndex());
}
console.log(
  `A 面板点行 | 共 ${rowCount} 行(可见 ${visibleCount}) | 依次选中的 layerIndex = ${JSON.stringify(aHits)}`,
);

// ---- B) 画布同一处重复点击 → 往下钻 ----
const bHits = [];
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
for (let i = 0; i < visibleCount + 1; i++) {
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(300);
  bHits.push(await selectedLayerIndex());
}
console.log(`B 重复点击 | 依次选中的 layerIndex = ${JSON.stringify(bHits)}`);

// ---- C) 按住已选中的下层拖动 → 动的是它,不是别的层 ----
//
// 组内循环一旦放在 pointerdown 上,按下这一瞬间选择就跳到了下一层,于是手上拖的和
// 眼睛看着的选中框不是同一块。判据取「哪一块真的位移了」,不看选中状态。
//
// key 必须带 layerSetId:一条 generation 上可能挂着好几组分解产物(实测 16 组),
// 光按 layerIndex 存会把 16 组的第 3 层压成同一个键,真动了的那块被后面没动的
// 覆盖掉 —— 判据看上去"什么都没动",而其实拖得好好的。
const layerBoxes = async () =>
  Object.fromEntries(
    (
      await page.evaluate(() =>
        Array.from(
          document.querySelectorAll("[data-testid=canvas-item][data-layer-index]"),
        ).map((e) => {
          const r = e.getBoundingClientRect();
          return [
            `${e.getAttribute("data-layer-set")}#${e.getAttribute("data-layer-index")}`,
            { x: r.x, y: r.y },
          ];
        }),
      )
    ),
  );
// 先用面板把选择落在一个**不是最上面**的层上（最上面那层命中测试本来就拿得到，
// 拖错层的坑只在下层上暴露得出来）。
await rows.nth(0).click();
await page.waitForTimeout(350);
const cTarget = await page.evaluate(() => {
  const s = document.querySelector("[data-testid=canvas-item][data-selected='1']");
  return s
    ? `${s.getAttribute("data-layer-set")}#${s.getAttribute("data-layer-index")}`
    : null;
});
const before = await layerBoxes();
// 落点要现算:A 的「点行 → 选中」会把画布平移到那一层上,开头量的 box 已经过期,
// 照着旧坐标按下去会落到空白处变成框选,于是「什么都没动」被误读成拖错层。
const selBox = await page
  .locator("[data-testid=canvas-item][data-selected='1']")
  .first()
  .boundingBox();
const dragX = selBox ? selBox.x + selBox.width / 2 : cx;
const dragY = selBox ? selBox.y + selBox.height / 2 : cy;
await page.mouse.move(dragX, dragY);
await page.mouse.down();
await page.mouse.move(dragX + 40, dragY + 30, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(400);
const after = await layerBoxes();
const moved = Object.keys(before).filter((k) => {
  const a = before[k];
  const b2 = after[k];
  return b2 && (Math.abs(b2.x - a.x) > 8 || Math.abs(b2.y - a.y) > 8);
});
console.log(`C 拖动 | 选中的是 ${cTarget} | 实际位移的层 = ${JSON.stringify(moved)}`);

// ---- 判据(必须能红:光打印不判,红绿就无从验起) ----
// A:每一行都要点得中——出现 null 说明那一行点了画布毫无反应。
// B:重复点击必须把**可见**层一个不落地走一遍,少一层就是「下层还是选不中」。
const aReached = new Set(aHits.filter((v) => v !== null));
const bReached = new Set(bHits.filter((v) => v !== null));
const fails = [];
if (aHits.some((v) => v === null))
  fails.push(`A 有 ${aHits.filter((v) => v === null).length} 行点下去没有任何层被选中`);
if (aReached.size !== visibleCount)
  fails.push(`A 只触达 ${aReached.size} 层,可见行共 ${visibleCount} 行`);
if (bReached.size !== visibleCount)
  fails.push(`B 只触达 ${bReached.size} 层,可见层共 ${visibleCount} 层`);
// 光数「触达了几层」不够:钻到隐藏层时那一下点击什么都没选中,只要循环多跑一圈,
// 可见层照样能凑齐,判据就绿着放过去了。每一下点击都必须选中**某一层**。
if (bHits.some((v) => v === null))
  fails.push(
    `B 有 ${bHits.filter((v) => v === null).length} 下点击什么都没选中(多半钻到了隐藏层)`,
  );
if (moved.length !== 1 || moved[0] !== cTarget)
  fails.push(
    `C 拖动动的是 ${JSON.stringify(moved)},但选中框在 ${cTarget} 上`,
  );
console.log(
  fails.length
    ? `FAIL | ${fails.join(" ; ")}`
    : `PASS | A ${aReached.size}/${visibleCount} 可见行可达 · B ${bReached.size}/${visibleCount} 可见层可达 · C 拖动跟着选中框走`,
);

await b.close();
process.exit(fails.length ? 1 : 0);
