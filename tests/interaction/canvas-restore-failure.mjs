/**
 * ProjectCanvas restore failure must leave the loading state without enabling
 * autosave. This protects server data from an empty PUT after a transient GET
 * failure while still giving the user a bounded, actionable UI state.
 */
import { chromium } from "playwright-core";

for (const key of [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "https_proxy",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
])
  delete process.env[key];

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const EXE =
  process.env.CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const { WS, PROJECT, GEN, SESSION_TOKEN } = process.env;
if (!WS || !PROJECT || !SESSION_TOKEN) {
  console.error("缺少 WS / PROJECT / SESSION_TOKEN");
  process.exit(2);
}

const browser = await chromium.launch({
  executablePath: EXE,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const context = await browser.newContext({
  viewport: { width: 1500, height: 950 },
});
const host = new URL(BASE).hostname;
await context.addCookies([
  {
    name: "authjs.session-token",
    value: SESSION_TOKEN,
    domain: host,
    path: "/",
    httpOnly: true,
    secure: false,
    sameSite: "Lax",
  },
  {
    name: "brandai-active-brand",
    value: WS,
    domain: host,
    path: "/",
    httpOnly: false,
    secure: false,
    sameSite: "Lax",
  },
]);

const page = await context.newPage();
const canvasPath = `/api/workspaces/${WS}/projects/${PROJECT}/canvas`;
let canvasPuts = 0;
await page.route(`**${canvasPath}`, async (route) => {
  if (route.request().method() === "GET") {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "forced restore failure" }),
    });
    return;
  }
  if (route.request().method() === "PUT") canvasPuts += 1;
  await route.continue();
});

try {
  const query = new URLSearchParams({ project: PROJECT });
  if (GEN) query.set("gen", GEN);
  await page.goto(`${BASE}/workspace?${query}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.getByText("画布恢复失败", { exact: true }).waitFor({
    state: "visible",
    timeout: 15_000,
  });
  const restoring = await page
    .getByText("正在恢复项目画布…", { exact: true })
    .count();
  await page.waitForTimeout(2_000);
  if (restoring !== 0) throw new Error("restore spinner remained visible");
  if (canvasPuts !== 0)
    throw new Error(
      `failed restore unexpectedly sent ${canvasPuts} canvas PUT(s)`,
    );
  console.log("PASS | restore failure exits loading | autosave PUT=0");
} finally {
  await browser.close();
}
