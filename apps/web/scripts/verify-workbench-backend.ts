/** Disposable CI database only. No AI calls, generated assets or production credentials. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { prisma } from "@brandai/db";
import { hashPassword } from "../src/lib/password";

const base = process.env.WORKBENCH_TEST_URL ?? "http://127.0.0.1:3000";
const db = new URL(process.env.DATABASE_URL ?? "http://invalid");
if (db.pathname !== "/novart_integration_test" || !["localhost", "127.0.0.1"].includes(db.hostname) || !["localhost", "127.0.0.1"].includes(new URL(base).hostname)) {
  throw new Error("This test requires a loopback app and the disposable novart_integration_test database.");
}
let passed = 0;
const check = (label: string, fn: () => void) => { fn(); passed++; console.log(`PASS ${label}`); };
const sessions = new Map<string, Map<string, string>>();
async function call(actor: string, path: string, method = "GET", body?: unknown, origin = base) {
  const jar = sessions.get(actor) ?? new Map<string, string>(); sessions.set(actor, jar);
  const headers: Record<string, string> = { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") };
  if (method !== "GET") headers.Origin = origin;
  if (body !== undefined) headers["Content-Type"] = body instanceof URLSearchParams ? "application/x-www-form-urlencoded" : "application/json";
  const response = await fetch(base + path, { method, headers, redirect: "manual",
    body: body === undefined ? undefined : body instanceof URLSearchParams ? body.toString() : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";", 1)[0] ?? "", index = pair.indexOf("=");
    if (index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1));
  }
  const text = await response.text();
  let data: any; try { data = JSON.parse(text); } catch { data = null; }
  return { status: response.status, data };
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
  const ownerEmail = `native-owner-${run}@example.invalid`, viewerEmail = `native-viewer-${run}@example.invalid`, outsiderEmail = `native-outsider-${run}@example.invalid`;
  // Synthetic account fixtures only; authentication below uses the real password provider.
  await prisma.user.createMany({ data: await Promise.all([ownerEmail, viewerEmail, outsiderEmail].map(async email => ({ email, name: "Integration test", passwordHash: await hashPassword(password) }))) });
  const owner = await login("owner", ownerEmail, password);
  await login("viewer", viewerEmail, password); await login("outsider", outsiderEmail, password);
  check("password login returns a real user and no invented default brand", () => { assert.ok(owner.user.id); assert.equal(owner.activeWorkspaceId, null); });
  const anonymous = await call("anonymous", "/api/workbench/session");
  check("anonymous session denied", () => assert.equal(anonymous.status, 401));
  const brand = await call("owner", "/api/workspaces", "POST", { name: `Native integration ${run}` }); assert.equal(brand.status, 201);
  const ws = brand.data.id;
  const select = await call("owner", "/api/workbench/session", "POST", { workspaceId: ws });
  check("brand selection writes the real session-scoped cookie", () => assert.equal(select.data.activeWorkspaceId, ws));
  const reload = await call("owner", "/api/workbench/session");
  check("brand survives another request", () => assert.equal(reload.data.activeWorkspaceId, ws));
  const oversized = await call("owner", "/api/workbench/session", "POST", { workspaceId: ws, padding: "x".repeat(2048) });
  check("oversized brand-selection body rejected", () => assert.equal(oversized.status, 413));
  const foreign = await call("outsider", `/api/workbench/session?workspaceId=${ws}`);
  check("explicit foreign brand is rejected rather than silently switched", () => assert.equal(foreign.status, 404));
  const member = await call("owner", `/api/workspaces/${ws}/members`, "POST", { email: viewerEmail, role: "VIEWER" }); assert.equal(member.status, 201);
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
  console.log(`Workbench backend: ${passed} checks passed. No AI provider calls performed.`);
} finally { await prisma.$disconnect(); }
