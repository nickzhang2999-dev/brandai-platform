/** Real HTTP/password sessions + disposable PostgreSQL, using the material
 * actually uploaded by verify-studio-materials-backend. No manufactured assets. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { prisma } from "@brandai/db";
import { StudioWorkflowAssets, StudioWorkflowView, type StudioMaterial } from "@brandai/contracts";

type Result = { status: number; data: any; bytes?: Uint8Array };
type Options = {
  call: (actor: string, path: string, method?: string, body?: unknown, origin?: string, headers?: Record<string, string>) => Promise<Result>;
  check: (label: string, fn: () => void) => void;
  base: string; ws: string; projectId: string;
};
function assertDisposable(base: string) {
  const db = new URL(process.env.DATABASE_URL ?? "http://invalid");
  assert.equal(db.pathname, "/novart_integration_test");
  assert.ok(["localhost", "127.0.0.1"].includes(db.hostname));
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
}
const ok = (response: Result) => { assert.equal(response.status, 200, JSON.stringify(response.data)); return response.data; };
const path = (route: string, ws: string, projectId: string) => `${route}?workspaceId=${encodeURIComponent(ws)}&projectId=${encodeURIComponent(projectId)}`;

export async function verifyStudioWorkflowInitial({ call, check, base, ws, projectId }: Options) {
  assertDisposable(base);
  const workflow = StudioWorkflowView.parse(ok(await call("owner", path("/workflow", ws, projectId))));
  const assets = StudioWorkflowAssets.parse(ok(await call("viewer", path("/workflow/assets", ws, projectId))));
  const dbState = await prisma.workbenchProjectState.findUnique({ where: { projectId } });
  check("empty workflow reads are explicit and do not manufacture saved state or materials", () => {
    assert.deepEqual(workflow, { projectId, revision: 0, mode: "generate", target: null, references: [], updatedAt: null, issues: [] });
    assert.deepEqual(assets, { projectId, assets: [], issues: [] });
    assert.equal(dbState?.workflowRevision ?? 0, 0); assert.equal(dbState?.workflowUpdatedAt ?? null, null);
  });
}

export async function verifyStudioWorkflowBackend({ call, check, base, ws, projectId, material }: Options & { material: StudioMaterial }) {
  assertDisposable(base);
  const route = (name: string, project = projectId, workspace = ws) => path(name, workspace, project);
  const read = async (actor = "owner") => StudioWorkflowView.parse(ok(await call(actor, route("/workflow"))));
  const save = (body: unknown, actor = "owner") => call(actor, route("/workflow"), "POST", body);
  const payload = (revision: number, references: unknown[], extra: Record<string, unknown> = {}) => ({ projectId, revision, mode: "generate", target: null, references, ...extra });
  const ref = { shapeId: "shape:uploaded", assetSha256: material.assetSha256, purpose: "REFERENCE", participates: true };
  const target = { shapeId: ref.shapeId, assetSha256: ref.assetSha256 };
  const docRoute = `/api/workspaces/${ws}/projects/${projectId}/editor-document`;
  const originalDoc = ok(await call("owner", docRoute));
  const initial = await read();
  const contextBefore = ok(await call("owner", route("/compare/api/context")));
  const assets = StudioWorkflowAssets.parse(ok(await call("viewer", route("/workflow/assets"))));
  check("workflow uses the real uploaded image hash and the native c-image shape identity", () => {
    assert.equal(initial.revision, 0); assert.deepEqual(initial.references, []);
    assert.ok(assets.assets.some(item => item.shapeId === ref.shapeId && item.assetSha256 === material.assetSha256 && item.valid));
    assert.deepEqual(assets.issues, []);
  });

  const first = StudioWorkflowView.parse(ok(await save(payload(initial.revision, [ref]))));
  const reopened = await read("viewer");
  const stored = await prisma.workbenchProjectState.findUniqueOrThrow({ where: { projectId } });
  const contextAfter = ok(await call("owner", route("/compare/api/context")));
  check("workflow selection persists to PostgreSQL and reopens for another member without changing context", () => {
    assert.deepEqual(reopened, first); assert.equal(first.revision, 1); assert.deepEqual(first.references, [ref]);
    assert.deepEqual(stored.workflowReferences, [ref]); assert.equal(stored.workflowRevision, first.revision); assert.equal(stored.workspaceId, ws);
    assert.equal(contextAfter.revision, contextBefore.revision); assert.equal(contextAfter.brief, contextBefore.brief); assert.equal(contextAfter.notes, contextBefore.notes);
  });
  const stale = await save(payload(0, []));
  const denied = await save(payload(first.revision, []), "viewer");
  const outsider = await call("outsider", route("/workflow"));
  const anonymous = await call("anonymous", route("/workflow"));
  const crossOrigin = await call("owner", route("/workflow"), "POST", payload(first.revision, []), "https://foreign.invalid");
  check("workflow rejects stale writes, viewers, nonmembers, anonymous callers and foreign origins", () => {
    assert.equal(stale.status, 409); assert.equal(denied.status, 403); assert.equal(outsider.status, 404); assert.equal(anonymous.status, 401); assert.equal(crossOrigin.status, 403);
  });
  const races = await Promise.all(["EXACT", "ADAPTIVE"].map(purpose => save(payload(first.revision, [{ ...ref, purpose }]))));
  const concurrent = await read();
  check("real concurrent workflow saves serialize with exactly one winner", () => {
    assert.deepEqual(races.map(item => item.status).sort(), [200, 409]); assert.equal(concurrent.revision, first.revision + 1);
    assert.deepEqual(concurrent, races.find(item => item.status === 200)!.data);
  });
  const selectedRef = concurrent.references[0]!;
  const modifying = StudioWorkflowView.parse(ok(await save(payload(concurrent.revision, [selectedRef], { mode: "modify", target }))));
  check("an authenticated saved canvas image can be selected as the modify target", () => {
    assert.equal(modifying.mode, "modify"); assert.deepEqual(modifying.target, target); assert.deepEqual(modifying.issues, []);
  });
  const thumbnail = await call("viewer", route(`/workflow/image/${material.assetSha256}`));
  const foreignThumbnail = await call("outsider", route(`/workflow/image/${material.assetSha256}`));
  const missingThumbnail = await call("owner", route(`/workflow/image/${"0".repeat(64)}`));
  const sameBrandProject = await call("owner", `/api/workspaces/${ws}/projects`, "POST", { name: "Unlinked material project" });
  assert.equal(sameBrandProject.status, 201);
  const unlinkedThumbnail = await call("owner", route(`/workflow/image/${material.assetSha256}`, sameBrandProject.data.id));
  const unlinkedSave = await call("owner", route("/workflow", sameBrandProject.data.id), "POST", { ...payload(0, [ref]), projectId: sameBrandProject.data.id });
  const otherWorkspace = await call("owner", "/api/workspaces", "POST", { name: "Workflow isolation brand" });
  assert.equal(otherWorkspace.status, 201);
  const crossedRead = await call("owner", route("/workflow", projectId, otherWorkspace.data.id));
  const crossedWrite = await call("owner", route("/workflow", projectId, otherWorkspace.data.id), "POST", payload(modifying.revision, []));
  const crossedImage = await call("owner", route(`/workflow/image/${material.assetSha256}`, projectId, otherWorkspace.data.id));
  ok(await call("owner", "/api/workbench/session", "POST", { workspaceId: ws }));
  check("SHA alone never grants project/workspace thumbnail or workflow access", () => {
    assert.equal(thumbnail.status, 307); assert.equal(foreignThumbnail.status, 404); assert.equal(missingThumbnail.status, 404);
    assert.equal(unlinkedThumbnail.status, 404); assert.equal(unlinkedSave.status, 422);
    assert.equal(crossedRead.status, 404); assert.equal(crossedWrite.status, 404); assert.equal(crossedImage.status, 404);
  });

  // Remove only the shape through the real document API. The genuine uploaded
  // Asset remains untouched; this reproduces a stale saved selection.
  const emptyCanvas = "SHAKKERDATA://" + gzipSync(JSON.stringify({ tldrawSnapshot: { document: { schema: {}, store: {} } } })).toString("base64");
  const withoutImage = ok(await call("owner", docRoute, "PUT", { format: "novart-native-v1", canvas: emptyCanvas, revision: originalDoc.revision, mutationId: randomUUID() }));
  const missing = await read("viewer");
  check("removing a canvas shape retains the saved reference and target with explicit issues", () => {
    assert.deepEqual(missing.references, modifying.references); assert.deepEqual(missing.target, modifying.target);
    assert.ok(missing.issues.some(issue => issue.scope === "reference" && issue.code === "REFERENCE_MISSING" && issue.blocking));
    assert.ok(missing.issues.some(issue => issue.scope === "target" && issue.blocking));
  });
  const invalidNew = await save(payload(missing.revision, [{ ...ref, assetSha256: "f".repeat(64) }]));
  const retained = StudioWorkflowView.parse(ok(await save(payload(missing.revision, missing.references, { mode: missing.mode, target: missing.target }))));
  const disabled = StudioWorkflowView.parse(ok(await save(payload(retained.revision, [{ ...selectedRef, participates: false }]))));
  const enabledAgain = await save(payload(disabled.revision, [selectedRef]));
  const preservedDisabled = await read();
  check("old unavailable references can be retained or disabled but never introduced or reactivated", () => {
    assert.equal(invalidNew.status, 422); assert.ok(retained.issues.some(issue => issue.scope === "reference" && issue.blocking));
    assert.ok(disabled.issues.some(issue => issue.scope === "reference" && !issue.blocking));
    assert.equal(enabledAgain.status, 422); assert.deepEqual(preservedDisabled, disabled);
  });
  const removed = StudioWorkflowView.parse(ok(await save(payload(disabled.revision, []))));
  ok(await call("owner", docRoute, "PUT", { format: "novart-native-v1", canvas: originalDoc.canvas, revision: withoutImage.revision, mutationId: randomUUID() }));
  const restored = StudioWorkflowView.parse(ok(await save(payload(removed.revision, [ref]))));
  check("explicit removal and real canvas restoration recover a clean usable selection", () => {
    assert.deepEqual(removed.references, []); assert.deepEqual(removed.issues, []);
    assert.deepEqual(restored.references, [ref]); assert.deepEqual(restored.issues, []);
  });
  ok(await call("owner", `/api/workspaces/${ws}/projects/${projectId}`, "PATCH", { archive: true }));
  const archivedWrite = await save(payload(restored.revision, []));
  const archivedRead = await read("viewer");
  ok(await call("owner", `/api/workspaces/${ws}/projects/${projectId}`, "PATCH", { archive: false }));
  check("archiving prevents workflow edits while retaining readable selections", () => {
    assert.equal(archivedWrite.status, 409); assert.deepEqual(archivedRead, restored);
  });
}
