/**
 * Cold preview: a simulated queue backlog longer than the old 7.75s window,
 * then 202 → worker WebP 200, without original fallback.
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
if (!WS || !PROJECT || !GEN || !SESSION_TOKEN) {
  console.error("缺少 WS / PROJECT / GEN / SESSION_TOKEN");
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
const statuses = [];
const holdPreviewUntil = Date.now() + 12_000;
await page.route("**/api/workspaces/*/versions/*/preview*", async (route) => {
  if (Date.now() < holdPreviewUntil) {
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ status: "PENDING" }),
    });
    return;
  }
  await route.continue();
});
page.on("response", (response) => {
  if (
    response.url().includes("/versions/") &&
    response.url().includes("/preview")
  ) {
    statuses.push(response.status());
  }
});

try {
  await page.goto(`${BASE}/workspace?project=${PROJECT}&gen=${GEN}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForTimeout(9_000);
  const earlyImageSource = await page
    .locator('img[alt="画布图片"]')
    .first()
    .getAttribute("src")
    .catch(() => null);
  if (earlyImageSource && !earlyImageSource.includes("/preview")) {
    throw new Error(
      `preview fell back to the original during queue backlog: ${earlyImageSource}`,
    );
  }
  await page.waitForFunction(
    () => {
      const image = document.querySelector('img[alt="画布图片"]');
      return (
        image instanceof HTMLImageElement &&
        image.src.includes("/preview") &&
        image.complete &&
        image.naturalWidth > 0
      );
    },
    null,
    { timeout: 30_000 },
  );
  if (!statuses.includes(202))
    throw new Error(`cold preview never returned 202: ${statuses.join(",")}`);
  if (!statuses.includes(200))
    throw new Error(`preview retry never reached 200: ${statuses.join(",")}`);
  console.log(`PASS | cold preview statuses=${statuses.join("→")}`);
} finally {
  await browser.close();
}
