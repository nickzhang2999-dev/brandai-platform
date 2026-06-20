// P3 page smoke — drives the real Next.js app at http://localhost:3000 with
// Playwright and writes per-theme screenshots of the pages called out in the
// P3.1 verification clause:
//   /login, /workspaces, /workspaces/[wsId], /admin/workspaces
// plus P3.3's /workspaces/[wsId]/generate (the 3-column wizard) and
// /account (the theme switcher itself).
//
// Requires the dev/prod server to be reachable; uses the demo "password" provider
// to sign in (see apps/web/src/auth.ts). Each theme is applied by injecting the
// localStorage key + class on <html> before navigation, matching the pre-paint
// inline script in app/layout.tsx.
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(
  "/home/user/brandai/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.js",
);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const EMAIL = process.env.SMOKE_EMAIL ?? "admin@example.com";
const PASSWORD = process.env.SMOKE_PASSWORD ?? "smoke-pass-1234";

const THEMES = [
  { name: "01-light", value: "light", className: "" },
  { name: "02-dark", value: "dark", className: "dark" },
  { name: "03-mono", value: "theme-mono", className: "theme-mono" },
  { name: "04-tech", value: "theme-tech", className: "theme-tech" },
];

async function applyTheme(page, theme) {
  await page.addInitScript((value) => {
    try {
      window.localStorage.setItem("brandai-theme", value);
    } catch {}
  }, theme.value);
  await page.evaluate((value) => {
    try {
      window.localStorage.setItem("brandai-theme", value);
    } catch {}
    const classes = ["dark", "theme-mono", "theme-tech"];
    const html = document.documentElement;
    classes.forEach((c) => html.classList.remove(c));
    if (value !== "light") html.classList.add(value);
  }, theme.value);
}

async function signIn(page) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await Promise.all([
    page.waitForURL(/\/workspaces/, { timeout: 30000 }),
    page.click('button[type="submit"]'),
  ]);
}

async function ensureWorkspace(page) {
  await page.goto(`${BASE}/workspaces`, { waitUntil: "networkidle" });
  // If there's already at least one workspace card, return its href; otherwise
  // create one and follow the link.
  const link = page
    .locator('main a[href*="/workspaces/"]:not([href$="/workspaces"])')
    .first();
  if ((await link.count()) === 0) {
    await page.locator("#ws-name").fill("P3 Smoke Brand");
    await page.locator("#ws-industry").fill("快消");
    await page.click('button[type="submit"]:has-text("创建")');
    await page.waitForURL(/\/workspaces\/[^/]+/, { timeout: 30000 });
    return page.url();
  }
  return await link.getAttribute("href");
}

async function main() {
  const outDir = path.join(ROOT, "tmp/p3-pages");
  await fs.mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  // 1. Sign in once + create / open workspace to discover wsId.
  await signIn(page);
  const wsHref = await ensureWorkspace(page);
  const wsId = (wsHref ?? "").split("/workspaces/")[1]?.split(/[/?#]/)[0];
  console.log(`workspace href: ${wsHref}  · wsId: ${wsId}`);

  const targets = [
    { route: "/login", label: "01-login", requiresAuth: false },
    { route: "/workspaces", label: "02-workspaces", requiresAuth: true },
    {
      route: `/workspaces/${wsId}`,
      label: "03-workspace-detail",
      requiresAuth: true,
    },
    {
      route: "/admin/workspaces",
      label: "04-admin-workspaces",
      requiresAuth: true,
    },
    {
      route: `/workspaces/${wsId}/generate`,
      label: "05-generate-3col",
      requiresAuth: true,
    },
    { route: "/account", label: "06-account-switcher", requiresAuth: true },
  ];

  for (const theme of THEMES) {
    for (const t of targets) {
      const url = `${BASE}${t.route}`;
      try {
        // /login is unauthenticated — open in a fresh context so the navbar
        // doesn't interfere; also write the theme key for the pre-paint script.
        const pageForShot = t.requiresAuth ? page : await context.newPage();
        await pageForShot.addInitScript((value) => {
          try {
            window.localStorage.setItem("brandai-theme", value);
          } catch {}
        }, theme.value);
        await pageForShot.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        // Apply class explicitly in case the pre-paint script raced.
        await pageForShot.evaluate((value) => {
          const classes = ["dark", "theme-mono", "theme-tech"];
          const html = document.documentElement;
          classes.forEach((c) => html.classList.remove(c));
          if (value !== "light") html.classList.add(value);
        }, theme.value);
        await pageForShot
          .waitForLoadState("networkidle", { timeout: 10000 })
          .catch(() => {});
        const out = path.join(outDir, `${theme.name}_${t.label}.png`);
        await pageForShot.screenshot({ path: out, fullPage: true });
        console.log(`wrote ${out}`);
        if (!t.requiresAuth) await pageForShot.close();
      } catch (err) {
        console.error(`fail ${theme.name} ${t.route}:`, err.message);
      }
    }
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
