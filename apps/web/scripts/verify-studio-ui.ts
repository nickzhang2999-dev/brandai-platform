/** Real UI acceptance against a disposable database. No vendor API or save mocks. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { chromium, expect, type Browser, type BrowserContext, type Frame, type Page, type Route } from "playwright/test";
import { prisma } from "@brandai/db";
import sharp from "sharp";
import { hashPassword } from "../src/lib/password";

const base = new URL(process.env.WORKBENCH_TEST_URL ?? "http://127.0.0.1:3000");
const database = new URL(process.env.DATABASE_URL ?? "http://invalid");
if (database.pathname !== "/novart_integration_test" || !["localhost", "127.0.0.1"].includes(database.hostname)
  || !["localhost", "127.0.0.1"].includes(base.hostname)) {
  throw new Error("UI acceptance requires a loopback app and the disposable novart_integration_test database.");
}
const artifacts = path.resolve(process.env.WORKBENCH_UI_ARTIFACTS ?? ".novart-ui-artifacts", `port-${base.port || "80"}`);
const networkProblems: string[] = [], browserErrors: string[] = [], serverFailures: string[] = [];
const navigations: Array<{ path: string; main: boolean; at: number }> = [];
const recentRequests: Array<{ phase: string; path: string; method: string; status?: number; failure?: string; count: number }> = [];
const stateReceipts: Array<Record<string, unknown>> = [];
const privateFixtureValues: string[] = [];
const contexts: BrowserContext[] = [];
let browser: Browser | undefined, currentPage: Page | undefined, fixtureUserId: string | undefined, passed = 0, activeStep = "initialize";
const step = (label: string) => { activeStep = label; console.log(`STEP ${label}`); };
const check = (label: string) => { passed++; console.log(`PASS ${label}`); };
function diagnosticMessage(value: string) {
  let text = value;
  for (const secret of privateFixtureValues) text = text.replaceAll(secret, "[redacted fixture value]");
  return text.replace(/https?:\/\/[^\s"'<>]+/g, value => {
    try { const url = new URL(value); return url.origin + url.pathname; } catch { return "[URL]"; }
  }).slice(0, 1600);
}
function recordRequest(phase: string, url: string, method: string, status?: number, failure?: string) {
  const pathname = new URL(url).pathname;
  if (/\/(?:log\/acceptor|telemetry)(?:\/|$)/.test(pathname)) return;
  const previous = recentRequests.find(item => item.phase === phase && item.path === pathname && item.method === method && item.status === status && item.failure === failure);
  if (previous) { previous.count++; return; }
  recentRequests.push({ phase, path: pathname, method, status, failure: failure ? diagnosticMessage(failure) : undefined, count: 1 });
  if (recentRequests.length > 50) recentRequests.shift();
}
async function frameDiagnostics(page: Page | undefined) {
  if (!page) return [];
  return Promise.all(page.frames().map(async frame => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        frame.evaluate(() => {
          const win = window as any;
          const draft = win.NovartM24Draft?.snapshot(), studio = win.NovartStudio?.snapshot();
          return {
            path: location.pathname, readyState: document.readyState,
            startup: [...document.querySelectorAll(".np-startup")].map(node => node.textContent?.slice(0, 600)),
            canvas: [...document.querySelectorAll(".tl-container, .tl-canvas")].map(node => ({ className: node.className, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })),
            webpack: { present: Boolean(win.webpackChunk_lovartai_lovart_shell), chunkCount: win.webpackChunk_lovartai_lovart_shell?.length ?? 0 },
            editorProbe: win.__novartAcceptanceProbe ?? null,
            // Omit native forms, account data, image URLs and browser caches.
            draft: draft ? {
              state: draft.state, revision: draft.revision, loaded: draft.loaded, busy: draft.busy,
              restoring: draft.restoring, composing: draft.composing, conflict: draft.conflict,
              pendingChoice: draft.pendingChoice, cacheFailed: draft.cacheFailed,
              awaitingCanvas: draft.awaitingCanvas, materializing: draft.materializing,
              checkingReferences: draft.checkingReferences, referenceIssueCount: draft.referenceIssues?.length,
            } : null,
            studio: studio ? {
              route: studio.route, stateLoaded: studio.stateLoaded, stateRevision: studio.stateRevision,
              metadataConflict: studio.metadataConflict, profileDirty: studio.profileDirty,
              favoritesDirty: studio.favoritesDirty, projectCount: studio.projectCount,
            } : null,
            receipts: [...document.querySelectorAll("#m24-draft-receipt, #novart-bar .nv-save, #ns-settings-status, #ns-meta-message")]
              .map(node => ({ id: node.id || "canvas-save", text: node.textContent?.slice(0, 400), state: (node as HTMLElement).dataset.draftState ?? (node as HTMLElement).dataset.saveState ?? (node as HTMLElement).dataset.state })),
            scripts: [...document.scripts].map(script => ({
              path: script.src ? new URL(script.src).pathname : "inline", type: script.type || "javascript", deferred: script.defer,
              state: script.type === "application/x-novart" ? "waiting-for-bootstrap" : script.src ? (performance.getEntriesByName(script.src).length ? "resource-observed" : "no-resource-entry") : "inline",
            })).slice(-50),
          };
        }),
        new Promise(resolve => { timeout = setTimeout(() => resolve({ path: new URL(frame.url()).pathname, error: "frame diagnostic timed out" }), 3500); }),
      ]);
    } catch (error) {
      return { path: new URL(frame.url()).pathname, error: diagnosticMessage(error instanceof Error ? error.message : String(error)) };
    } finally { clearTimeout(timeout); }
  }));
}
async function eventually<T>(label: string, read: () => Promise<T | null | false | undefined>, timeout = 45_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== null && result !== false && result !== undefined) return result as T;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out: ${label}`);
}
function decodeCanvas(canvas: string): Record<string, any> {
  assert.ok(canvas.startsWith("SHAKKERDATA://"));
  const value = JSON.parse(gunzipSync(Buffer.from(canvas.slice("SHAKKERDATA://".length), "base64")).toString("utf8"));
  const store = value?.tldrawSnapshot?.document?.store;
  assert.ok(store && typeof store === "object", "Native document must contain its real editor store");
  return store;
}
async function newPage(): Promise<Page> {
  const context = await browser!.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN", serviceWorkers: "allow" });
  contexts.push(context);
  // A network leak fails this test. It is never replaced with a success response.
  // Worker-remapped captured resources are permitted; direct remote traffic is not.
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (["http:", "https:"].includes(url.protocol) && url.origin !== base.origin) {
      networkProblems.push(`blocked direct request: ${url.origin}${url.pathname}`);
      await route.abort("blockedbyclient");
    } else await route.continue();
  });
  context.on("request", request => {
    recordRequest("request", request.url(), request.method());
    const url = new URL(request.url());
    if (request.serviceWorker() && ["http:", "https:"].includes(url.protocol) && url.origin !== base.origin) {
      networkProblems.push(`worker outbound request: ${url.origin}${url.pathname}`);
    }
  });
  context.on("response", async response => {
    recordRequest("response", response.url(), response.request().method(), response.status());
    const url = new URL(response.url());
    if (url.origin === base.origin && response.status() >= 400 && !["/studio/unavailable"].includes(url.pathname)) {
      serverFailures.push(`${response.status()} ${url.pathname}`);
    }
    if (url.origin === base.origin && ["/studio/draft", "/studio/state"].includes(url.pathname)) {
      const receipt: Record<string, unknown> = { step: activeStep, path: url.pathname, method: response.request().method(), status: response.status() };
      stateReceipts.push(receipt);
      if (stateReceipts.length > 30) stateReceipts.shift();
      try {
        const value = await response.json();
        receipt.keys = value && typeof value === "object" ? Object.keys(value).sort() : [];
        receipt.revision = value?.revision;
        receipt.hasInputForm = value?.inputForm !== null && typeof value?.inputForm === "object";
        receipt.inputTextLength = typeof value?.inputForm?.text === "string" ? value.inputForm.text.length : null;
        receipt.referenceIssues = Array.isArray(value?.referenceIssues) ? value.referenceIssues.length : "missing-or-invalid";
        if (!response.ok()) receipt.error = diagnosticMessage(String(value?.error ?? value?.msg ?? "No readable error"));
      } catch { receipt.error = "Response JSON unavailable"; }
    }
  });
  context.on("requestfailed", request => recordRequest("failed", request.url(), request.method(), undefined, request.failure()?.errorText));
  const page = await context.newPage();
  page.on("framenavigated", frame => navigations.push({ path: new URL(frame.url()).pathname, main: frame === page.mainFrame(), at: Date.now() }));
  page.setDefaultTimeout(30_000);
  page.on("pageerror", error => browserErrors.push(error.message.slice(0, 500)));
  currentPage = page;
  return page;
}
async function login(page: Page, email: string, password: string, destination = "/studio") {
  await page.goto(new URL(destination, base).href, { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/login\?/);
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.locator('form button[type="submit"]').click();
  await expect(page).toHaveURL(/\/studio(?:[?#]|$)/, { timeout: 30_000 });
}
async function editorFrame(page: Page, projectId: string) {
  const element = page.locator(`iframe[data-testid="studio-canvas-frame"][data-project-id="${projectId}"]`);
  await expect(element).toBeVisible({ timeout: 45_000 });
  const frame = await (await element.elementHandle())!.contentFrame();
  assert.ok(frame, "Project must mount the real editor frame");
  await frame.waitForFunction(() => {
    const win = window as any;
    const nativeCanvas = document.querySelector(".tl-container, .tl-canvas");
    const bounds = nativeCanvas?.getBoundingClientRect();
    const probe: Record<string, unknown> = {
      nativeDOM: Boolean(nativeCanvas), nativeVisible: Boolean(bounds && bounds.width > 0 && bounds.height > 0),
      webpackPresent: Boolean(win.webpackChunk_lovartai_lovart_shell), callbackRan: false,
    };
    win.__novartAcceptanceProbe = probe;
    // Never execute a captured module while native scripts are still loading.
    // Early require() can cache incomplete exports and itself prevent startup.
    if (!probe.nativeVisible || !probe.webpackPresent) return false;
    try {
      let app: any;
      win.webpackChunk_lovartai_lovart_shell.push([[`novart-ui-test-${Date.now()}`], {}, (require: any) => {
        probe.callbackRan = true;
        probe.moduleFactoryPresent = typeof require.m?.[37750] === "function";
        if (!probe.moduleFactoryPresent) return;
        app = require(37750).pW;
        probe.appType = typeof app;
        probe.getEditorType = typeof app?.getEditor;
      }]);
      const editor = app?.getEditor();
      probe.editorReturned = Boolean(editor);
      probe.storePresent = Boolean(editor?.store);
      probe.getCurrentPageShapesType = typeof editor?.getCurrentPageShapes;
      if (!editor?.getCurrentPageShapes || !editor?.store) return false;
      win.__novartAcceptanceEditor = editor;
      return true;
    } catch (error) { probe.error = error instanceof Error ? error.message : String(error); return false; }
  }, undefined, { timeout: 60_000 });
  await expect(frame.locator(".np-startup")).toHaveCount(0, { timeout: 45_000 });
  return frame;
}
async function studioReady(page: Page) {
  await expect(page.locator(".np-startup")).toHaveCount(0, { timeout: 45_000 });
  await page.waitForFunction(() => (window as any).NovartStudio?.snapshot().stateLoaded === true, undefined, { timeout: 30_000 });
  await expect(page.locator("#ns-settings-save")).toBeEnabled();
  await expect(page.locator("#ns-meta-alert")).toBeHidden();
}
async function draftReady(frame: Frame) {
  // The editor can mount before the draft GET is validated and restored. Never
  // type through that race or mistake a pending save for a pagehide baseline.
  const state = await frame.waitForFunction(() => {
    const draft = (window as any).NovartM24Draft?.snapshot();
    if (draft?.state === "error") return "error";
    if (draft?.conflict || draft?.pendingChoice) return "conflict";
    return draft?.loaded && !draft.busy && !draft.restoring && !draft.composing
      && !draft.materializing && !draft.awaitingCanvas && ["saved", "empty"].includes(draft.state) ? draft.state : false;
  }, undefined, { timeout: 45_000 });
  const value = await state.jsonValue();
  await state.dispose();
  assert.ok(["saved", "empty"].includes(value as string), `Native draft must acknowledge its server state, received ${value}`);
  await expect(frame.getByTestId("agent-message-input")).toBeEditable();
}
async function currentShapes(frame: Frame) {
  return frame.evaluate(() => (window as any).__novartAcceptanceEditor.getCurrentPageShapes() as Array<{ id: string; type: string; x: number; y: number; props: Record<string, unknown> }>);
}
// A generated 48 x 32 PNG tests user-uploaded bytes. It is never an AI result.
const uploadFixture = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAADAAAAAgCAIAAADbtmxLAAAAN0lEQVR4nO3OQQ0AMAgEMHSiBNmTMBccjyYV0Jp+p1R8ICQkJJQeCAkJCaUHQkJCQumBkJDQsg+b+YyX6uuGDAAAAABJRU5ErkJggg==", "base64");
async function nativeUpload(page: Page, frame: Frame, name: string) {
  await frame.getByTestId("nav-upload-menu-button").hover();
  const picker = page.waitForEvent("filechooser");
  await frame.getByTestId("upload-menu-uploadImage").click();
  const receipt = page.waitForResponse(response => new URL(response.url()).pathname === "/studio/material-upload" && response.request().method() === "POST");
  await (await picker).setFiles({ name, mimeType: "image/png", buffer: uploadFixture });
  const accepted = await receipt;
  assert.equal(accepted.status(), 202, "Upload must be accepted as a durable worker task");
  const task = await accepted.json();
  assert.equal(typeof task.taskId, "string");
  assert.ok(["PENDING", "RUNNING", "SUCCEEDED"].includes(task.status));
  return task as { taskId: string; projectId: string; status: string };
}
async function readableImage(frame: Frame, url: string) {
  return frame.evaluate(source => new Promise<number[]>((resolve, reject) => {
    const image = new Image(), timer = setTimeout(() => { image.src = ""; reject(Error("Image decoding timed out")); }, 20_000);
    image.onload = () => { clearTimeout(timer); resolve([image.naturalWidth, image.naturalHeight]); };
    image.onerror = () => { clearTimeout(timer); reject(Error("Authenticated image could not be decoded")); };
    image.src = source;
  }), url);
}

async function nativePngDownload(page: Page, frame: Frame, shapeId: string, label: string) {
  const type = await frame.evaluate(id => {
    const editor = (window as any).__novartAcceptanceEditor;
    editor.setCurrentTool("select"); editor.select(id);
    editor.zoomToSelection({ animation: { duration: 0 } });
    return editor.getShape(id)?.type;
  }, shapeId);
  // c-image has its own native toolbar; plain frames expose right-click Export
  // PNG. Do not call ExportService or intercept native image rendering methods.
  let button = frame.getByTestId("image-toolbar-download");
  if (type !== "c-image") {
    const bounds = await frame.locator(`.tl-shape[data-shape-id="${shapeId}"]`).boundingBox();
    assert.ok(bounds && bounds.width > 0 && bounds.height > 0);
    // The canvas hit-tests on its background overlay. Send actual pointer input.
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { button: "right" });
    await frame.getByTestId("context-menu-item-export").hover();
    button = frame.getByTestId("context-menu-item-export_png");
  }
  await expect(button).toBeVisible();
  const pending = page.waitForEvent("download", { timeout: 45_000 });
  await button.click();
  const download = await pending;
  assert.equal(await download.failure(), null);
  assert.match(download.suggestedFilename(), /\.png$/i, "This selection must download one PNG, not a ZIP or HTML error");
  await mkdir(artifacts, { recursive: true });
  const filename = path.join(artifacts, `${label}.png`);
  await download.saveAs(filename);
  const bytes = await readFile(filename);
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal((await sharp(bytes, { failOn: "error" }).metadata()).format, "png");
  // Full decoding, not metadata alone, detects truncated/invalid pixel data.
  return sharp(bytes, { failOn: "error" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}
async function assertUploadedPngDownload(page: Page, frame: Frame, shapeId: string, label: string) {
  const actual = await nativePngDownload(page, frame, shapeId, label);
  const expected = await sharp(uploadFixture, { failOn: "error" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([actual.info.width, actual.info.height, actual.info.channels], [48, 32, 4]);
  assert.deepEqual(actual.data, expected.data, "Native PNG export must preserve all uploaded pixels; compression bytes may differ");
  return actual;
}
async function createExportFrame(frame: Frame, uploadedId: string, suffix: string) {
  const ids = { frame: `shape:ui-export-frame-${suffix}`, image: `shape:ui-export-image-${suffix}`, geo: `shape:ui-export-geo-${suffix}` };
  await frame.evaluate(({ uploadedId, ids }) => {
    const editor = (window as any).__novartAcceptanceEditor, source = editor.getShape(uploadedId);
    if (!source || source.type !== "c-image") throw Error("Export frame requires a real uploaded native image");
    editor.createShapes([
      { id: ids.frame, type: "frame", x: 640, y: 500, props: { w: 160, h: 120, name: "PNG export acceptance", isAutoLayout: false } },
      { id: ids.image, type: "c-image", parentId: ids.frame, x: 16, y: 16, props: { ...source.props, w: 48, h: 32 } },
      { id: ids.geo, type: "geo", parentId: ids.frame, x: 88, y: 16, props: { w: 48, h: 48, color: "black", fill: "solid", dash: "solid" } },
    ]);
  }, { uploadedId, ids });
  return ids;
}
async function assertFramePngDownload(page: Page, frame: Frame, shapeId: string, label: string) {
  const actual = await nativePngDownload(page, frame, shapeId, label);
  assert.deepEqual([actual.info.width, actual.info.height, actual.info.channels], [160, 120, 4], "Frame PNG must use the frame bounds, not the image or infinite canvas bounds");
  const imageRegion = await sharp(actual.data, { raw: actual.info }).extract({ left: 16, top: 16, width: 48, height: 32 }).raw().toBuffer();
  const expected = await sharp(uploadFixture).ensureAlpha().raw().toBuffer();
  assert.deepEqual(imageRegion, expected, "The frame must contain every source-image pixel at its saved position");
  const center = (40 * actual.info.width + 112) * 4;
  // This capture renders the legacy geo solid fill as its light neutral palette.
  assert.deepEqual([...actual.data.subarray(center, center + 4)], [232, 232, 232, 255], "The separate filled geometry must render in the same PNG");
  assert.equal(actual.data[(70 * actual.info.width + 80) * 4 + 3], 0, "Empty frame area remains transparent instead of becoming an opaque placeholder");
  return actual;
}

try {
  const run = randomUUID().slice(0, 8), password = randomUUID();
  const email = `studio-ui-${run}@example.invalid`, nickname = `UI account ${run}`, brandName = `UI brand ${run}`;
  privateFixtureValues.push(email, password);
  const user = await prisma.user.create({ data: { email, name: nickname, passwordHash: await hashPassword(password) } });
  fixtureUserId = user.id;
  browser = await chromium.launch({ headless: true });
  const page = await newPage();
  step("password login and first brand");
  await login(page, email, password);
  await expect(page.getByRole("heading", { name: "创建你的第一个品牌" })).toBeVisible();
  assert.equal(await prisma.brandWorkspace.count({ where: { ownerId: user.id } }), 0);
  check("real password login returns to studio without inventing a default brand");

  await page.getByRole("textbox", { name: "品牌名称", exact: true }).fill(brandName);
  await page.getByRole("button", { name: "进入工作台", exact: true }).click();
  await studioReady(page);
  await expect(page.locator("#ns-greeting")).toContainText(nickname);
  const workspace = await prisma.brandWorkspace.findFirstOrThrow({ where: { ownerId: user.id, name: brandName } });
  assert.equal(new URL(page.url()).searchParams.get("workspaceId"), workspace.id);
  check("brand creation UI creates a real workspace and displays the authenticated profile");

  step("blank project and native canvas save");
  const creation = page.waitForResponse(response => new URL(response.url()).pathname === "/compare/api/create" && response.request().method() === "POST");
  await page.locator("#ns-create-blank").click();
  const created = await creation;
  assert.ok(created.ok(), `Project creation returned HTTP ${created.status()}`);
  const { projectId } = await created.json();
  assert.equal(typeof projectId, "string");
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  assert.equal(project.workspaceId, workspace.id);
  await expect(page).toHaveURL(new RegExp(`#/workspace/${projectId}$`));
  let frame = await editorFrame(page, projectId);
  assert.equal(new URL(frame.url()).searchParams.get("workspaceId"), workspace.id);
  check("blank-project button creates a scoped project and opens the captured native editor");

  const ids = { shape: `shape:ui-geo-${run}`, text: `shape:ui-text-${run}` }, text = `中文保存重开 ${run}`;
  await frame.evaluate(({ ids, text }) => {
    const editor = (window as any).__novartAcceptanceEditor;
    editor.createShapes([
      { id: ids.shape, type: "geo", x: 80, y: 90, props: { w: 180, h: 110 } },
      { id: ids.text, type: "text", x: 90, y: 230, props: { richText: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }, autoSize: true } },
    ]);
    editor.select(ids.shape);
    editor.updateShapes([{ id: ids.shape, type: "geo", x: 110, y: 100 }]);
    editor.selectNone();
  }, { ids, text });
  // Fluent editor setters return the entire live Editor, including window/DOM
  // references. Return only the selected tool id across the browser boundary.
  assert.equal(await frame.evaluate(() => {
    const editor = (window as any).__novartAcceptanceEditor;
    editor.setCurrentTool("draw");
    return editor.getCurrentToolId();
  }), "draw");
  const canvas = frame.locator(".tl-canvas").first(), box = await canvas.boundingBox();
  assert.ok(box && box.width > 400 && box.height > 300, "Native canvas has an actual interactive viewport");
  await page.mouse.move(box.x + 180, box.y + 160);
  await page.mouse.down();
  await page.mouse.move(box.x + 250, box.y + 190, { steps: 8 });
  await page.mouse.move(box.x + 300, box.y + 155, { steps: 8 });
  await page.mouse.up();
  assert.equal(await frame.evaluate(() => {
    const editor = (window as any).__novartAcceptanceEditor;
    editor.setCurrentTool("select");
    return editor.getCurrentToolId();
  }), "select");
  const draw = (await currentShapes(frame)).find(shape => shape.type === "draw");
  assert.ok(draw, "A real pointer gesture with the native pen creates a draw shape");
  const document = await eventually("native autosave writes text, moved shape and pen to the database", async () => {
    const row = await prisma.editorDocument.findUnique({ where: { projectId } });
    if (!row?.canvas) return null;
    const store = decodeCanvas(row.canvas);
    return store[ids.shape]?.x === 110 && JSON.stringify(store[ids.text]).includes(text) && store[draw.id] ? row : null;
  }, 60_000);
  assert.ok(document.revision >= 1);
  await expect(frame.locator("#novart-bar .nv-save")).toHaveAttribute("data-save-state", "saved", { timeout: 30_000 });
  await expect(frame.locator("#novart-bar .nv-save")).toContainText("已保存到服务器");
  check("native shape, Chinese text and pointer-drawn stroke autosave through real HTTP into the database");

  let uploadedImage: Awaited<ReturnType<typeof currentShapes>>[number] | undefined;
  let recoveredImage: Awaited<ReturnType<typeof currentShapes>>[number] | undefined;
  let uploadTaskId: string | undefined;
  let exportFrame: Awaited<ReturnType<typeof createExportFrame>> | undefined;
  let exportedFramePixels: Buffer | undefined;
  let generatedImage: Awaited<ReturnType<typeof currentShapes>>[number] | undefined;
  let generatedResult: { versionId: string; assetId: string; assetSha256: string; url: string; width: number; height: number } | undefined;
  let generationRequestId: string | undefined;
  if (process.env.WORKBENCH_TEST_MATERIAL_UPLOAD === "1") {
    step("native image upload, worker persistence and document save");
    const task = await nativeUpload(page, frame, `studio-ui-${run}.png`);
    uploadTaskId = task.taskId;
    assert.equal(task.projectId, projectId);
    const taskRow = frame.getByTestId("product-upload-list").locator(`[data-task-id="${task.taskId}"]`);
    await expect(taskRow).toHaveAttribute("data-status", "SUCCEEDED", { timeout: 120_000 });
    uploadedImage = await eventually("uploaded material enters a real native image shape", async () => {
      return (await currentShapes(frame)).find(shape => shape.id === `shape:novart-upload-${task.taskId}`);
    });
    assert.equal(uploadedImage.type, "c-image");
    const imageUrl = new URL(String(uploadedImage.props.url), base);
    assert.equal(imageUrl.origin, base.origin);
    assert.match(imageUrl.pathname, new RegExp(`^/api/workspaces/${workspace.id}/assets/[^/]+/raw$`));
    assert.equal(imageUrl.search, "");
    const assetId = imageUrl.pathname.split("/").at(-2)!;
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: assetId } });
    assert.equal(asset.workspaceId, workspace.id);
    assert.equal(asset.source, "UPLOAD");
    assert.equal(asset.mimeType, "image/png");
    assert.equal(asset.sizeBytes, uploadFixture.length);
    assert.ok(asset.storageKey && !asset.url.startsWith("data:") && !asset.url.startsWith("blob:"));
    assert.equal(await prisma.projectAsset.count({ where: { projectId, assetId } }), 1);
    const raw = await page.context().request.get(imageUrl.href);
    assert.equal(raw.status(), 200);
    assert.equal(createHash("sha256").update(await raw.body()).digest("hex"), createHash("sha256").update(uploadFixture).digest("hex"));
    assert.deepEqual(await readableImage(frame, imageUrl.pathname), [48, 32]);
    await frame.evaluate(() => { (window as any).__novartAcceptanceEditor.undo(); });
    assert.ok(!(await currentShapes(frame)).some(shape => shape.id === uploadedImage!.id), "Image insertion is undoable");
    await frame.evaluate(() => { (window as any).__novartAcceptanceEditor.redo(); });
    assert.ok((await currentShapes(frame)).some(shape => shape.id === uploadedImage!.id), "Redo restores the uploaded image");
    await eventually("native autosave persists uploaded image reference", async () => {
      const row = await prisma.editorDocument.findUnique({ where: { projectId } });
      return row?.canvas && decodeCanvas(row.canvas)[uploadedImage!.id]?.props.url === imageUrl.pathname ? row : null;
    }, 60_000);
    await expect(frame.locator("#novart-bar .nv-save")).toHaveAttribute("data-save-state", "saved");
    check("native upload menu uses a durable worker, real stored bytes and linked asset, then saves an undoable image shape");

    step("native image and composite frame PNG downloads");
    await assertUploadedPngDownload(page, frame, uploadedImage.id, "uploaded-image");
    exportFrame = await createExportFrame(frame, uploadedImage.id, run);
    exportedFramePixels = (await assertFramePngDownload(page, frame, exportFrame.frame, "composite-frame")).data;
    await eventually("export frame and both children persist to the real document", async () => {
      const row = await prisma.editorDocument.findUnique({ where: { projectId } });
      if (!row?.canvas) return null;
      const store = decodeCanvas(row.canvas);
      return store[exportFrame!.frame]?.props.w === 160 && store[exportFrame!.image]?.parentId === exportFrame!.frame
        && store[exportFrame!.geo]?.parentId === exportFrame!.frame ? row : null;
    });
    check("native image download and frame right-click PNG export preserve uploaded pixels and composite the saved geometry");

    step("accepted upload survives leaving the page");
    const detached = await nativeUpload(page, frame, `studio-ui-detached-${run}.png`);
    // No task-completion wait: immediately unload the native frame after 202.
    await page.goto("about:blank", { waitUntil: "domcontentloaded" });
    await eventually("worker completes accepted upload without a live editor", async () => {
      const response = await page.context().request.get(new URL(`/studio/material-upload?workspaceId=${workspace.id}&projectId=${projectId}&taskId=${detached.taskId}`, base).href);
      assert.equal(response.status(), 200);
      const value = await response.json();
      assert.notEqual(value.status, "FAILED", `Detached upload failed: ${value.error || "unknown"}`);
      return value.status === "SUCCEEDED" ? value : null;
    }, 120_000);
    await page.goto(new URL(`/studio?workspaceId=${workspace.id}#/workspace/${projectId}`, base).href, { waitUntil: "domcontentloaded" });
    await studioReady(page); frame = await editorFrame(page, projectId);
    const detachedRow = frame.getByTestId("product-upload-list").locator(`[data-task-id="${detached.taskId}"]`);
    await expect(detachedRow).toHaveAttribute("data-status", "SUCCEEDED");
    await detachedRow.locator('[data-action="insert"]').click();
    recoveredImage = await eventually("recovered task can be inserted from the visible receipt", async () => {
      return (await currentShapes(frame)).find(shape => shape.id === `shape:novart-upload-${detached.taskId}`);
    });
    await eventually("recovered upload is saved in the native document", async () => {
      const row = await prisma.editorDocument.findUnique({ where: { projectId } });
      return row?.canvas && decodeCanvas(row.canvas)[recoveredImage!.id] ? row : null;
    });
    assert.deepEqual(await readableImage(frame, String(recoveredImage.props.url)), [48, 32]);
    check("accepted upload completes after page unload and its server receipt restores insertion without uploading the file again");
  } else console.log("SKIP material upload journey: WORKBENCH_TEST_MATERIAL_UPLOAD=1 and disposable storage/worker are required; upload is not verified by this run.");

  if (process.env.WORKBENCH_TEST_GENERATION === "1") {
    step("native image generation with a real provider and durable response-loss retry");
    await draftReady(frame);
    await frame.waitForFunction(() => (window as any).NovartProductWorkflowSnapshot?.().loaded === true);
    await frame.getByTestId("product-generation-settings").locator("summary").click();
    await frame.getByRole("combobox", { name: "生成图片比例", exact: true }).selectOption("1:1");
    await frame.getByRole("combobox", { name: "生成图片分辨率", exact: true }).selectOption("1K");
    await frame.getByTestId("product-generation-settings").locator("summary").click();
    const submittedMutations: string[] = [];
    let responseLost = false;
    const fault = async (route: Route) => {
      if (route.request().method() !== "POST") return route.continue();
      submittedMutations.push(String(route.request().postDataJSON().mutationId));
      if (!responseLost) {
        // Forward the real request to the app, then lose only its response.
        // This does not synthesize a Generation, provider output or Asset.
        const response = await route.fetch();
        assert.equal(response.status(), 202, "Real provider/storage must be configured; unconfigured generation cannot pass this opt-in run");
        responseLost = true;
        return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Acceptance test: generation receipt lost" }) });
      }
      return route.continue();
    };
    await page.route("**/studio/generation?**", fault);
    let accepted: { requestId: string; generationId: string; mutationId: string; projectId: string };
    try {
      await frame.getByTestId("agent-message-input").fill(`Create one simple violet geometric poster on a white background, with no text. Acceptance ${run}`);
      const receipt = page.waitForResponse(response => new URL(response.url()).pathname === "/studio/generation" && response.request().method() === "POST" && response.status() === 202);
      await frame.getByTestId("agent-send-button").click();
      accepted = await (await receipt).json();
    } finally { await page.unroute("**/studio/generation?**", fault); }
    assert.equal(accepted.projectId, projectId);
    assert.equal(submittedMutations.length, 2, "Exactly one bounded lost-response retry is expected");
    assert.equal(submittedMutations[0], submittedMutations[1], "A lost 202 must reuse its mutation, never pay for another request");
    assert.equal(accepted.mutationId, submittedMutations[0]);
    generationRequestId = accepted.requestId;
    await expect(frame.getByTestId("agent-message-input")).toHaveText("");
    const completed = await eventually("real generation and result archive complete", async () => {
      const response = await page.context().request.get(new URL(`/studio/generation?workspaceId=${workspace.id}&projectId=${projectId}&requestId=${accepted.requestId}`, base).href);
      assert.equal(response.status(), 200);
      const value = await response.json();
      assert.notEqual(value.status, "FAILED", `Generation failed: ${value.error || "unknown"}`);
      assert.notEqual(value.resultState, "FAILED", `Result archive failed: ${value.archiveError || "unknown"}`);
      return value.status === "SUCCEEDED" && value.resultState === "READY" ? value : null;
    }, 720_000);
    assert.equal(completed.results.length, 1);
    generatedResult = completed.results[0];
    assert.ok(generatedResult);
    const generation = await prisma.generation.findUniqueOrThrow({ where: { id: accepted.generationId } });
    assert.equal(generation.workspaceId, workspace.id); assert.equal(generation.projectId, projectId); assert.equal(generation.status, "SUCCEEDED");
    assert.equal(await prisma.generation.count({ where: { projectId } }), 1, "The lost response created only one paid generation row");
    const version = await prisma.generationVersion.findUniqueOrThrow({ where: { id: generatedResult.versionId } });
    assert.equal(version.generationId, accepted.generationId);
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: generatedResult.assetId } });
    assert.equal(asset.workspaceId, workspace.id); assert.equal(asset.generationVersionId, version.id);
    assert.ok(asset.storageKey && !asset.url.startsWith("data:") && !asset.url.startsWith("blob:"));
    assert.equal(await prisma.projectAsset.count({ where: { projectId, assetId: asset.id } }), 1);
    const rawUrl = new URL(generatedResult.url, base);
    assert.equal(rawUrl.origin, base.origin);
    assert.equal(rawUrl.pathname, `/api/workspaces/${workspace.id}/assets/${asset.id}/raw`);
    const bytes = await page.context().request.get(rawUrl.href);
    assert.equal(bytes.status(), 200);
    assert.equal(createHash("sha256").update(await bytes.body()).digest("hex"), generatedResult.assetSha256);
    assert.deepEqual(await readableImage(frame, rawUrl.pathname), [generatedResult.width, generatedResult.height]);
    generatedImage = await eventually("real generated result enters original native c-image", async () => (await currentShapes(frame)).find(shape => shape.id === `shape:novart-generation-${version.id}`));
    assert.equal(generatedImage.type, "c-image"); assert.equal(generatedImage.props.url, rawUrl.pathname);
    await frame.evaluate(() => { (window as any).__novartAcceptanceEditor.undo(); });
    assert.ok(!(await currentShapes(frame)).some(shape => shape.id === generatedImage!.id));
    await frame.evaluate(() => { (window as any).__novartAcceptanceEditor.redo(); });
    await eventually("native document persists the real generated material", async () => {
      const row = await prisma.editorDocument.findUnique({ where: { projectId } });
      return row?.canvas && decodeCanvas(row.canvas)[generatedImage!.id]?.props.url === rawUrl.pathname ? row : null;
    }, 60_000);
    await eventually("202 clears only the submitted native draft on the server", async () => {
      const row = await prisma.workbenchChatDraft.findUnique({ where: { userId_projectId: { userId: user.id, projectId } } });
      return row && !(row.inputForm as { text?: string } | null)?.text ? row : null;
    });
    check("real provider generation is idempotent across lost 202, archived as linked authenticated bytes, and inserted with native undo/save");
  } else console.log("SKIP generation journey: WORKBENCH_TEST_GENERATION=1 plus a real configured provider/storage/worker is required; no AI generation is verified by this run.");

  step("native chat draft autosave and checked receipt");
  await draftReady(frame);
  const draftText = `暂存的创作需求 ${run}`;
  await frame.getByTestId("agent-message-input").fill(draftText);
  await eventually("native chat draft saves to the account/project row", async () => {
    const row = await prisma.workbenchChatDraft.findUnique({ where: { userId_projectId: { userId: user.id, projectId } } });
    return row && (row.inputForm as { text?: string } | null)?.text === draftText ? row : null;
  });
  await expect(frame.locator("#m24-draft-receipt")).toHaveAttribute("data-draft-state", "saved", { timeout: 30_000 });
  await expect(frame.locator("#m24-draft-receipt [role=status]")).toHaveText("草稿已随账号保存");
  await draftReady(frame);
  check("unsent native chat input is stored as a real per-user project draft");

  step("profile settings save and receipt");
  await page.getByTestId("studio-nav-settings").click();
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(page.locator("#ns-settings-save")).toBeEnabled();
  const newNickname = `Saved profile ${run}`;
  await page.locator("#ns-settings-nickname").fill(newNickname);
  await page.locator("#ns-settings-density").selectOption("compact");
  await page.locator("#ns-settings-motion").selectOption("reduce");
  await page.locator("#ns-settings-save").click();
  await eventually("profile preferences stored on server", async () => {
    const row = await prisma.workbenchUserState.findUnique({ where: { userId_workspaceId: { userId: user.id, workspaceId: workspace.id } } });
    const profile = row?.profile as { nickname?: string; density?: string; motion?: string } | undefined;
    return profile?.nickname === newNickname && profile.density === "compact" && profile.motion === "reduce" ? row : null;
  });
  await expect(page.locator("#ns-settings-status")).toHaveAttribute("data-state", "saved");
  await expect(page.locator("#ns-settings-status")).toHaveText("偏好已随账号与品牌保存");
  await expect(page.locator("#ns-meta-alert")).toBeHidden();
  check("personal preferences persist through the reviewed settings form");

  step("project library favorite save and receipt");
  await page.getByTestId("studio-nav-projects").click();
  await expect(page).toHaveURL(/#\/projects$/);
  await page.locator("#ns-project-refresh").click();
  const card = page.locator(`#ns-project-library [data-project-id="${projectId}"]`);
  await expect(card).toContainText("已保存画布");
  await expect(card.locator('[data-action="favorite"]')).toHaveAttribute("aria-disabled", "false");
  await card.locator('[data-action="favorite"]').click();
  await eventually("favorite stored on server", async () => {
    const row = await prisma.workbenchUserState.findUnique({ where: { userId_workspaceId: { userId: user.id, workspaceId: workspace.id } } });
    return row?.favorites.includes(projectId) ? row : null;
  });
  await expect(card.locator('[data-action="favorite"]')).toHaveAttribute("aria-pressed", "true");
  await expect(card.locator('[data-action="favorite"]')).toHaveAttribute("aria-disabled", "false");
  await expect(page.locator("#ns-meta-alert")).toBeHidden();
  await expect(page.locator("#ns-toast")).toHaveText("收藏已随账号与品牌保存");
  check("project library shows the saved canvas and persists its favorite");

  step("last draft edit followed by immediate pagehide");
  await card.locator('[data-action="open-project"]').click();
  frame = await editorFrame(page, projectId);
  // Establish an idle, acknowledged draft before the final edit. After filling,
  // navigate immediately: no save wait or sleep may mask the pagehide flush.
  await draftReady(frame);
  const finalDraftText = `离开页面前的末次需求 ${run}`;
  await frame.getByTestId("agent-message-input").fill(finalDraftText);
  await page.goto("about:blank", { waitUntil: "domcontentloaded" });
  await eventually("real pagehide flush stores the final unsent edit", async () => {
    const row = await prisma.workbenchChatDraft.findUnique({ where: { userId_projectId: { userId: user.id, projectId } } });
    return row && (row.inputForm as { text?: string } | null)?.text === finalDraftText ? row : null;
  });
  check("immediate navigation flushes the last draft edit to the server without waiting for autosave");

  // A second browser context has no editor IndexedDB/localStorage/cookies.
  // Reopening here cannot pass by reading a cached native document or draft.
  step("fresh browser restores server data");
  const fresh = await newPage();
  await login(fresh, email, password, `/studio?workspaceId=${workspace.id}#/workspace/${projectId}`);
  // URL fragments are not part of server redirects; use the visible project card.
  await studioReady(fresh);
  await fresh.getByTestId("studio-nav-projects").click();
  const freshCard = fresh.locator(`#ns-project-library [data-project-id="${projectId}"]`);
  await expect(freshCard.locator('[data-action="favorite"]')).toHaveAttribute("aria-pressed", "true");
  await freshCard.locator('[data-action="open-project"]').click();
  frame = await editorFrame(fresh, projectId);
  await frame.waitForFunction(ids => {
    const shapes = (window as any).__novartAcceptanceEditor.getCurrentPageShapes();
    return ids.every(id => shapes.some((shape: { id: string }) => shape.id === id));
  }, [ids.shape, ids.text, draw.id], { timeout: 30_000 });
  const reopened = await currentShapes(frame);
  for (const id of [ids.shape, ids.text, draw.id]) assert.ok(reopened.some(shape => shape.id === id), `Fresh native editor restores ${id}`);
  assert.equal(reopened.find(shape => shape.id === ids.shape)?.x, 110);
  assert.equal(reopened.find(shape => shape.id === ids.shape)?.y, 100);
  assert.deepEqual(reopened.find(shape => shape.id === draw.id)?.props, draw.props, "Fresh editor restores the actual pointer stroke geometry");
  assert.ok(JSON.stringify(reopened.find(shape => shape.id === ids.text)).includes(text));
  if (uploadedImage && uploadTaskId) {
    const restored = reopened.find(shape => shape.id === uploadedImage.id);
    assert.ok(restored, "Fresh browser restores uploaded native image from server document");
    // Undefined optional native properties are intentionally absent after JSON.
    assert.deepEqual(restored.props, JSON.parse(JSON.stringify(uploadedImage.props)));
    assert.deepEqual(await readableImage(frame, String(restored.props.url)), [48, 32]);
    const restoredTask = frame.getByTestId("product-upload-list").locator(`[data-task-id="${uploadTaskId}"]`);
    await expect(restoredTask).toHaveAttribute("data-status", "SUCCEEDED");
    await restoredTask.locator('[data-action="insert"]').click();
    assert.equal((await currentShapes(frame)).filter(shape => shape.id === uploadedImage.id).length, 1, "Restored upload receipt never duplicates an existing image");
    check("fresh browser restores image bytes, image geometry and server task without relying on browser blobs or cache");
    await assertUploadedPngDownload(fresh, frame, uploadedImage.id, "fresh-uploaded-image");
    assert.ok(exportFrame && exportedFramePixels);
    const freshFrame = await assertFramePngDownload(fresh, frame, exportFrame.frame, "fresh-composite-frame");
    assert.deepEqual(freshFrame.data, exportedFramePixels, "Fresh-context frame export must reproduce saved composition without previous Blob/cache state");
    check("a fresh browser downloads the restored image and composite frame again with identical decoded pixels");
  }
  if (recoveredImage) {
    const restored = reopened.find(shape => shape.id === recoveredImage.id);
    assert.ok(restored, "Fresh browser restores the image recovered after page unload");
    assert.deepEqual(restored.props, JSON.parse(JSON.stringify(recoveredImage.props)));
    assert.deepEqual(await readableImage(frame, String(restored.props.url)), [48, 32]);
  }
  if (generatedImage && generatedResult && generationRequestId) {
    const restored = reopened.find(shape => shape.id === generatedImage.id);
    assert.ok(restored, "Fresh browser restores the real generated image from the server document");
    assert.deepEqual(restored.props, JSON.parse(JSON.stringify(generatedImage.props)));
    assert.deepEqual(await readableImage(frame, String(restored.props.url)), [generatedResult.width, generatedResult.height]);
    const receipt = frame.getByTestId("product-generation-tasks").locator(`[data-request-id="${generationRequestId}"]`);
    await expect(receipt).toHaveAttribute("data-result-state", "READY");
    await receipt.locator(`[data-version-id="${generatedResult.versionId}"]`).click();
    assert.equal((await currentShapes(frame)).filter(shape => shape.id === generatedImage.id).length, 1);
    check("fresh browser restores the real generation, its authenticated image and task without duplicating it");
  }
  await draftReady(frame);
  await expect(frame.getByTestId("agent-message-input")).toHaveText(finalDraftText);
  await fresh.getByTestId("studio-nav-settings").click();
  await expect(fresh.locator("#ns-settings-nickname")).toHaveValue(newNickname);
  await expect(fresh.locator("#ns-settings-density")).toHaveValue("compact");
  await expect(fresh.locator("#ns-settings-motion")).toHaveValue("reduce");
  check("a fresh browser restores canvas, Chinese text, pen, chat draft, favorite and profile from server data");

  assert.deepEqual(networkProblems, [], "Studio must not access original vendor/business services");
  assert.equal(await prisma.generation.count({ where: { projectId } }), generatedImage ? 1 : 0);
  check(generatedImage ? "core editing adds no generation beyond the single explicitly enabled provider journey" : "core editing performs no remote business request or AI generation");
  console.log(`Studio UI acceptance: ${passed} checks passed against the real app and disposable database.`);
} catch (error) {
  await mkdir(artifacts, { recursive: true });
  await currentPage?.screenshot({ path: path.join(artifacts, "failure.png"), fullPage: true }).catch(() => undefined);
  // Never write cookies, request bodies, storage state, credentials or tokenized URLs.
  const diagnostics = {
    step: activeStep,
    error: diagnosticMessage(error instanceof Error ? error.message : String(error)),
    networkProblems: networkProblems.slice(-30).map(diagnosticMessage),
    browserErrors: browserErrors.slice(-30).map(diagnosticMessage),
    serverFailures: serverFailures.slice(-30).map(diagnosticMessage),
    recentRequests,
    stateReceipts,
    navigations: navigations.slice(-20),
    frames: JSON.parse(JSON.stringify(await frameDiagnostics(currentPage), (_key, value: unknown) => typeof value === "string" ? diagnosticMessage(value) : value)),
    page: currentPage ? new URL(currentPage.url()).pathname : null,
  };
  await writeFile(path.join(artifacts, "diagnostics.json"), JSON.stringify(diagnostics, null, 2));
  console.error("Studio UI failure diagnostics: " + JSON.stringify(diagnostics));
  console.error(`UI acceptance failed; diagnostics saved to ${artifacts}`);
  throw error;
} finally {
  await Promise.allSettled(contexts.map(context => context.close()));
  await browser?.close();
  if (fixtureUserId) await prisma.user.delete({ where: { id: fixtureUserId } });
  await prisma.$disconnect();
}
