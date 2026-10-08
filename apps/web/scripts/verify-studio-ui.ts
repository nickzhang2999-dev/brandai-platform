/** Real UI acceptance against a disposable database. No vendor API or save mocks. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { chromium, expect, type Browser, type BrowserContext, type Frame, type Page } from "playwright/test";
import { prisma } from "@brandai/db";
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
const privateFixtureValues: string[] = [];
const contexts: BrowserContext[] = [];
let browser: Browser | undefined, currentPage: Page | undefined, fixtureUserId: string | undefined, passed = 0;
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
          return {
            path: location.pathname, readyState: document.readyState,
            startup: [...document.querySelectorAll(".np-startup")].map(node => node.textContent?.slice(0, 600)),
            canvas: [...document.querySelectorAll(".tl-container, .tl-canvas")].map(node => ({ className: node.className, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })),
            webpack: { present: Boolean(win.webpackChunk_lovartai_lovart_shell), chunkCount: win.webpackChunk_lovartai_lovart_shell?.length ?? 0 },
            editorProbe: win.__novartAcceptanceProbe ?? null,
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
  context.on("response", response => {
    recordRequest("response", response.url(), response.request().method(), response.status());
    const url = new URL(response.url());
    if (url.origin === base.origin && response.status() >= 400 && !["/studio/unavailable"].includes(url.pathname)) {
      serverFailures.push(`${response.status()} ${url.pathname}`);
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
async function currentShapes(frame: Frame) {
  return frame.evaluate(() => (window as any).__novartAcceptanceEditor.getCurrentPageShapes() as Array<{ id: string; type: string; props: Record<string, unknown> }>);
}

try {
  const run = randomUUID().slice(0, 8), password = randomUUID();
  const email = `studio-ui-${run}@example.invalid`, nickname = `UI account ${run}`, brandName = `UI brand ${run}`;
  privateFixtureValues.push(email, password);
  const user = await prisma.user.create({ data: { email, name: nickname, passwordHash: await hashPassword(password) } });
  fixtureUserId = user.id;
  browser = await chromium.launch({ headless: true });
  const page = await newPage();
  await login(page, email, password);
  await expect(page.getByRole("heading", { name: "创建你的第一个品牌" })).toBeVisible();
  assert.equal(await prisma.brandWorkspace.count({ where: { ownerId: user.id } }), 0);
  check("real password login returns to studio without inventing a default brand");

  await page.getByRole("textbox", { name: "品牌名称", exact: true }).fill(brandName);
  await page.getByRole("button", { name: "进入工作台", exact: true }).click();
  await expect(page.locator(".np-startup")).toHaveCount(0, { timeout: 45_000 });
  await expect(page.locator("#ns-greeting")).toContainText(nickname);
  const workspace = await prisma.brandWorkspace.findFirstOrThrow({ where: { ownerId: user.id, name: brandName } });
  assert.equal(new URL(page.url()).searchParams.get("workspaceId"), workspace.id);
  check("brand creation UI creates a real workspace and displays the authenticated profile");

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
  check("native shape, Chinese text and pointer-drawn stroke autosave through real HTTP into the database");

  const draftText = `暂存的创作需求 ${run}`;
  await frame.getByTestId("agent-message-input").fill(draftText);
  await eventually("native chat draft saves to the account/project row", async () => {
    const row = await prisma.workbenchChatDraft.findUnique({ where: { userId_projectId: { userId: user.id, projectId } } });
    return row && JSON.stringify(row.inputForm).includes(draftText) ? row : null;
  });
  check("unsent native chat input is stored as a real per-user project draft");

  await page.getByTestId("studio-nav-settings").click();
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
  check("personal preferences persist through the reviewed settings form");

  await page.getByTestId("studio-nav-projects").click();
  await page.locator("#ns-project-refresh").click();
  const card = page.locator(`#ns-project-library [data-project-id="${projectId}"]`);
  await expect(card).toContainText("已保存画布");
  await card.locator('[data-action="favorite"]').click();
  await eventually("favorite stored on server", async () => {
    const row = await prisma.workbenchUserState.findUnique({ where: { userId_workspaceId: { userId: user.id, workspaceId: workspace.id } } });
    return row?.favorites.includes(projectId) ? row : null;
  });
  check("project library shows the saved canvas and persists its favorite");

  await card.locator('[data-action="open-project"]').click();
  frame = await editorFrame(page, projectId);
  // Establish an idle, acknowledged draft before the final edit. After filling,
  // navigate immediately: no save wait or sleep may mask the pagehide flush.
  await frame.waitForFunction(() => {
    const draft = (window as any).NovartM24Draft?.snapshot();
    return draft?.loaded && !draft.busy && !draft.restoring && !draft.composing && !draft.conflict && !draft.pendingChoice;
  });
  const finalDraftText = `离开页面前的末次需求 ${run}`;
  await frame.getByTestId("agent-message-input").fill(finalDraftText);
  await page.goto("about:blank", { waitUntil: "domcontentloaded" });
  await eventually("real pagehide flush stores the final unsent edit", async () => {
    const row = await prisma.workbenchChatDraft.findUnique({ where: { userId_projectId: { userId: user.id, projectId } } });
    return row && JSON.stringify(row.inputForm).includes(finalDraftText) ? row : null;
  });
  check("immediate navigation flushes the last draft edit to the server without waiting for autosave");

  // A second browser context has no editor IndexedDB/localStorage/cookies.
  // Reopening here cannot pass by reading a cached native document or draft.
  const fresh = await newPage();
  await login(fresh, email, password, `/studio?workspaceId=${workspace.id}#/workspace/${projectId}`);
  // URL fragments are not part of server redirects; use the visible project card.
  await expect(fresh.locator(".np-startup")).toHaveCount(0, { timeout: 45_000 });
  await fresh.getByTestId("studio-nav-projects").click();
  const freshCard = fresh.locator(`#ns-project-library [data-project-id="${projectId}"]`);
  await expect(freshCard.locator('[data-action="favorite"]')).toHaveAttribute("aria-pressed", "true");
  await freshCard.locator('[data-action="open-project"]').click();
  frame = await editorFrame(fresh, projectId);
  const reopened = await currentShapes(frame);
  for (const id of [ids.shape, ids.text, draw.id]) assert.ok(reopened.some(shape => shape.id === id), `Fresh native editor restores ${id}`);
  assert.ok(JSON.stringify(reopened.find(shape => shape.id === ids.text)).includes(text));
  await expect(frame.getByTestId("agent-message-input")).toContainText(finalDraftText, { timeout: 45_000 });
  await fresh.getByTestId("studio-nav-settings").click();
  await expect(fresh.locator("#ns-settings-nickname")).toHaveValue(newNickname);
  await expect(fresh.locator("#ns-settings-density")).toHaveValue("compact");
  await expect(fresh.locator("#ns-settings-motion")).toHaveValue("reduce");
  check("a fresh browser restores canvas, Chinese text, pen, chat draft, favorite and profile from server data");

  assert.deepEqual(networkProblems, [], "Studio must not access original vendor/business services");
  assert.equal(await prisma.generation.count({ where: { projectId } }), 0);
  check("core editing performs no remote business request or AI generation");
  console.log(`Studio UI acceptance: ${passed} checks passed against the real app and disposable database.`);
} catch (error) {
  await mkdir(artifacts, { recursive: true });
  await currentPage?.screenshot({ path: path.join(artifacts, "failure.png"), fullPage: true }).catch(() => undefined);
  // Never write cookies, request bodies, storage state, credentials or tokenized URLs.
  const diagnostics = {
    error: diagnosticMessage(error instanceof Error ? error.message : String(error)),
    networkProblems: networkProblems.slice(-30).map(diagnosticMessage),
    browserErrors: browserErrors.slice(-30).map(diagnosticMessage),
    serverFailures: serverFailures.slice(-30).map(diagnosticMessage),
    recentRequests,
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
