/**
 * V0.0.22 — many-history canvas preview regression.
 *
 * Requires an authenticated project with at least 30 generated versions.
 * This is intentionally separate from canvas-functions.mjs: it verifies the
 * loading envelope (compact WebP + current-first + staggered requests), not AI
 * editing or layer-provider quality.
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
const startedAt = Date.now();
const previewStarts = [];
const previewResponses = [];
const isPreview = (url) =>
  url.includes("/versions/") && url.includes("/preview?w=768");
page.on("request", (request) => {
  if (isPreview(request.url())) previewStarts.push(Date.now() - startedAt);
});
page.on("response", (response) => {
  if (!isPreview(response.url())) return;
  const headers = response.headers();
  previewResponses.push({
    status: response.status(),
    type: headers["content-type"] || "",
    bytes: Number(headers["content-length"] || 0),
  });
});

const fail = (message) => {
  throw new Error(message);
};

try {
  await page.goto(`${BASE}/workspace?project=${PROJECT}&gen=${GEN}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForFunction(
    () =>
      document.querySelectorAll(
        '[data-testid="canvas-item"][data-kind="image"]',
      ).length >= 30,
    null,
    { timeout: 30_000 },
  );

  const imageCount = await page
    .locator('[data-testid="canvas-item"][data-kind="image"]')
    .count();
  const loadingCount = await page
    .locator('[data-testid="canvas-image-loading"]')
    .count();
  if (imageCount < 30) fail(`expected >=30 image tiles, got ${imageCount}`);
  if (loadingCount < 1)
    fail("expected delayed tiles to expose loading placeholders");

  await page.waitForFunction(
    () => {
      const images = [...document.querySelectorAll('img[alt="画布图片"]')];
      return (
        images.length >= 30 &&
        images.every((image) => image.complete && image.naturalWidth > 0)
      );
    },
    null,
    { timeout: 30_000 },
  );

  const sources = await page
    .locator('img[alt="画布图片"]')
    .evaluateAll((images) =>
      images.map((image) => image.getAttribute("src") || ""),
    );
  const uniqueSources = new Set(sources);
  if (uniqueSources.size < 30)
    fail(`expected >=30 unique preview sources, got ${uniqueSources.size}`);
  if ([...uniqueSources].some((src) => !src.includes("/preview?w=768")))
    fail("a generated canvas tile bypassed the preview endpoint");

  if (previewResponses.length < 30)
    fail(`expected >=30 preview responses, got ${previewResponses.length}`);
  if (
    previewResponses.some(
      (response) =>
        response.status !== 200 || !response.type.startsWith("image/webp"),
    )
  )
    fail("preview response was not a successful WebP");

  const requestSpread = Math.max(...previewStarts) - Math.min(...previewStarts);
  if (requestSpread < 1_000)
    fail(`preview requests were not staggered (${requestSpread}ms spread)`);

  const totalBytes = previewResponses.reduce(
    (sum, response) => sum + response.bytes,
    0,
  );
  console.log(
    `PASS | ${imageCount} images | ${previewResponses.length} WebP responses | ` +
      `${(totalBytes / 1024).toFixed(1)} KiB | request spread ${requestSpread}ms`,
  );
} finally {
  await browser.close();
}
