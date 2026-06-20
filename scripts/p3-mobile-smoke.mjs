// P3 mobile smoke — re-runs the page tour at iPhone 13 and iPad mini
// viewports with full device emulation (user-agent + DPR + touch) so we can
// eyeball how the §6.4 3-column layout collapses, how the AppShell nav
// behaves under <lg width, and where sticky / overflow surprises lurk.
//
// Output: tmp/p3-mobile/<theme>_<page>_<device>.png
//
// Same setup contract as scripts/p3-page-smoke.mjs (web server on :3000,
// admin@example.com / smoke-pass-1234, a workspace already created).
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pw = require(
  "/home/user/brandai/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.js",
);
const { chromium, devices } = pw;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const EMAIL = process.env.SMOKE_EMAIL ?? "admin@example.com";
const PASSWORD = process.env.SMOKE_PASSWORD ?? "smoke-pass-1234";

const DEVICES = [
  { id: "iphone13", descriptor: devices["iPhone 13"] },
  { id: "ipadmini", descriptor: devices["iPad Mini"] },
];

// Pick a subset of themes — light + dark cover the obvious branches; mono/tech
// share the same token plumbing as P3.1's smoke already proved.
const THEMES = [
  { name: "01-light", value: "light" },
  { name: "02-dark", value: "dark" },
];

async function signIn(page) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await Promise.all([
    page.waitForURL(/\/workspaces/, { timeout: 30000 }),
    page.click('button[type="submit"]'),
  ]);
}

async function getWsId(page) {
  await page.goto(`${BASE}/workspaces`, { waitUntil: "networkidle" });
  const link = page
    .locator('main a[href*="/workspaces/"]:not([href$="/workspaces"])')
    .first();
  const href = await link.getAttribute("href");
  return (href ?? "").split("/workspaces/")[1]?.split(/[/?#]/)[0];
}

async function main() {
  const outDir = path.join(ROOT, "tmp/p3-mobile");
  await fs.mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();

  for (const dev of DEVICES) {
    const context = await browser.newContext({ ...dev.descriptor });
    const page = await context.newPage();
    await signIn(page);
    const wsId = await getWsId(page);
    if (!wsId) throw new Error("no workspace");

    const targets = [
      { route: "/login", label: "01-login", auth: false },
      { route: "/workspaces", label: "02-workspaces", auth: true },
      { route: `/workspaces/${wsId}`, label: "03-workspace-detail", auth: true },
      {
        route: `/workspaces/${wsId}/generate`,
        label: "05-generate",
        auth: true,
      },
      { route: "/account", label: "06-account-switcher", auth: true },
    ];

    for (const theme of THEMES) {
      for (const t of targets) {
        const pageForShot = t.auth ? page : await context.newPage();
        await pageForShot.addInitScript((value) => {
          try {
            window.localStorage.setItem("brandai-theme", value);
          } catch {}
        }, theme.value);
        await pageForShot.goto(`${BASE}${t.route}`, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        await pageForShot.evaluate((value) => {
          const classes = ["dark", "theme-mono", "theme-tech"];
          const html = document.documentElement;
          classes.forEach((c) => html.classList.remove(c));
          if (value !== "light") html.classList.add(value);
        }, theme.value);
        await pageForShot
          .waitForLoadState("networkidle", { timeout: 8000 })
          .catch(() => {});
        const out = path.join(
          outDir,
          `${theme.name}_${t.label}_${dev.id}.png`,
        );
        await pageForShot.screenshot({ path: out, fullPage: true });
        console.log(`wrote ${out}`);
        if (!t.auth) await pageForShot.close();
      }
    }

    await context.close();
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
