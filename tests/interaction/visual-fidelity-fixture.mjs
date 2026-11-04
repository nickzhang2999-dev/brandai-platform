/** Local synthetic UI regression only; never claims provider/image-quality acceptance. */
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import assert from "node:assert/strict";

const webRoot = fileURLToPath(new URL("../../apps/web/", import.meta.url));
const requireWeb = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const requireTsx = createRequire(requireWeb.resolve("tsx"));
const { build } = requireTsx("esbuild");
const { outputFiles } = await build({ stdin: { contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { OwnedGenerationCard } from './src/components/owned-canvas/OwnedGenerationCard';
const sha='a'.repeat(64);
const image={versionId:'v',assetId:'a',assetSha256:sha,width:1,height:1,mimeType:'image/png',url:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII='};
window.reads=0; window.inserts=0;
const task={mode:'generate',requestId:'r',mutationId:'m',status:'SUCCEEDED',resultState:'READY',results:[image],displayText:'UI fixture',appliedBrandRuleCount:null,brandRuleReceipts:[],canRetryArchive:false};
const api={readCompliance:async()=>{window.reads++; return {status:'SUCCEEDED',checkedImageSha256:sha,canRetry:false,report:{overall:'PASS',textResults:[],visualResults:[]},visualFidelityReport:window.report??null};}};
window.render=()=>createRoot(document.getElementById('root')).render(<OwnedGenerationCard task={task} api={api} compact canEdit onTask={()=>{}} onNotice={()=>{}} onInsert={async()=>{window.inserts++;}}/>);
window.render();`, resolveDir: webRoot, loader: "tsx" }, bundle: true, write: false, platform: "browser", jsx: "automatic" });
const server = createServer((req, res) => { res.setHeader("Content-Type", req.url === "/app.js" ? "application/javascript" : "text/html; charset=utf-8"); res.end(req.url === "/app.js" ? outputFiles[0].contents : '<!doctype html><meta charset="utf-8"><h1>Synthetic UI fixture</h1><div id="root"></div><script src="/app.js"></script>'); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.NOVART_CHROMIUM_EXECUTABLE || process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const page = await browser.newPage();
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const panel = page.getByTestId("owned-visual-fidelity");
  await panel.waitFor();
  assert.equal(await panel.getAttribute("open"), null);
  await panel.locator("summary").click();
  assert.match(await panel.innerText(), /尚无主体级证据/);
  await page.getByText("品牌检查", { exact: true }).click();
  const read = page.getByRole("button", { name: "读取品牌检查" });
  await read.click();
  await page.waitForFunction(() => window.reads === 1);
  assert.equal(await panel.getAttribute("data-status"), "unknown", "legacy PASS is not subject evidence");
  for (const overall of ["pass", "fail", "unknown"]) {
    await page.evaluate(overall => { window.report = { revision: "visual-fidelity-guard/1", inputSha256: 'b'.repeat(64), outputSha256: 'a'.repeat(64), overall, checkPerformed: true, checks: [{ id: 'color', status: overall, objectRegion: '左侧苹果', observation: '表皮颜色逐项核对', evidence: '对象区域视觉证据' }], warnings: [] }; }, overall);
    await read.click();
    await page.waitForFunction(value => document.querySelector('[data-testid="owned-visual-fidelity"]').dataset.status === value, overall);
    assert.match(await panel.innerText(), /左侧苹果.*表皮颜色逐项核对/s);
    if (overall === "fail") {
      assert.match(await panel.innerText(), /图片已保留/);
      assert.equal(await page.getByAltText("生成结果").count(), 1);
      await page.getByRole("button", { name: "恢复到画布" }).click();
      assert.equal(await page.evaluate(() => window.inserts), 1);
    }
  }
  await page.evaluate(() => { window.report.overall = 'pass'; window.report.outputSha256 = 'c'.repeat(64); });
  await read.click();
  await page.waitForFunction(() => document.querySelector('[data-testid="owned-visual-fidelity"]').innerText.includes('检查对应的图片已变化'));
  assert.equal(await panel.getAttribute("data-status"), "unknown");
  assert.doesNotMatch(await panel.innerText(), /左侧苹果/);
  assert.deepEqual(errors, []);
  console.log("PASS: local Chromium fixture — collapse, legacy missing evidence, pass/fail/unknown, failure image retention/insertion, stale report isolation; no provider calls");
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
