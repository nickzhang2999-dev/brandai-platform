/**
 * A selected tile may fall back from its compact preview to the original, but
 * a failure of that original must terminate in an error state instead of
 * re-entering the loading skeleton forever.
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
const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
await context.addInitScript(() => {
  const realNow = Date.now.bind(Date);
  globalThis.__previewTestTimeOffset = 0;
  Date.now = () => realNow() + globalThis.__previewTestTimeOffset;
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
await page.route("**/api/workspaces/*/versions/*/preview*", (route) =>
  route.fulfill({ status: 500, contentType: "text/plain", body: "preview failed" }),
);
await page.route("**/generations/local-review/**", (route) =>
  route.fulfill({ status: 500, contentType: "text/plain", body: "original failed" }),
);

try {
  const firstPreviewFailure = page.waitForResponse(
    (response) =>
      response.url().includes("/versions/") &&
      response.url().includes("/preview") &&
      response.status() === 500,
  );
  await page.goto(`${BASE}/workspace?project=${PROJECT}&gen=${GEN}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await firstPreviewFailure;
  await page.evaluate(() => {
    globalThis.__previewTestTimeOffset = 121_000;
  });
  const errorState = page
    .locator('[data-testid="canvas-item"][data-kind="image"]')
    .filter({ hasText: "图片加载失败" });
  await errorState
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(async (error) => {
      const sources = await page
        .locator('img[alt="画布图片"]')
        .evaluateAll((images) =>
          images.map((image) => image.getAttribute("src") || ""),
        );
      const loading = await page.locator('[data-testid="canvas-image-loading"]').count();
      throw new Error(
        `terminal image error missing (loading=${loading}, sources=${JSON.stringify(sources)})`,
        { cause: error },
      );
    });
  await page.waitForTimeout(1_000);
  const errors = await errorState.count();
  if (errors < 1) throw new Error("original failure did not remain visible");
  console.log(`PASS | selected preview + original failure terminates | errors=${errors}`);
} finally {
  await browser.close();
}
