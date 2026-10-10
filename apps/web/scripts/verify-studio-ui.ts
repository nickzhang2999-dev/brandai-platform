/** Real authenticated owned-editor acceptance against a disposable database.
 * Actual pointer gestures drive the shipped UI; Prisma only verifies its data.
 * Uploads use the real worker/storage. Provider calls require an explicit flag.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { chromium, expect, type Browser, type BrowserContext, type Frame, type Page, type Route } from "playwright/test";
import { prisma } from "@brandai/db";
import sharp from "sharp";
import { hashPassword } from "../src/lib/password";
import { uploadReceiptMatches, summarizeUploadReceipt, summarizeUploadRow, type AcceptedUpload, type UploadEvidenceRow } from "./studio-upload-evidence";
import { classifyUploadFailure, uploadTaskToken } from "../src/lib/studio-upload-diagnostics";

const base = new URL(process.env.WORKBENCH_TEST_URL ?? "http://127.0.0.1:3000");
const database = new URL(process.env.DATABASE_URL ?? "http://invalid");
if (database.pathname !== "/novart_integration_test" || !["localhost", "127.0.0.1"].includes(database.hostname)
  || !["localhost", "127.0.0.1"].includes(base.hostname)) throw new Error("Owned UI acceptance requires a loopback app and disposable novart_integration_test database.");
if (process.env.WORKBENCH_TEST_IMAGE_EDIT === "1") throw new Error("The modification UI is available, but this script does not yet verify a real image-edit provider round trip. Do not count workflow persistence as image-edit acceptance.");
const artifacts = path.resolve(process.env.WORKBENCH_UI_ARTIFACTS ?? ".novart-ui-artifacts", `port-${base.port || "80"}`);
const networkProblems: string[] = [], browserErrors: string[] = [], requests: Array<{ path: string; method: string; status: number }> = [];
const privateValues: string[] = [], contexts: BrowserContext[] = [], fixtureUsers: string[] = [];
const acceptedUploads: AcceptedUpload[] = [], uploadReceipts = new Map<string, ReturnType<typeof summarizeUploadReceipt>>();
const deferred = ["Homepage attachments handoff", "Unsent creation draft autosave/pagehide recovery", "Workflow purpose and modification-target persistence", "Real EXACT-generation output frames", "Real image-modification provider acceptance", "Per-object/nested-frame export", "Compliance UI and notification deep links"];
let browser: Browser | undefined, currentPage: Page | undefined, step = "initialize", passed = 0, realHomepageHandoff = false, realDraftPersistence = false, realWorkflowPersistence = false;
const check = (label: string) => { passed++; console.log(`PASS ${label}`); };
const enter = (label: string) => { step = label; console.log(`STEP ${label}`); };
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function safe(value: string) {
  let result = value; privateValues.forEach(secret => { result = result.replaceAll(secret, "[private fixture]"); });
  return result.replace(/https?:\/\/[^\s"'<>]+/g, value => { try { const url = new URL(value); return url.origin + url.pathname; } catch { return "[URL]"; } }).slice(0, 1200);
}
async function eventually<T>(label: string, read: () => Promise<T | null | false | undefined>, timeout = 45000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await read(); if (result !== null && result !== false && result !== undefined) return result as T; await new Promise(resolve => setTimeout(resolve, 250)); }
  throw new Error(`Timed out: ${label}`);
}
type Shape = { id: string; typeName: string; type: string; x: number; y: number; rotation: number; props: Record<string, any>; meta?: Record<string, any> };
function store(canvas: string): Record<string, Shape> {
  assert.ok(canvas.startsWith("SHAKKERDATA://"));
  const value = JSON.parse(gunzipSync(Buffer.from(canvas.slice("SHAKKERDATA://".length), "base64")).toString("utf8"));
  assert.equal(value.novartOwnedCanvas?.version, 1, "Document must be saved by the owned model");
  assert.ok(value.tldrawSnapshot?.document?.store, "Compatible envelope must retain a document store"); return value.tldrawSnapshot.document.store;
}
async function saved(frame: Frame, projectId: string, predicate: (items: Shape[]) => boolean = () => true) {
  await expect(frame.getByTestId("owned-editor")).toHaveAttribute("data-save-state", "saved", { timeout: 45000 });
  return eventually("real saved document", async () => { const row = await prisma.editorDocument.findUnique({ where: { projectId } }); if (!row?.canvas) return null;
    const items = Object.values(store(row.canvas)).filter(item => item.typeName === "shape"); return predicate(items) ? { row, items } : null; });
}
type DraftExpectation = { prompt: string; ratio: string; quality: string };
type WorkflowExpectation = { mode: "generate" | "modify"; target: { shapeId: string; assetSha256: string } | null; references: Array<{ shapeId: string; assetSha256: string; purpose: "EXACT" | "ADAPTIVE" | "REFERENCE"; participates: boolean }> };
async function persistedDraft(userId: string, projectId: string, expected: DraftExpectation) {
  const row = await eventually("real composer draft row", async () => {
    const value = await prisma.workbenchChatDraft.findUnique({ where: { userId_projectId: { userId, projectId } } });
    const form = value?.inputForm as any;
    return value && form?.text === expected.prompt && form?.sizeSelection?.ratioKey === expected.ratio && form?.sizeSelection?.resolutionTier === expected.quality ? value : null;
  });
  assert.equal(row.userId, userId); assert.equal(row.projectId, projectId); assert.ok(row.revision >= 1);
  const form = row.inputForm as any;
  assert.deepEqual(form.paramList, []); assert.deepEqual(form.mentionPreviewList, []);
  assert.equal(form.lexicalJSONState.root.children.map((paragraph: any) => paragraph.children.map((node: any) => node.text ?? "\n").join("")).join("\n"), expected.prompt);
  return row;
}
async function restoredDraft(frame: Frame, expected: DraftExpectation) {
  await frame.getByRole("button", { name: "生成", exact: true }).click();
  await expect(frame.getByTestId("owned-draft-status")).toHaveAttribute("data-draft-state", "saved");
  await expect(frame.getByRole("textbox", { name: "创作需求", exact: true })).toHaveValue(expected.prompt);
  await expect(frame.getByRole("combobox", { name: "图片比例", exact: true })).toHaveValue(expected.ratio);
  await expect(frame.getByRole("combobox", { name: "图片画质", exact: true })).toHaveValue(expected.quality);
}
async function persistedWorkflow(projectId: string, workspaceId: string, expected: WorkflowExpectation, revision: number) {
  const row = await prisma.workbenchProjectState.findUniqueOrThrow({ where: { projectId } });
  assert.equal(row.workspaceId, workspaceId); assert.equal(row.workflowRevision, revision);
  assert.equal(row.workflowMode, expected.mode); assert.deepEqual(row.workflowTarget, expected.target); assert.deepEqual(row.workflowReferences, expected.references);
  assert.ok(row.workflowUpdatedAt); return row;
}
async function restoredWorkflow(frame: Frame, expected: WorkflowExpectation) {
  await frame.getByRole("button", { name: "生成", exact: true }).click();
  const panel = frame.getByTestId("owned-workflow");
  await expect(panel).toHaveAttribute("data-workflow-state", "ready"); await expect(panel).toHaveAttribute("data-workflow-dirty", "false");
  await expect(frame.getByRole("combobox", { name: "创作方式", exact: true })).toHaveValue(expected.mode);
  if (expected.target) await expect(frame.getByRole("combobox", { name: "修改目标", exact: true })).toHaveValue(JSON.stringify([expected.target.shapeId, expected.target.assetSha256]));
  await expect(frame.getByTestId("owned-workflow-reference")).toHaveCount(expected.references.length);
  for (const [index, ref] of expected.references.entries()) {
    await expect(frame.getByRole("combobox", { name: `素材用途 ${index + 1}`, exact: true })).toHaveValue(ref.purpose);
    await expect(frame.getByRole("checkbox", { name: `参与生成 ${index + 1}`, exact: true })).toBeChecked({ checked: ref.participates });
  }
  await expect(frame.getByRole("button", { name: "用途已保存", exact: true })).toBeVisible();
}
async function saveWorkflow(frame: Frame) {
  await expect(frame.getByTestId("owned-workflow")).toHaveAttribute("data-workflow-dirty", "true");
  await frame.getByRole("button", { name: "保存用途", exact: true }).click();
  await expect(frame.getByTestId("owned-workflow")).toHaveAttribute("data-workflow-state", "ready");
  await expect(frame.getByTestId("owned-workflow")).toHaveAttribute("data-workflow-dirty", "false");
  await expect(frame.getByRole("button", { name: "用途已保存", exact: true })).toBeVisible();
}
async function newPage() {
  const context = await browser!.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN", serviceWorkers: "allow" }); contexts.push(context);
  await context.route("**/*", async route => { const url = new URL(route.request().url());
    if (["http:", "https:"].includes(url.protocol) && url.origin !== base.origin) { networkProblems.push(`${url.origin}${url.pathname}`); await route.abort("blockedbyclient"); } else await route.continue(); });
  context.on("request", request => { const url = new URL(request.url());
    if (request.serviceWorker() && ["http:", "https:"].includes(url.protocol) && url.origin !== base.origin) networkProblems.push(`worker ${url.origin}${url.pathname}`);
    if (!request.serviceWorker()) { try { if (new URL(request.frame().url()).pathname === "/studio-editor" && /\/(?:originals|m12-native)\//.test(url.pathname)) networkProblems.push(`owned editor loaded captured SDK: ${url.pathname}`); } catch { /* Navigation has no frame yet. */ } } });
  context.on("response", response => { requests.push({ path: new URL(response.url()).pathname, method: response.request().method(), status: response.status() }); if (requests.length > 50) requests.shift(); });
  const page = await context.newPage(); currentPage = page; page.setDefaultTimeout(30000);
  page.on("pageerror", error => browserErrors.push(safe(error.message))); page.on("dialog", dialog => { void dialog.accept(); }); return page;
}
async function login(page: Page, email: string, password: string, destination = "/studio") {
  await page.goto(new URL(destination, base).href, { waitUntil: "domcontentloaded" }); await expect(page).toHaveURL(/\/login\?/);
  await page.locator('input[type="email"]').fill(email); await page.locator('input[type="password"]').fill(password); await page.locator('form button[type="submit"]').click();
  await expect(page).toHaveURL(/\/studio(?:-editor)?(?:[?#]|$)/, { timeout: 30000 });
}
async function studioReady(page: Page) {
  await expect(page.locator(".np-startup")).toHaveCount(0, { timeout: 45000 });
  await page.waitForFunction(() => (window as any).NovartStudio?.snapshot().stateLoaded === true, undefined, { timeout: 30000 }); await expect(page.locator("#ns-meta-alert")).toBeHidden();
}
async function editorFrame(page: Page, projectId: string) {
  const element = page.locator(`iframe[data-testid="studio-canvas-frame"][data-project-id="${projectId}"]`); await expect(element).toBeVisible({ timeout: 45000 });
  const frame = await (await element.elementHandle())!.contentFrame(); assert.ok(frame); await frame.waitForURL(url => url.pathname === "/studio-editor", { timeout: 45000 });
  await expect(frame.getByTestId("owned-canvas")).toBeVisible(); await expect(frame.getByRole("button", { name: "画笔", exact: true })).toBeVisible();
  await frame.waitForFunction(() => document.documentElement.dataset.nvStudioCanvasReady === "true");
  assert.equal(await frame.evaluate(() => Boolean((window as any).webpackChunk_lovartai_lovart_shell)), false, "Owned frame must not mount vendor webpack"); await expect(frame.locator(".tl-container, .tl-canvas")).toHaveCount(0); return frame;
}
async function gesture(page: Page, frame: Frame, points: Array<[number, number]>) {
  const box = await frame.getByTestId("owned-canvas").boundingBox(); assert.ok(box); await page.mouse.move(box.x + points[0]![0], box.y + points[0]![1]); await page.mouse.down();
  for (const [x, y] of points.slice(1)) await page.mouse.move(box.x + x, box.y + y, { steps: 5 }); await page.mouse.up();
}
async function exportScene(page: Page, frame: Frame, format: "png" | "svg", label: string) {
  await frame.getByRole("button", { name: "导出", exact: true }).click(); const pending = page.waitForEvent("download"); await frame.getByRole("button", { name: format === "png" ? "导出PNG" : "导出SVG", exact: true }).click();
  const download = await pending; assert.equal(await download.failure(), null); await mkdir(artifacts, { recursive: true }); const filename = path.join(artifacts, `${label}.${format}`); await download.saveAs(filename);
  const bytes = await readFile(filename); assert.ok(bytes.length > 50);
  if (format === "png") { const image = await sharp(bytes, { failOn: "error" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); assert.ok(image.info.width > 0 && image.info.height > 0); return { bytes, pixels: image.data }; }
  assert.ok(bytes.toString("utf8").includes("<svg")); return { bytes, pixels: null };
}
const uploadFixture = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAADAAAAAgCAIAAADbtmxLAAAAN0lEQVR4nO3OQQ0AMAgEMHSiBNmTMBccjyYV0Jp+p1R8ICQkJJQeCAkJCaUHQkJCQumBkJDQsg+b+YyX6uuGDAAAAABJRU5ErkJggg==", "base64");
async function upload(page: Page, frame: Frame, name: string) {
  const chooser = page.waitForEvent("filechooser"); await frame.getByRole("button", { name: "上传图片", exact: true }).first().click();
  const projectId = new URL(frame.url()).searchParams.get("projectId"), workspaceId = new URL(frame.url()).searchParams.get("workspaceId");
  assert.ok(projectId && workspaceId);
  const submitted = page.waitForRequest(request => {
    const url = new URL(request.url());
    return url.origin === base.origin && url.pathname === "/studio/material-upload" && request.method() === "POST" && request.frame() === frame;
  });
  await (await chooser).setFiles({ name, mimeType: "image/png", buffer: uploadFixture });
  // Chromium intentionally omits file multipart bodies from postDataBuffer.
  // Bind the response to the exact Request object, then verify its mutation
  // against the real outbox row for this unique file, user, project and SHA.
  const request = await submitted, response = await request.response(); assert.ok(response, "Upload request must receive a response");
  assert.equal(response.status(), 202, "Upload requires the real worker and configured storage");
  const receipt: unknown = await response.json();
  const rows = await prisma.studioMaterialUpload.findMany({ where: { workspaceId, projectId, userId: fixtureUsers[0], fileName: name, sha256: digest(uploadFixture), sizeBytes: uploadFixture.length },
    select: { taskId: true, projectId: true, mutationId: true, fileName: true, sha256: true, sizeBytes: true } });
  assert.equal(rows.length, 1, "This chosen file must have exactly one real durable upload");
  const captured = rows[0]!; acceptedUploads.push({ ...captured, workspaceId });
  uploadReceipts.set(captured.taskId, summarizeUploadReceipt(receipt));
  assert.ok(uploadReceiptMatches(receipt, captured), "Upload receipt must match the actual file's persisted task, project and mutation");
  return receipt;
}
async function materialReceipt(page: Page, workspaceId: string, projectId: string, taskId: string) {
  return eventually("real material worker", async () => { const response = await page.context().request.get(new URL(`/studio/material-upload?workspaceId=${workspaceId}&projectId=${projectId}&taskId=${taskId}`, base).href);
    assert.equal(response.status(), 200); const value = await response.json();
    uploadReceipts.set(taskId, summarizeUploadReceipt(value));
    assert.ok(value.taskId === taskId && value.projectId === projectId, "Upload poll must return the requested task and project");
    assert.notEqual(value.status, "FAILED", "Real material task failed"); return value.status === "SUCCEEDED" ? value : null; }, 120000);
}
async function uploadFailureEvidence() {
  const records = [];
  // Captured before fixture cleanup. Only accepted uploads from this test are
  // queried; no file bytes, object keys, names or error messages leave memory.
  for (const accepted of acceptedUploads.slice(-8)) {
    try {
      const rows = await prisma.$queryRaw<UploadEvidenceRow[]>`SELECT u."taskId", u."workspaceId", u."projectId", u."mutationId", u."fileName", u."sha256", u."sizeBytes",
        octet_length(u."body") AS "bodyBytes", u."assetId", u."attemptToken", u."width", u."height", u."expiresAt", t."status", t."progress", t."error",
        (a."id" IS NOT NULL) AS "assetPresent", (a."deprecatedAt" IS NOT NULL) AS "assetDeprecated"
        FROM "StudioMaterialUpload" u JOIN "AsyncTask" t ON t."id" = u."taskId" LEFT JOIN "Asset" a ON a."id" = u."assetId"
        WHERE u."taskId" = ${accepted.taskId} AND u."workspaceId" = ${accepted.workspaceId} AND u."projectId" = ${accepted.projectId} AND u."userId" = ${fixtureUsers[0] ?? ""}`;
      records.push({ ...summarizeUploadRow(rows[0], accepted), api: uploadReceipts.get(accepted.taskId) ?? null });
    } catch (error) { records.push({ task: uploadTaskToken(accepted.taskId), readable: false, failure: classifyUploadFailure(error), api: uploadReceipts.get(accepted.taskId) ?? null }); }
  }
  let redis: import("ioredis").default | undefined, queue: import("bullmq").Queue | undefined;
  const jobs = [];
  let queueError: ReturnType<typeof classifyUploadFailure> | undefined;
  try {
    const redisUrl = new URL(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
    if (redisUrl.protocol !== "redis:" || !["127.0.0.1", "localhost"].includes(redisUrl.hostname)) throw new Error("Diagnostic Redis must be loopback");
    const [{ default: IORedis }, { Queue }, { queuePrefix }] = await Promise.all([import("ioredis"), import("bullmq"), import("../src/lib/queue-prefix")]);
    redis = new IORedis(redisUrl.href, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 2000, commandTimeout: 2000, retryStrategy: () => null });
    redis.on("error", () => undefined); await redis.connect();
    queue = new Queue("studio-material-upload", { connection: redis, prefix: queuePrefix, skipMetasUpdate: true }); queue.on("error", () => undefined);
    for (const accepted of acceptedUploads.slice(-8)) {
      const job = await queue.getJob(accepted.taskId);
      jobs.push({ task: uploadTaskToken(accepted.taskId), present: !!job, ...(job ? { state: await job.getState(), attemptsMade: job.attemptsMade, failure: classifyUploadFailure(job.failedReason) } : {}) });
    }
  } catch (error) { queueError = classifyUploadFailure(error); }
  finally { redis?.disconnect(); await queue?.close().catch(() => undefined); }
  return { beforeFixtureCleanup: true, records, jobs, ...(queueError ? { queueError } : {}) };
}
async function assertMaterial(page: Page, workspaceId: string, projectId: string, material: { assetId: string; url: string; assetSha256: string }, expected?: Buffer) {
  assert.equal(material.url, `/api/workspaces/${workspaceId}/assets/${material.assetId}/raw`); const asset = await prisma.asset.findUniqueOrThrow({ where: { id: material.assetId } });
  assert.equal(asset.workspaceId, workspaceId); assert.ok(asset.storageKey); assert.ok(!/^(?:blob|data):/.test(asset.url)); assert.equal(await prisma.projectAsset.count({ where: { projectId, assetId: asset.id } }), 1);
  const raw = await page.context().request.get(new URL(material.url, base).href); assert.equal(raw.status(), 200); const bytes = await raw.body(); assert.equal(digest(bytes), material.assetSha256);
  if (expected) { assert.equal(asset.source, "UPLOAD"); assert.equal(asset.sizeBytes, expected.length); assert.deepEqual(bytes, expected); } return bytes;
}
async function homepageDraft(page: Page) {
  // Inspect recoverable inputs only. Do not inject a receipt or manufacture a
  // successful handoff: only the shipped UI can clear this real IndexedDB row.
  return page.evaluate(() => new Promise<{ version: number; items: Array<{ id: string; name: string; size: number; taskId: string | null }>; submitted: unknown } | null>((resolve, reject) => {
    const request = indexedDB.open("novart-owned-home-start", 1);
    const timer = setTimeout(() => reject(new Error("Homepage draft inspection timed out")), 8000);
    request.onupgradeneeded = () => { request.transaction?.abort(); };
    request.onerror = request.onblocked = () => { clearTimeout(timer); reject(new Error("Homepage draft store is unavailable")); };
    request.onsuccess = () => {
      const db = request.result, transaction = db.transaction("draft", "readonly"), read = transaction.objectStore("draft").get("owned-home-start-v1");
      transaction.oncomplete = () => { clearTimeout(timer); db.close(); const value = read.result;
        resolve(value ? { version: value.version, items: value.items.map((item: { id: string; name: string; file: Blob; taskId?: string }) => ({ id: item.id, name: item.name, size: item.file?.size, taskId: item.taskId ?? null })), submitted: value.submitted } : null); };
      transaction.onerror = transaction.onabort = () => { clearTimeout(timer); db.close(); reject(new Error("Homepage draft could not be inspected")); };
    };
  }));
}

try {
  const run = randomUUID().slice(0, 8), password = randomUUID(), email = `owned-ui-${run}@example.invalid`, nickname = `UI account ${run}`; privateValues.push(email, password);
  const user = await prisma.user.create({ data: { email, name: nickname, passwordHash: await hashPassword(password) } }); fixtureUsers.push(user.id);
  browser = await chromium.launch({ headless: true }); const page = await newPage(); enter("password login and first brand"); await login(page, email, password);
  await expect(page.getByRole("heading", { name: "创建你的第一个品牌" })).toBeVisible(); assert.equal(await prisma.brandWorkspace.count({ where: { ownerId: user.id } }), 0);
  const brandName = `Owned UI ${run}`; await page.getByRole("textbox", { name: "品牌名称", exact: true }).fill(brandName); await page.getByRole("button", { name: "进入工作台", exact: true }).click();
  await studioReady(page); const workspace = await prisma.brandWorkspace.findFirstOrThrow({ where: { ownerId: user.id, name: brandName } }); assert.equal(new URL(page.url()).searchParams.get("workspaceId"), workspace.id); await expect(page.locator("#ns-greeting")).toContainText(nickname);
  check("real login and first brand remain server-authoritative");

  if (process.env.WORKBENCH_TEST_MATERIAL_UPLOAD === "1") {
    enter("homepage attachment, actual project/worker save and input cleanup");
    await page.waitForFunction(() => (window as any).NovartStudio?.snapshot().homeStart.loaded === true);
    const brief = `首页带图创建，保存原始图片和需求 ${run}`, name = `owned-home-${run}.png`;
    await page.locator("#ns-home-brief").fill(brief);
    await page.locator("#hs-file-input").setInputFiles({ name, mimeType: "image/png", buffer: uploadFixture });
    const attachment = page.locator("#hs-attachments .hs-attachment"); await expect(attachment).toHaveCount(1);
    const attachmentId = await attachment.getAttribute("data-id"); assert.ok(attachmentId);
    await eventually("original homepage input persisted before submission", async () => { const draft = await homepageDraft(page);
      return draft?.version === 1 && draft.items.length === 1 && draft.items[0]?.id === attachmentId && draft.items[0]?.size === uploadFixture.length && draft.submitted === null ? draft : null; });
    const homeCreation = page.waitForResponse(response => new URL(response.url()).pathname === "/compare/api/create" && response.request().method() === "POST");
    const homeUpload = page.waitForResponse(response => new URL(response.url()).pathname === "/studio/material-upload" && response.request().method() === "POST", { timeout: 90000 });
    await page.locator("#ns-create").click(); const homeCreated = await homeCreation; assert.ok(homeCreated.ok()); const { projectId: homeProjectId } = await homeCreated.json();
    const homeProject = await prisma.project.findUniqueOrThrow({ where: { id: homeProjectId } }); assert.equal(homeProject.workspaceId, workspace.id);
    assert.equal((await prisma.workbenchProjectState.findUniqueOrThrow({ where: { projectId: homeProjectId } })).brief, brief);
    assert.equal(await prisma.project.count({ where: { workspaceId: workspace.id } }), 1, "Homepage creates exactly one real project");
    const homeFrame = await editorFrame(page, homeProjectId), homeAccepted = await homeUpload; assert.equal(homeAccepted.status(), 202);
    const homeTask = await homeAccepted.json(); assert.equal(homeTask.projectId, homeProjectId); assert.equal(homeTask.mutationId, attachmentId);
    const homeReceipt = await materialReceipt(page, workspace.id, homeProjectId, homeTask.taskId); await assertMaterial(page, workspace.id, homeProjectId, homeReceipt.material, uploadFixture);
    const uploadRow = await prisma.studioMaterialUpload.findUniqueOrThrow({ where: { taskId: homeTask.taskId } });
    assert.equal(uploadRow.workspaceId, workspace.id); assert.equal(uploadRow.userId, user.id); assert.equal(uploadRow.projectId, homeProjectId);
    assert.equal(uploadRow.mutationId, attachmentId); assert.equal(uploadRow.sha256, digest(uploadFixture)); assert.equal(uploadRow.assetId, homeReceipt.material.assetId); assert.equal(uploadRow.body, null);
    const homeImageId = "shape:home-" + attachmentId, homeImage = homeFrame.locator(`[data-owned-id="${homeImageId}"][data-kind="image"]`);
    await expect(homeImage).toHaveCount(1, { timeout: 45000 }); await expect(homeImage.locator("img")).toHaveAttribute("src", homeReceipt.material.url);
    const homeSaved = await saved(homeFrame, homeProjectId, items => items.length === 1 && items[0]?.id === homeImageId && items[0]?.type === "c-image"
      && items[0]?.props.url === homeReceipt.material.url && items[0]?.meta?.novartAssetId === homeReceipt.material.assetId && items[0]?.meta?.novartAssetSha256 === homeReceipt.material.assetSha256);
    assert.ok(homeSaved.row.revision >= 1); await expect(page.locator("#hs-handoff")).toBeHidden({ timeout: 45000 });
    await page.waitForFunction(() => { const home = (window as any).NovartStudio?.snapshot().homeStart; return home?.attachmentCount === 0 && home.submittedRequestId === null && home.running.length === 0; });
    await eventually("confirmed handoff clears original input recovery row", async () => { const draft = await homepageDraft(page); return draft?.version === 1 && draft.items.length === 0 && draft.submitted === null ? draft : null; });
    await expect(page.locator("#hs-file-input")).toHaveValue(""); await expect(page.locator("#ns-home-brief")).toHaveValue("");
    assert.equal(await page.locator(`iframe[data-project-id="${homeProjectId}"]`).evaluate(node => (node as HTMLIFrameElement).inert), false);
    assert.equal(await prisma.generation.count({ where: { projectId: homeProjectId } }), 0, "Homepage upload must not submit a paid generation");
    check("homepage original file becomes a real persisted image before handoff/input recovery clears");

    enter("fresh browser restores homepage image without IndexedDB input"); const homeFresh = await newPage();
    await login(homeFresh, email, password, `/studio?workspaceId=${workspace.id}`); await studioReady(homeFresh);
    await homeFresh.getByTestId("studio-nav-projects").click(); await homeFresh.locator(`#ns-project-library [data-project-id="${homeProjectId}"] [data-action="open-project"]`).click();
    const restoredHomeFrame = await editorFrame(homeFresh, homeProjectId);
    await expect(restoredHomeFrame.getByTestId("owned-canvas-item")).toHaveCount(1); const restoredHomeImage = restoredHomeFrame.locator(`[data-owned-id="${homeImageId}"]`);
    await expect(restoredHomeImage.locator("img")).toHaveAttribute("src", homeReceipt.material.url);
    await expect.poll(() => restoredHomeImage.locator("img").evaluate(node => { const image = node as HTMLImageElement; return image.complete && image.naturalWidth === 48 && image.naturalHeight === 32; })).toBe(true);
    await assertMaterial(homeFresh, workspace.id, homeProjectId, homeReceipt.material, uploadFixture); await expect(homeFresh.locator("#hs-handoff")).toBeHidden();
    const freshDraft = await homepageDraft(homeFresh); assert.equal(freshDraft?.items.length ?? 0, 0); assert.equal(freshDraft?.submitted ?? null, null);
    assert.equal((await prisma.editorDocument.findUniqueOrThrow({ where: { projectId: homeProjectId } })).checksum, homeSaved.row.checksum);
    assert.equal(await prisma.studioMaterialUpload.count({ where: { projectId: homeProjectId } }), 1, "Fresh restore must not submit another upload");
    realHomepageHandoff = true; deferred.splice(deferred.indexOf("Homepage attachments handoff"), 1); check("fresh browser restores the homepage image from the server without duplicate upload");
    await homeFresh.context().close(); currentPage = page;
    await page.goto(new URL(`/studio?workspaceId=${workspace.id}#/home`, base).href); await studioReady(page);
  }

  enter("blank project opens owned editor"); const creation = page.waitForResponse(response => new URL(response.url()).pathname === "/compare/api/create" && response.request().method() === "POST"); await page.locator("#ns-create-blank").click();
  const created = await creation; assert.ok(created.ok()); const { projectId } = await created.json(); const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } }); assert.equal(project.workspaceId, workspace.id);
  let frame = await editorFrame(page, projectId); assert.equal(new URL(frame.url()).searchParams.get("workspaceId"), workspace.id); check("reviewed shell opens authenticated /studio-editor without tldraw or vendor webpack");

  enter("pointer rectangle, Chinese text, stroke, resize and history"); await frame.getByRole("button", { name: "图形", exact: true }).click(); await gesture(page, frame, [[180, 160], [330, 260]]);
  const rectangle = frame.locator('[data-testid="owned-canvas-item"][data-kind="shape"]'); await expect(rectangle).toHaveCount(1); const rectangleId = await rectangle.getAttribute("data-owned-id"); assert.ok(rectangleId);
  await frame.getByRole("button", { name: "选择", exact: true }).click(); const initialBox = await rectangle.boundingBox(); assert.ok(initialBox);
  await page.mouse.move(initialBox.x + 30, initialBox.y + 30); await page.mouse.down(); await page.mouse.move(initialBox.x + 75, initialBox.y + 60, { steps: 5 }); await page.mouse.up();
  const moved = await rectangle.boundingBox(); assert.ok(moved && moved.x > initialBox.x + 35 && moved.y > initialBox.y + 20);
  const handle = await frame.getByRole("button", { name: "调整右下尺寸", exact: true }).boundingBox(); assert.ok(handle); await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down(); await page.mouse.move(handle.x + 70, handle.y + 50, { steps: 5 }); await page.mouse.up();
  const resized = await rectangle.boundingBox(); assert.ok(resized && resized.width > moved.width + 45);
  await frame.getByRole("button", { name: "文字", exact: true }).click(); await gesture(page, frame, [[470, 160], [660, 230]]); const chinese = `中文保存重开 ${run}`;
  await frame.getByRole("textbox", { name: "编辑画布文字", exact: true }).fill(chinese); await frame.getByRole("textbox", { name: "编辑画布文字", exact: true }).press("Control+Enter");
  await frame.getByRole("button", { name: "画笔", exact: true }).click(); await gesture(page, frame, [[150, 430], [190, 400], [240, 445], [280, 410]]);
  const strokes = frame.locator('[data-testid="owned-canvas-item"][data-kind="stroke"]'); await expect(strokes).toHaveCount(1); await frame.getByRole("button", { name: "撤销", exact: true }).click(); await expect(strokes).toHaveCount(0); await frame.getByRole("button", { name: "重做", exact: true }).click(); await expect(strokes).toHaveCount(1);
  const initial = await saved(frame, projectId, items => items.length === 3 && items.some(item => item.props.text === chinese) && items.some(item => item.props.novartKind === "stroke")); assert.ok(initial.items.find(item => item.id === rectangleId)!.props.w > 190);
  check("actual pointer editing, Chinese input and undo/redo save into the real database");

  enter("unsent composer autosave and actual page-unload recovery");
  let expectedDraft: DraftExpectation = { prompt: `草稿自动保存 ${run}\n中文第二行，不提交生成。`, ratio: "4:3", quality: "2K" };
  await frame.getByRole("button", { name: "生成", exact: true }).click();
  await expect(frame.getByRole("textbox", { name: "创作需求", exact: true })).toBeEnabled();
  await frame.getByRole("textbox", { name: "创作需求", exact: true }).fill(expectedDraft.prompt);
  await frame.getByRole("combobox", { name: "图片比例", exact: true }).selectOption(expectedDraft.ratio);
  await frame.getByRole("combobox", { name: "图片画质", exact: true }).selectOption(expectedDraft.quality);
  await expect(frame.getByTestId("owned-draft-status")).toHaveAttribute("data-draft-state", "saved");
  const autoDraft = await persistedDraft(user.id, projectId, expectedDraft);
  expectedDraft = { ...expectedDraft, prompt: `离开前最后输入 ${run}\n这份需求仍未提交，只保存草稿。` };
  await frame.getByRole("textbox", { name: "创作需求", exact: true }).fill(expectedDraft.prompt);
  await expect(frame.getByTestId("owned-draft-status")).toHaveAttribute("data-draft-state", "dirty");
  // Leave a genuinely dirty page. Do not synthesize pagehide, call the hook, or
  // write the database to imitate the browser's close-time save.
  await page.goto("about:blank", { waitUntil: "domcontentloaded" });
  const unloadedDraft = await persistedDraft(user.id, projectId, expectedDraft); assert.ok(unloadedDraft.revision > autoDraft.revision);
  await page.goto(new URL(`/studio?workspaceId=${workspace.id}#/workspace/${projectId}`, base).href); await studioReady(page); frame = await editorFrame(page, projectId);
  await restoredDraft(frame, expectedDraft); assert.equal((await persistedDraft(user.id, projectId, expectedDraft)).revision, unloadedDraft.revision, "Opening must not rewrite an already saved draft");
  assert.equal(await prisma.generation.count({ where: { projectId } }), 0, "Draft save and recovery must not invoke image generation");
  check("unsent Chinese draft and image options persist through autosave and a real dirty-page navigation");

  let expectedWorkflow: WorkflowExpectation | undefined, finalWorkflowRevision: number | undefined;
  let uploadedId: string | undefined;
  if (process.env.WORKBENCH_TEST_MATERIAL_UPLOAD === "1") {
    enter("real worker upload, authenticated bytes and undoable insertion"); const task = await upload(page, frame, `owned-ui-${run}.png`); assert.equal(task.projectId, projectId);
    const receipt = await materialReceipt(page, workspace.id, projectId, task.taskId); await assertMaterial(page, workspace.id, projectId, receipt.material, uploadFixture);
    const image = frame.locator('[data-testid="owned-canvas-item"][data-kind="image"]').filter({ has: frame.locator(`img[src="${receipt.material.url}"]`) }); await expect(image).toHaveCount(1, { timeout: 45000 }); uploadedId = (await image.getAttribute("data-owned-id"))!;
    await frame.getByRole("button", { name: "撤销", exact: true }).click(); await expect(image).toHaveCount(0); await frame.getByRole("button", { name: "重做", exact: true }).click(); await expect(image).toHaveCount(1);
    await saved(frame, projectId, items => items.some(item => item.id === uploadedId && item.type === "c-image" && item.props.url === receipt.material.url)); check("durable upload preserves bytes, ownership and undoable persistent image");

    enter("accepted upload survives page unload and restores from server receipt"); const detachedName = `owned-detached-${run}.png`, detached = await upload(page, frame, detachedName); await page.goto("about:blank", { waitUntil: "domcontentloaded" });
    const detachedReceipt = await materialReceipt(page, workspace.id, projectId, detached.taskId); await assertMaterial(page, workspace.id, projectId, detachedReceipt.material, uploadFixture);
    await page.goto(new URL(`/studio?workspaceId=${workspace.id}#/workspace/${projectId}`, base).href); await studioReady(page); frame = await editorFrame(page, projectId);
    await frame.getByRole("button", { name: "任务", exact: true }).click(); await frame.getByRole("button", { name: "刷新任务", exact: true }).click(); const row = frame.locator(`section[data-task-id="${detached.taskId}"]`); await expect(row).toContainText("已存入素材库");
    // The worker may finish before unload: do not intentionally insert a second copy.
    const existing = frame.locator(`[data-kind="image"] img[src="${detachedReceipt.material.url}"]`); if (await existing.count() === 0) await row.getByRole("button", { name: "加入画布", exact: true }).click();
    await expect(existing).toHaveCount(1); await saved(frame, projectId, items => items.some(item => item.props.url === detachedReceipt.material.url)); check("accepted upload completes without a live page and inserts without reupload");

    enter("real uploaded-image purposes and explicit modification target persist");
    assert.ok(uploadedId);
    const target = { shapeId: uploadedId, assetSha256: receipt.material.assetSha256 }, selected = JSON.stringify([target.shapeId, target.assetSha256]);
    await restoredDraft(frame, expectedDraft); await frame.getByRole("button", { name: "读取最新设置", exact: true }).click();
    await expect(frame.getByTestId("owned-workflow")).toHaveAttribute("data-workflow-state", "ready");
    const workflowBefore = await prisma.workbenchProjectState.findUniqueOrThrow({ where: { projectId } });
    await frame.getByRole("combobox", { name: "添加画布素材用途", exact: true }).selectOption(selected);
    await frame.getByRole("button", { name: "添加用途", exact: true }).click();
    await expect(frame.getByRole("checkbox", { name: "参与生成 1", exact: true })).not.toBeChecked();
    await frame.getByRole("combobox", { name: "素材用途 1", exact: true }).selectOption("ADAPTIVE");
    await frame.getByRole("checkbox", { name: "参与生成 1", exact: true }).check();
    await expect(frame.getByRole("button", { name: "生成图片", exact: true })).toBeDisabled();
    expectedWorkflow = { mode: "generate", target: null, references: [{ ...target, purpose: "ADAPTIVE", participates: true }] };
    await saveWorkflow(frame); await persistedWorkflow(projectId, workspace.id, expectedWorkflow, workflowBefore.workflowRevision + 1);
    await frame.getByRole("combobox", { name: "创作方式", exact: true }).selectOption("modify");
    await frame.getByRole("combobox", { name: "修改目标", exact: true }).selectOption(selected);
    await expect(frame.getByRole("button", { name: "提交整图修改", exact: true })).toBeDisabled();
    expectedWorkflow = { ...expectedWorkflow, mode: "modify", target };
    await saveWorkflow(frame); const modifying = await persistedWorkflow(projectId, workspace.id, expectedWorkflow, workflowBefore.workflowRevision + 2);
    assert.equal(await prisma.generation.count({ where: { projectId } }), 0, "Saving purposes and a modification target must not call a provider");

    enter("fresh browser restores modification mode, original target and active purpose");
    const workflowFresh = await newPage(); await login(workflowFresh, email, password, `/studio?workspaceId=${workspace.id}`); await studioReady(workflowFresh);
    await workflowFresh.getByTestId("studio-nav-projects").click(); await workflowFresh.locator(`#ns-project-library [data-project-id="${projectId}"] [data-action="open-project"]`).click();
    const workflowFrame = await editorFrame(workflowFresh, projectId); await restoredDraft(workflowFrame, expectedDraft); await restoredWorkflow(workflowFrame, expectedWorkflow);
    await persistedWorkflow(projectId, workspace.id, expectedWorkflow, modifying.workflowRevision);
    await workflowFresh.context().close(); currentPage = page;
    check("real workflow rows and a fresh authenticated browser preserve mode, exact target, purpose and participation without generation");

    // Return to an explicit plain-generation selection before the opt-in
    // provider test. Never spend a model request as a side effect of this test.
    await frame.getByRole("combobox", { name: "创作方式", exact: true }).selectOption("generate");
    await frame.getByRole("combobox", { name: "素材用途 1", exact: true }).selectOption("REFERENCE");
    await frame.getByRole("checkbox", { name: "参与生成 1", exact: true }).uncheck();
    expectedWorkflow = { mode: "generate", target: null, references: [{ ...target, purpose: "REFERENCE", participates: false }] };
    await saveWorkflow(frame); finalWorkflowRevision = modifying.workflowRevision + 1;
    await persistedWorkflow(projectId, workspace.id, expectedWorkflow, finalWorkflowRevision);
  } else console.log("SKIP real upload acceptance: enable WORKBENCH_TEST_MATERIAL_UPLOAD with disposable storage/worker.");

  if (process.env.WORKBENCH_TEST_GENERATION === "1") {
    enter("real provider, lost-202 confirmation and manual insertion"); await frame.getByRole("button", { name: "生成", exact: true }).click(); const prompt = `Create one violet geometric poster on white with no text. Acceptance ${run}`;
    expectedDraft = { prompt, ratio: "1:1", quality: "1K" };
    await frame.getByRole("textbox", { name: "创作需求", exact: true }).fill(prompt); await frame.getByRole("combobox", { name: "图片比例", exact: true }).selectOption("1:1"); await frame.getByRole("combobox", { name: "图片画质", exact: true }).selectOption("1K");
    let lost = false; const mutations: string[] = []; const fault = async (route: Route) => { if (route.request().method() !== "POST") return route.continue(); mutations.push(String(route.request().postDataJSON().mutationId));
      if (!lost) { const actual = await route.fetch(); assert.equal(actual.status(), 202, "Opt-in run requires real provider/storage"); lost = true; return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Acceptance receipt loss; confirm existing operation" }) }); } return route.continue(); };
    await page.route("**/studio/generation?**", fault); let accepted: any;
    try { await frame.getByRole("button", { name: "生成图片", exact: true }).click(); await expect(frame.getByTestId("owned-notice")).toContainText("Acceptance receipt loss");
      const next = page.waitForResponse(response => new URL(response.url()).pathname === "/studio/generation" && response.request().method() === "POST" && response.status() === 202); await frame.getByRole("button", { name: "确认上一份生成回执", exact: true }).click(); accepted = await (await next).json();
    } finally { await page.unroute("**/studio/generation?**", fault); }
    assert.equal(mutations.length, 2); assert.equal(mutations[0], mutations[1]); assert.equal(accepted.mutationId, mutations[0]);
    const complete = await eventually("real generation and archive", async () => { const response = await page.context().request.get(new URL(`/studio/generation?workspaceId=${workspace.id}&projectId=${projectId}&requestId=${accepted.requestId}`, base).href);
      assert.equal(response.status(), 200); const value = await response.json(); assert.notEqual(value.status, "FAILED", "Real generation failed"); assert.notEqual(value.resultState, "FAILED", "Real archive failed"); return value.status === "SUCCEEDED" && value.resultState === "READY" ? value : null; }, 720000);
    assert.equal(complete.results.length, 1); const result = complete.results[0], bytes = await assertMaterial(page, workspace.id, projectId, result);
    const version = await prisma.generationVersion.findUniqueOrThrow({ where: { id: result.versionId } }); assert.equal(version.generationId, accepted.generationId); const gen = await prisma.generation.findUniqueOrThrow({ where: { id: accepted.generationId } }); assert.equal(gen.workspaceId, workspace.id); assert.equal(gen.projectId, projectId); assert.equal(gen.status, "SUCCEEDED");
    assert.equal(await prisma.generation.count({ where: { projectId } }), 1, "Lost response must not create a second paid generation"); const dimensions = await sharp(bytes).metadata(); assert.deepEqual([dimensions.width, dimensions.height], [result.width, result.height]);
    const image = frame.locator(`[data-kind="image"] img[src="${result.url}"]`); await expect(image).toHaveCount(0); await frame.getByRole("button", { name: "刷新任务", exact: true }).click(); const row = frame.locator(`section[data-task-id="${accepted.requestId}"]`);
    await expect(row).toContainText("图片已生成并保存"); await row.getByRole("button", { name: "加入画布", exact: true }).click(); await expect(image).toHaveCount(1); await frame.getByRole("button", { name: "撤销", exact: true }).click(); await expect(image).toHaveCount(0); await frame.getByRole("button", { name: "重做", exact: true }).click(); await expect(image).toHaveCount(1);
    await saved(frame, projectId, items => items.some(item => item.props.url === result.url)); check("real provider, idempotent receipt, persisted bytes and manually inserted undoable result");
  } else console.log("SKIP real generation acceptance: no provider result is claimed by this run.");

  enter("whole-scene PNG/SVG export"); await saved(frame, projectId); const png = await exportScene(page, frame, "png", "owned-scene"), svg = await exportScene(page, frame, "svg", "owned-scene"); assert.ok(svg.bytes.toString("utf8").includes(chinese));
  if (uploadedId) assert.ok(svg.bytes.toString("utf8").includes(uploadFixture.toString("base64")), "SVG must embed actual persisted image bytes"); check("whole-scene PNG decodes and SVG includes saved Chinese text and actual image bytes");

  enter("profile and favorite persistence"); await page.getByTestId("studio-nav-settings").click(); const newNickname = `Saved profile ${run}`;
  await page.locator("#ns-settings-nickname").fill(newNickname); await page.locator("#ns-settings-density").selectOption("compact"); await page.locator("#ns-settings-motion").selectOption("reduce"); await page.locator("#ns-settings-save").click();
  await eventually("real profile row", async () => { const row = await prisma.workbenchUserState.findUnique({ where: { userId_workspaceId: { userId: user.id, workspaceId: workspace.id } } }); const profile = row?.profile as any; return profile?.nickname === newNickname && profile.density === "compact" && profile.motion === "reduce" ? row : null; }); await expect(page.locator("#ns-settings-status")).toHaveAttribute("data-state", "saved");
  await page.getByTestId("studio-nav-projects").click(); await page.locator("#ns-project-refresh").click(); const card = page.locator(`#ns-project-library [data-project-id="${projectId}"]`); await expect(card).toContainText("已保存画布"); await card.locator('[data-action="favorite"]').click();
  await eventually("real favorite row", async () => { const row = await prisma.workbenchUserState.findUnique({ where: { userId_workspaceId: { userId: user.id, workspaceId: workspace.id } } }); return row?.favorites.includes(projectId) ? row : null; }); check("profile and favorites persist through reviewed shell");

  enter("fresh browser restores scene and matching export pixels"); const finalRow = await prisma.editorDocument.findUniqueOrThrow({ where: { projectId } }), finalShapes = Object.values(store(finalRow.canvas)).filter(item => item.typeName === "shape");
  const finalDraft = await persistedDraft(user.id, projectId, expectedDraft);
  const fresh = await newPage(); await login(fresh, email, password, `/studio?workspaceId=${workspace.id}`); await studioReady(fresh); await expect(fresh.locator("#ns-greeting")).toContainText(newNickname); await fresh.getByTestId("studio-nav-projects").click(); const freshCard = fresh.locator(`#ns-project-library [data-project-id="${projectId}"]`);
  await expect(freshCard.locator('[data-action="favorite"]')).toHaveAttribute("aria-pressed", "true"); await freshCard.locator('[data-action="open-project"]').click(); frame = await editorFrame(fresh, projectId); await expect(frame.getByTestId("owned-canvas-item")).toHaveCount(finalShapes.length);
  for (const item of finalShapes) { const node = frame.locator(`[data-owned-id="${item.id}"]`); await expect(node).toHaveCount(1); if (item.type === "c-image") await expect(node.locator("img")).toHaveAttribute("src", item.props.url); }
  await restoredDraft(frame, expectedDraft); assert.equal((await persistedDraft(user.id, projectId, expectedDraft)).revision, finalDraft.revision);
  realDraftPersistence = true; deferred.splice(deferred.indexOf("Unsent creation draft autosave/pagehide recovery"), 1);
  check("fresh browser restores the exact server draft without browser storage or a revision rewrite");
  if (expectedWorkflow && finalWorkflowRevision !== undefined) {
    await restoredWorkflow(frame, expectedWorkflow); await persistedWorkflow(projectId, workspace.id, expectedWorkflow, finalWorkflowRevision);
    realWorkflowPersistence = true; deferred.splice(deferred.indexOf("Workflow purpose and modification-target persistence"), 1);
    check("fresh browser restores explicit inactive references and generate mode after modification-target persistence was verified");
  }
  await expect(frame.getByTestId("owned-canvas")).toContainText(chinese); const freshPng = await exportScene(fresh, frame, "png", "fresh-owned-scene"); assert.deepEqual(freshPng.pixels, png.pixels, "Fresh server restore must export identical decoded pixels"); assert.equal((await prisma.editorDocument.findUniqueOrThrow({ where: { projectId } })).checksum, finalRow.checksum, "Opening/exporting must not rewrite the document"); check("fresh browser restores all scene objects without browser cache");

  enter("direct route membership and archived-project protection"); const outsiderEmail = `owned-outsider-${run}@example.invalid`; privateValues.push(outsiderEmail); const outsider = await prisma.user.create({ data: { email: outsiderEmail, passwordHash: await hashPassword(password) } }); fixtureUsers.push(outsider.id);
  const unauthorized = await newPage(); await login(unauthorized, outsiderEmail, password, `/studio-editor?workspaceId=${workspace.id}&projectId=${projectId}`); await expect(unauthorized.getByTestId("owned-editor")).toHaveCount(0); await expect(unauthorized.getByTestId("owned-editor-access-error")).toBeVisible(); const denied = await unauthorized.context().request.get(new URL(`/api/workspaces/${workspace.id}/projects/${projectId}/editor-document`, base).href); assert.equal(denied.status(), 404);
  const archived = await fresh.context().request.patch(new URL(`/api/workspaces/${workspace.id}/projects/${projectId}`, base).href, { headers: { Origin: base.origin }, data: { archive: true } }); assert.equal(archived.status(), 200);
  await fresh.goto(new URL(`/studio-editor?workspaceId=${workspace.id}&projectId=${projectId}`, base).href); await expect(fresh.getByTestId("owned-canvas")).toBeVisible(); await expect(fresh.getByRole("button", { name: "画笔", exact: true })).toBeDisabled(); await expect(fresh.getByRole("button", { name: "上传图片", exact: true }).first()).toBeDisabled();
  const refused = await fresh.context().request.put(new URL(`/api/workspaces/${workspace.id}/projects/${projectId}/editor-document`, base).href, { headers: { Origin: base.origin }, data: { format: "novart-native-v1", canvas: finalRow.canvas, revision: finalRow.revision, mutationId: randomUUID() } }); assert.equal(refused.status(), 409); assert.equal((await prisma.editorDocument.findUniqueOrThrow({ where: { projectId } })).checksum, finalRow.checksum); check("direct route membership and archived read-only protections remain enforced");

  assert.deepEqual(networkProblems, [], "Owned frame must not request captured SDK or remote business services"); assert.deepEqual(browserErrors, []); assert.equal(await prisma.generation.count({ where: { projectId } }), process.env.WORKBENCH_TEST_GENERATION === "1" ? 1 : 0);
  await mkdir(artifacts, { recursive: true }); await writeFile(path.join(artifacts, "acceptance.json"), JSON.stringify({ editor: "novart-owned", checksPassed: passed, realDatabase: true, realUploads: process.env.WORKBENCH_TEST_MATERIAL_UPLOAD === "1", realHomepageHandoff, realDraftPersistence, realWorkflowPersistence, realGeneration: process.env.WORKBENCH_TEST_GENERATION === "1", realImageModification: false, realExactGeneration: false, deferred }, null, 2));
  console.log(`Owned studio UI: ${passed} checks passed against real app/database. Deferred UI journeys: ${deferred.join("; ")}`);
} catch (error) {
  const uploads = await uploadFailureEvidence();
  await mkdir(artifacts, { recursive: true }); await currentPage?.screenshot({ path: path.join(artifacts, "failure.png"), fullPage: true }).catch(() => undefined);
  const diagnostics = { step, error: safe(error instanceof Error ? error.message : String(error)), uploads, networkProblems: networkProblems.map(safe), browserErrors, requests, page: currentPage ? new URL(currentPage.url()).pathname : null, deferred };
  await writeFile(path.join(artifacts, "diagnostics.json"), JSON.stringify(diagnostics, null, 2)); console.error("Owned UI acceptance failed: " + JSON.stringify(diagnostics)); throw error;
} finally {
  await Promise.allSettled(contexts.map(context => context.close())); await browser?.close(); for (const id of fixtureUsers.reverse()) await prisma.user.delete({ where: { id } }); await prisma.$disconnect();
}
