// P3 v2 smoke — uncropped, layered, with performance metrics.
//
// Three classes of capture:
//   1. Element-bounded: target a specific selector and clip to its bounding
//      box so the screenshot is exactly the component, no surrounding noise,
//      no cropping. Useful for the §6.4 RuleCard layering proof.
//   2. Fullpage at 1920×1200: bigger viewport + fullPage so even the longest
//      surfaces (rule list, project detail) capture without cropping.
//   3. Performance: Playwright's Performance API + a server-timing read. We
//      log DOMContentLoaded / load / first-contentful-paint / transfer size
//      for each captured route, then write a markdown report.
//
// Pre-req: seeded data (scripts/p3-seed-business.sql) + web server :3000.
import path from "node:path";
import { promises as fs } from "node:fs";
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

const VP = { width: 1920, height: 1200 };

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

/**
 * Capture a snug box around the element matching `selectorByText`. We use
 * a closest("article, section, .rounded-3xl") walk so we grab the whole
 * card, not just the inner heading.
 */
async function captureCard(page, headingText, outPath, padding = 24) {
  const handle = await page.evaluate(
    ({ headingText, padding, scrollY }) => {
      const all = [
        ...document.querySelectorAll("h1, h2, h3, h4, span, div"),
      ];
      const found = all.find(
        (el) =>
          el.textContent && el.textContent.trim() === headingText.trim(),
      );
      if (!found) return null;
      // Walk up to find the rounded-3xl card / article container.
      let node = found;
      for (let i = 0; i < 10; i++) {
        if (!node.parentElement) break;
        const cls = node.className?.toString() ?? "";
        if (
          node.tagName === "ARTICLE" ||
          cls.includes("rounded-3xl") ||
          cls.includes("rounded-2xl")
        ) {
          break;
        }
        node = node.parentElement;
      }
      const r = node.getBoundingClientRect();
      return {
        x: Math.max(0, Math.floor(r.left - padding)),
        y: Math.max(0, Math.floor(r.top + scrollY - padding)),
        width: Math.ceil(r.width + padding * 2),
        height: Math.ceil(r.height + padding * 2),
      };
    },
    { headingText, padding, scrollY: 0 },
  );
  if (!handle) {
    console.log(`! no element for ${headingText}`);
    return false;
  }
  // Use fullPage screenshot via element-relative coordinates. The clip is
  // applied to the rendered page, including off-screen content.
  await page.screenshot({
    path: outPath,
    clip: handle,
  });
  return true;
}

async function measurePerf(context, url) {
  // Use a fresh page per route so service-worker/disk-cache don't skew
  // numbers. We measure decodedBodySize (always populated) alongside
  // transferSize (zero when cached) so the report is honest about both.
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.evaluate(() => document.body.getBoundingClientRect());
    return await page.evaluate(() => {
      const t = performance.timing;
      const navStart = t.navigationStart || performance.timeOrigin;
      const paint = performance.getEntriesByType("paint") ?? [];
      const fcp = paint.find((p) => p.name === "first-contentful-paint");
      const resources = performance.getEntriesByType("resource") ?? [];
      const transfer = resources.reduce(
        (sum, r) => sum + (r.transferSize || 0),
        0,
      );
      const decoded = resources.reduce(
        (sum, r) => sum + (r.decodedBodySize || 0),
        0,
      );
      const jsBytes = resources
        .filter((r) => r.name.endsWith(".js"))
        .reduce((s, r) => s + (r.decodedBodySize || 0), 0);
      const cssBytes = resources
        .filter((r) => r.name.endsWith(".css"))
        .reduce((s, r) => s + (r.decodedBodySize || 0), 0);
      return {
        url: window.location.pathname,
        dcl: t.domContentLoadedEventEnd - navStart,
        load: t.loadEventEnd - navStart,
        fcp: fcp ? Math.round(fcp.startTime) : null,
        transferKB: Math.round(transfer / 1024),
        decodedKB: Math.round(decoded / 1024),
        jsKB: Math.round(jsBytes / 1024),
        cssKB: Math.round(cssBytes / 1024),
        requests: resources.length,
      };
    });
  } finally {
    await page.close();
  }
}

async function main() {
  const outDir = path.join(ROOT, "tmp/p3-v2");
  await fs.mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: VP });
  const page = await context.newPage();

  await signIn(page);
  const wsId = await getWsId(page);
  if (!wsId) throw new Error("no workspace");
  console.log(`wsId = ${wsId}`);

  // ─── 1. Element-bounded captures of every RuleCard ────────────────────
  await page.goto(`${BASE}/workspaces/${wsId}/rules`, {
    waitUntil: "networkidle",
  });
  await page.waitForTimeout(900);
  // Scroll all the way through so every rule is laid out (lazy refs).
  await page.evaluate(() =>
    window.scrollTo(0, document.body.scrollHeight),
  );
  await page.waitForTimeout(300);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);

  // Each rule's RuleCard is anchored by its summary text (we know the seed).
  const ruleHeadings = [
    "色彩",
    "字体",
    "版式构图",
    "影像风格",
    "文案语气",
    "Logo 规范",
  ];
  for (const h of ruleHeadings) {
    // Scroll the heading into view so the bounding rect is valid for the
    // sibling card immediately below it.
    await page.evaluate((t) => {
      const els = [...document.querySelectorAll("h2, h3")];
      const target = els.find(
        (e) => e.textContent && e.textContent.trim() === t,
      );
      if (target) target.scrollIntoView({ block: "start" });
    }, h);
    await page.waitForTimeout(250);
    const ok = await captureCard(
      page,
      h,
      path.join(outDir, `card_rule_${h.replace(/\s+/g, "-")}.png`),
      28,
    );
    if (ok) console.log(`✓ card_rule_${h}`);
  }

  // ─── 2. Fullpage uncropped (1920 wide, fullPage=true) ─────────────────
  const fullPages = [
    { route: `/workspaces/${wsId}/rules`, label: "rules-full" },
    { route: `/workspaces/${wsId}/generate`, label: "generate-3col-full" },
    {
      route: `/workspaces/${wsId}/projects/p3-project-spring`,
      label: "project-detail-full",
    },
    {
      route: `/workspaces/${wsId}/generations/p3-gen-1/versions/p3-ver-1/edit`,
      label: "editor-full",
    },
    {
      route: `/workspaces/${wsId}/compliance`,
      label: "compliance-full",
    },
  ];
  for (const fp of fullPages) {
    await page.goto(`${BASE}${fp.route}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    await page.screenshot({
      path: path.join(outDir, `${fp.label}.png`),
      fullPage: true,
    });
    console.log(`✓ ${fp.label}.png`);
  }

  // ─── 3. Performance metrics for each key route ────────────────────────
  const perfRoutes = [
    `/login`,
    `/workspaces`,
    `/workspaces/${wsId}`,
    `/workspaces/${wsId}/rules`,
    `/workspaces/${wsId}/generate`,
    `/workspaces/${wsId}/projects/p3-project-spring`,
    `/workspaces/${wsId}/generations/p3-gen-1/versions/p3-ver-1/edit`,
    `/account`,
    `/admin/workspaces`,
  ];
  const metrics = [];
  for (const r of perfRoutes) {
    try {
      // Fresh context per route — cleanest cache state for honest numbers.
      const freshCtx = await browser.newContext({ viewport: VP });
      // Re-auth in the fresh context.
      const setup = await freshCtx.newPage();
      await setup.goto(`${BASE}/login`, { waitUntil: "networkidle" });
      await setup.fill('input[type="email"]', EMAIL);
      await setup.fill('input[type="password"]', PASSWORD);
      await Promise.all([
        setup.waitForURL(/\/workspaces/, { timeout: 30000 }),
        setup.click('button[type="submit"]'),
      ]);
      await setup.close();
      const m = await measurePerf(freshCtx, `${BASE}${r}`);
      metrics.push({ route: r, ...m });
      console.log(
        `perf ${r.padEnd(60)} dcl=${m.dcl}ms load=${m.load}ms fcp=${m.fcp}ms ${m.decodedKB}KB(decoded) js=${m.jsKB}KB css=${m.cssKB}KB`,
      );
      await freshCtx.close();
    } catch (err) {
      console.error(`perf ${r}: ${err.message}`);
    }
  }
  await fs.writeFile(
    path.join(outDir, "perf.json"),
    JSON.stringify(metrics, null, 2),
  );
  // Plain-text report
  const lines = [
    "# P3 v2 performance · local prod build · 2026-05-28",
    "",
    "Captured against the local `next start` (production build) on a sandbox container — no real network, no DPR scaling, all responses served from cached Postgres + Redis. Numbers below are useful as ratios across routes, not as absolute production targets.",
    "",
    "| Route | DCL (ms) | load (ms) | FCP (ms) | Decoded (KB) | JS (KB) | CSS (KB) | Reqs |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const m of metrics) {
    lines.push(
      `| \`${m.route}\` | ${m.dcl} | ${m.load} | ${m.fcp ?? "—"} | ${m.decodedKB} | ${m.jsKB} | ${m.cssKB} | ${m.requests} |`,
    );
  }
  // Build-time chunk inventory (from Next .next/static/chunks).
  lines.push(
    "",
    "## Next.js build chunks (bytes on disk, server start)",
    "",
    "| Chunk | KB |",
    "|---|---:|",
  );
  try {
    const chunksDir = path.join(ROOT, "apps/web/.next/static/chunks");
    const files = await fs.readdir(chunksDir);
    const stats = await Promise.all(
      files
        .filter((f) => f.endsWith(".js"))
        .map(async (f) => ({
          name: f,
          size: (await fs.stat(path.join(chunksDir, f))).size,
        })),
    );
    stats.sort((a, b) => b.size - a.size);
    for (const s of stats.slice(0, 12)) {
      lines.push(`| \`${s.name}\` | ${(s.size / 1024).toFixed(1)} |`);
    }
    const total = stats.reduce((sum, s) => sum + s.size, 0);
    lines.push(`| **total (${stats.length} files)** | **${(total / 1024).toFixed(1)}** |`);
  } catch (err) {
    lines.push(`(no build manifest — ${err.message})`);
  }
  await fs.writeFile(path.join(outDir, "perf.md"), lines.join("\n"));
  console.log(`wrote perf.json + perf.md`);

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
