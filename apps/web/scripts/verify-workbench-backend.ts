/** Disposable CI database only. No AI calls, generated assets or production credentials. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { prisma } from "@brandai/db";
import { hashPassword } from "../src/lib/password";
import { verifyStudioShellBackend } from "./verify-studio-shell-backend";
import { verifyStudioMaterialsBackend } from "./verify-studio-materials-backend";
import { verifyStudioGenerationBackend } from "./verify-studio-generation-backend";
import { ACTIVE_BRAND_COOKIE } from "../src/lib/brand-cookie";

const base = process.env.WORKBENCH_TEST_URL ?? "http://127.0.0.1:3000";
const db = new URL(process.env.DATABASE_URL ?? "http://invalid");
if (db.pathname !== "/novart_integration_test" || !["localhost", "127.0.0.1"].includes(db.hostname) || !["localhost", "127.0.0.1"].includes(new URL(base).hostname)) {
  throw new Error("This test requires a loopback app and the disposable novart_integration_test database.");
}
let passed = 0;
const check = (label: string, fn: () => void) => { fn(); passed++; console.log(`PASS ${label}`); };
const sessions = new Map<string, Map<string, string>>();
async function call(actor: string, path: string, method = "GET", body?: unknown, origin = base, extraHeaders: Record<string, string> = {}) {
  const jar = sessions.get(actor) ?? new Map<string, string>(); sessions.set(actor, jar);
  const headers: Record<string, string> = { ...extraHeaders, Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") };
  if (method !== "GET") headers.Origin = origin;
  if (body !== undefined && !(body instanceof FormData)) headers["Content-Type"] = body instanceof URLSearchParams ? "application/x-www-form-urlencoded" : "application/json";
  const response = await fetch(base + path, { method, headers, redirect: "manual",
    body: body === undefined ? undefined : body instanceof FormData ? body : body instanceof URLSearchParams ? body.toString() : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";", 1)[0] ?? "", index = pair.indexOf("=");
    if (index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1));
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  let data: any; try { data = JSON.parse(text); } catch { data = null; }
  return { status: response.status, data, bytes };
}
async function login(actor: string, email: string, password: string) {
  const csrf = await call(actor, "/api/auth/csrf"); assert.equal(csrf.status, 200);
  await call(actor, "/api/auth/callback/password", "POST", new URLSearchParams({ csrfToken: csrf.data.csrfToken, email, password, callbackUrl: base }));
  const session = await call(actor, "/api/workbench/session"); assert.equal(session.status, 200);
  return session.data;
}
const encode = (suffix = "") => "SHAKKERDATA://" + gzipSync(JSON.stringify({
  tldrawSnapshot: { document: { schema: { schemaVersion: 2 }, store: {
    "shape:pen": { id: "shape:pen", typeName: "shape", type: "draw", rotation: 0.51,
      props: { segments: [{ points: [{ x: 10, y: 20, z: 0.8 }] }] } },
    "shape:text": { id: "shape:text", typeName: "shape", type: "text", props: { text: "中文换行\n保存重开" + suffix, fontSize: 36 } },
  } }, session: { camera: { x: -10, y: 100, z: 0.8 } } }, unknownNativeField: { preserved: true },
})).toString("base64");

try {
  const run = randomUUID().slice(0, 8), password = randomUUID();
  const ownerEmail = `native-owner-${run}@example.invalid`, viewerEmail = `native-viewer-${run}@example.invalid`, outsiderEmail = `native-outsider-${run}@example.invalid`, editorEmail = `native-editor-${run}@example.invalid`;
  // Synthetic account fixtures only; authentication below uses the real password provider.
  await prisma.user.createMany({ data: await Promise.all([ownerEmail, viewerEmail, outsiderEmail, editorEmail].map(async email => ({ email, name: "Integration test", passwordHash: await hashPassword(password) }))) });
  const owner = await login("owner", ownerEmail, password);
  await login("viewer", viewerEmail, password); await login("outsider", outsiderEmail, password);
  const editor = await login("editor", editorEmail, password);
  check("password login returns a real user and no invented default brand", () => { assert.ok(owner.user.id); assert.equal(owner.activeWorkspaceId, null); });
  const anonymous = await call("anonymous", "/api/workbench/session");
  check("anonymous session denied", () => assert.equal(anonymous.status, 401));
  const brand = await call("owner", "/api/workspaces", "POST", { name: `Native integration ${run}` }); assert.equal(brand.status, 201);
  const ws = brand.data.id;
  sessions.get("outsider")!.set(ACTIVE_BRAND_COOKIE, ws);
  const staleCookiePage = await call("outsider", "/studio");
  check("a previous account's brand cookie does not block a new account's studio", () => assert.equal(staleCookiePage.status, 200));
  sessions.get("outsider")!.delete(ACTIVE_BRAND_COOKIE);
  const select = await call("owner", "/api/workbench/session", "POST", { workspaceId: ws });
  assert.equal(select.status, 200, JSON.stringify(select.data));
  check("brand selection writes the real session-scoped cookie", () => assert.equal(select.data.activeWorkspaceId, ws));
  const reload = await call("owner", "/api/workbench/session");
  check("brand survives another request", () => assert.equal(reload.data.activeWorkspaceId, ws));
  const oversized = await call("owner", "/api/workbench/session", "POST", { workspaceId: ws, padding: "x".repeat(2048) });
  check("oversized brand-selection body rejected", () => assert.equal(oversized.status, 413));
  const foreign = await call("outsider", `/api/workbench/session?workspaceId=${ws}`);
  check("explicit foreign brand is rejected rather than silently switched", () => assert.equal(foreign.status, 404));
  const member = await call("owner", `/api/workspaces/${ws}/members`, "POST", { email: viewerEmail, role: "VIEWER" }); assert.equal(member.status, 201);
  const editorMember = await call("owner", `/api/workspaces/${ws}/members`, "POST", { email: editorEmail, role: "EDITOR" }); assert.equal(editorMember.status, 201);
  const project = await call("owner", `/api/workspaces/${ws}/projects`, "POST", { name: "Native document integration" }); assert.equal(project.status, 201);
  const pid = project.data.id, endpoint = `/api/workspaces/${ws}/projects/${pid}/editor-document`;
  const initial = await call("owner", endpoint);
  check("new project has explicit unsaved document state", () => { assert.equal(initial.status, 200); assert.equal(initial.data.revision, 0); assert.equal(initial.data.canvas, ""); });
  const payload = { format: "novart-native-v1", canvas: encode(), revision: 0, mutationId: randomUUID() };
  const writes = await Promise.all([call("owner", endpoint, "PUT", payload), call("owner", endpoint, "PUT", { ...payload, mutationId: randomUUID() })]);
  check("two first saves serialize: one succeeds and one conflicts", () => assert.deepEqual(writes.map(x => x.status).sort(), [200, 409]));
  const saved = writes.find(x => x.status === 200)!;
  const reopened = await call("owner", endpoint);
  check("full native canvas reopens byte-for-byte", () => { assert.equal(reopened.data.canvas, payload.canvas); assert.equal(reopened.data.revision, 1); assert.match(reopened.data.checksum, /^[a-f0-9]{64}$/); });
  const row = await prisma.editorDocument.findUniqueOrThrow({ where: { projectId: pid } });
  const replay = await call("owner", endpoint, "PUT", { ...payload, mutationId: row.mutationId });
  check("lost-response retry is idempotent", () => { assert.equal(replay.status, 200); assert.equal(replay.data.revision, saved.data.revision); });
  const changedRetry = await call("owner", endpoint, "PUT", { ...payload, mutationId: row.mutationId, canvas: encode("changed") });
  check("reused mutation id cannot change its content", () => { assert.equal(changedRetry.status, 409); assert.equal(changedRetry.data.code, "MUTATION_CONFLICT"); });
  const outsider = await call("outsider", endpoint);
  check("nonmember cannot read another brand's canvas", () => assert.equal(outsider.status, 404));
  const readOnly = await call("viewer", endpoint);
  check("viewer can read but is told the document is read-only", () => { assert.equal(readOnly.status, 200); assert.equal(readOnly.data.readOnly, true); });
  const viewerWrite = await call("viewer", endpoint, "PUT", { ...payload, revision: 1, mutationId: randomUUID() });
  check("viewer cannot save", () => assert.equal(viewerWrite.status, 403));
  const crossOrigin = await call("owner", endpoint, "PUT", payload, "https://foreign.invalid");
  check("cross-origin write denied", () => assert.equal(crossOrigin.status, 403));
  const invalid = await call("owner", endpoint, "PUT", { ...payload, canvas: "SHAKKERDATA://bad", revision: 1, mutationId: randomUUID() });
  check("invalid compressed document does not overwrite the saved canvas", () => assert.equal(invalid.status, 422));
  const badAsset = "SHAKKERDATA://" + gzipSync(JSON.stringify({ tldrawSnapshot: { document: { schema: {}, store: { "shape:x": { props: { url: "/api/workspaces/foreign/assets/a/raw" } } } } } })).toString("base64");
  const assetAttempt = await call("owner", endpoint, "PUT", { ...payload, canvas: badAsset, revision: 1, mutationId: randomUUID() });
  check("foreign asset reference rejected", () => { assert.equal(assetAttempt.status, 422); assert.equal(assetAttempt.data.code, "INVALID_ASSET_REFERENCE"); });
  const oldCanvas = await call("owner", `/api/workspaces/${ws}/projects/${pid}/canvas`);
  check("old simple canvas API remains separate", () => { assert.equal(oldCanvas.status, 200); assert.deepEqual(oldCanvas.data.items, []); });
  const archive = await call("owner", `/api/workspaces/${ws}/projects/${pid}`, "PATCH", { archive: true }); assert.equal(archive.status, 200);
  const archived = await call("owner", endpoint, "PUT", { ...payload, revision: 1, mutationId: randomUUID() });
  check("archived project refuses writes", () => { assert.equal(archived.status, 409); assert.equal(archived.data.code, "PROJECT_ARCHIVED"); });
  const after = await call("owner", endpoint);
  check("failed writes and archiving retain the exact document", () => { assert.equal(after.data.canvas, payload.canvas); assert.equal(after.data.revision, 1); assert.equal(after.data.readOnly, true); });

  // The reviewed native editor uses its original request/envelope shape. Test
  // that boundary through real cookies, HTTP, permissions and the same DB.
  const native = (actor: string, operation: string, body: unknown, workspace = ws, origin = base) =>
    call(actor, `/api/canva/project/${operation}?workspaceId=${workspace}`, "POST", body, origin);
  const nativeProject = await call("owner", `/api/workspaces/${ws}/projects`, "POST", { name: "Native adapter acceptance" });
  assert.equal(nativeProject.status, 201); const np = nativeProject.data.id;
  const nativeInitial = await native("owner", "queryProject", { projectId: np, cid: "1791452226131qfvxtohg" });
  check("native query uses the actual project and initial version", () => {
    assert.equal(nativeInitial.status, 200); assert.equal(nativeInitial.data.code, 0);
    assert.equal(nativeInitial.data.data.version, "novart-0"); assert.equal(nativeInitial.data.data.canvas, "");
  });
  const nativePayload = { projectId: np, canvas: encode("native adapter"), version: "novart-0", projectName: "Echoed old title", projectCoverList: [], picCount: 0, canvasV2Gray: false, canvasEvidenceEnabled: false };
  const nativeSaved = await native("owner", "saveProject", nativePayload);
  check("native full-save persists through the product service", () => { assert.equal(nativeSaved.status, 200); assert.equal(nativeSaved.data.code, 0); assert.equal(nativeSaved.data.data.version, "novart-1"); });
  const nativeReplay = await native("owner", "saveProject", { ...nativePayload, sessionId: "lost-response-retry", cid: "retry-client" });
  check("native identical retry remains idempotent without a client mutation UUID", () => {
    assert.equal(nativeReplay.data.code, 0); assert.equal(nativeReplay.data.data.version, "novart-1");
  });
  const nativeConflict = await native("owner", "saveProject", { ...nativePayload, canvas: encode("stale change") });
  check("native stale save activates the editor's exact conflict envelope", () => {
    assert.equal(nativeConflict.status, 200); assert.equal(nativeConflict.data.code, 100400); assert.equal(nativeConflict.data.data, null);
  });
  const nativeBadVersion = await native("owner", "saveProject", { ...nativePayload, version: "local-old" });
  check("native foreign revision format is rejected", () => assert.equal(nativeBadVersion.status, 422));
  const nativeOutsider = await native("outsider", "queryProject", { projectId: np });
  check("native query denies foreign workspace access", () => assert.equal(nativeOutsider.status, 404));
  const nativeViewerRead = await native("viewer", "queryProject", { projectId: np });
  check("native viewer receives a read-only project", () => assert.equal(nativeViewerRead.data.data.readOnly, true));
  const nativeViewerWrite = await native("viewer", "saveProject", { ...nativePayload, version: "novart-1" });
  check("native viewer cannot save", () => assert.equal(nativeViewerWrite.status, 403));
  const nativeCrossOrigin = await native("owner", "saveProject", nativePayload, ws, "https://foreign.invalid");
  check("native cross-origin writes are denied", () => assert.equal(nativeCrossOrigin.status, 403));
  const nativeRename = await native("owner", "updateProjectName", { projectId: np, projectName: "Renamed project" });
  assert.equal(nativeRename.data.code, 0);
  const nativeAutosave = await native("owner", "saveProject", { ...nativePayload, version: "novart-1", canvas: encode("next native edit") });
  assert.equal(nativeAutosave.data.code, 0);
  const nativeReopen = await native("owner", "queryProject", { projectId: np });
  check("native reopen preserves exact content and autosave cannot revert a renamed project", () => {
    assert.equal(nativeReopen.data.data.canvas, encode("next native edit")); assert.equal(nativeReopen.data.data.version, "novart-2");
    assert.equal(nativeReopen.data.data.projectName, "Renamed project");
  });
  const nativeList = await native("owner", "lovartProjectList", { page: 1, pageSize: 20 });
  check("native list contains saved project and excludes archived projects", () => {
    assert.ok(nativeList.data.data.data.some((x: any) => x.projectId === np && x.hasCanvas));
    assert.ok(!nativeList.data.data.data.some((x: any) => x.projectId === pid));
  });
  const nativeEvidence = await native("owner", "saveProject", { ...nativePayload, version: "novart-2", canvasEvidenceEnabled: true });
  const nativeUnknown = await native("owner", "getCanvasAccessTicket", { projectId: np });
  check("unimplemented vendor services are explicit failures", () => { assert.equal(nativeEvidence.status, 422); assert.equal(nativeUnknown.status, 503); });
  await call("owner", `/api/workspaces/${ws}/projects/${np}`, "PATCH", { archive: true });
  const nativeArchived = await native("owner", "saveProject", { ...nativePayload, version: "novart-2" });
  check("native adapter does not accept an archived project's save", () => assert.equal(nativeArchived.status, 409));
  await verifyStudioShellBackend({ call, check, base, ws, ownerId: owner.user.id, editorId: editor.user.id, encode });
  await verifyStudioMaterialsBackend({ call, check, base, ws });
  await verifyStudioGenerationBackend({ call, check, base, ws });
  console.log(`Workbench backend: ${passed} checks passed. No AI provider calls performed.`);
} finally { await prisma.$disconnect(); }
