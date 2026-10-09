/** Real Auth.js cookies, HTTP routes and PostgreSQL. Called only by the guarded disposable-DB runner. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@brandai/db";
import { WorkbenchDraftView } from "@brandai/contracts";

type Result = { status: number; data: any };
type Options = {
  call: (actor: string, path: string, method?: string, body?: unknown, origin?: string, headers?: Record<string, string>) => Promise<Result>;
  check: (label: string, fn: () => void) => void;
  base: string; ws: string; ownerId: string; editorId: string; encode: (suffix?: string) => string;
};

export async function verifyStudioShellBackend({ call, check, base, ws, ownerId, editorId, encode }: Options) {
  const path = (route: string, workspace = ws, pid?: string) => `${route}?workspaceId=${workspace}${pid ? `&projectId=${pid}` : ""}`;
  const get = (route: string, actor = "owner", pid?: string, workspace = ws) => call(actor, path(route, workspace, pid));
  const post = (route: string, body: unknown, actor = "owner", workspace = ws) => call(actor, path(route, workspace), "POST", body);
  const ok = (result: Result) => { assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; };

  const initial = ok(await get("/studio/state"));
  const beforeWorkspaceCount = await prisma.brandWorkspace.count({ where: { ownerId } });
  const oldAccountCreate = await call("owner", "/api/workspaces", "POST", { name: "Old account page" }, base, { "X-Novart-User": editorId });
  const afterWorkspaceCount = await prisma.brandWorkspace.count({ where: { ownerId } });
  check("an old account's first-brand page cannot create a workspace for the new login", () => {
    assert.equal(oldAccountCreate.status, 409); assert.equal(afterWorkspaceCount, beforeWorkspaceCount);
  });
  const actualBrand = await prisma.brandWorkspace.findUniqueOrThrow({ where: { id: ws } });
  check("studio shell starts from the authenticated user and real brand", () => {
    assert.equal(initial.profile.nickname, "Integration test"); assert.equal(initial.brand.name, actualBrand.name);
    assert.equal(initial.revision, 0); assert.deepEqual(initial.favorites, []);
  });
  const anonymous = await call("anonymous", path("/studio/state"));
  const unknownBrand = await get("/studio/state", "outsider");
  const mismatch = await call("owner", path("/studio/state"), "GET", undefined, base, { "X-Novart-User": editorId });
  const matched = await call("owner", path("/studio/state"), "GET", undefined, base, { "X-Novart-User": ownerId });
  check("studio rejects anonymous, nonmember and switched-account requests", () => {
    assert.equal(anonymous.status, 401); assert.equal(unknownBrand.status, 404);
    assert.equal(mismatch.status, 409); assert.equal(matched.status, 200);
  });
  const noBrand = await call("outsider", "/studio/state");
  const noBrandSession = ok(await call("outsider", "/api/workbench/session"));
  check("loading an account without a brand never silently creates a workspace", () => {
    assert.equal(noBrand.status, 409); assert.equal(noBrandSession.activeWorkspaceId, null); assert.deepEqual(noBrandSession.workspaces, []);
  });
  const nativeUser = await call("owner", "/api/www/user/getUserInfo");
  const nativeClock = await call("owner", "/api/www/lovart/time/utc/timestamp");
  const nativeUserMismatch = await call("owner", "/api/www/user/getUserInfo", "GET", undefined, base, { "X-Novart-User": editorId });
  check("native bootstrap exposes the actual user and expected clock envelope without private account fields", () => {
    assert.equal(nativeUser.status, 200); assert.equal(nativeUser.data.code, 0); assert.equal(nativeUser.data.data.uuid, ownerId);
    assert.equal(nativeUser.data.data.nickname, "Integration test"); assert.ok(!("email" in nativeUser.data.data));
    assert.ok(Math.abs(Number(nativeClock.data.data.timestamp) - Date.now()) < 30000); assert.equal(nativeUserMismatch.status, 409);
  });
  const profileSaved = ok(await post("/studio/state", { ...initial, group: "profile",
    profile: { ...initial.profile, nickname: "我的个人昵称", density: "compact", motion: "reduce" },
    brand: { ...initial.brand, name: "must not rename brand" }, favorites: ["foreign-project"] }));
  check("profile-only save cannot overwrite echoed brand or favorites", () => {
    assert.equal(profileSaved.profile.nickname, "我的个人昵称"); assert.deepEqual(profileSaved.brand, initial.brand);
    assert.deepEqual(profileSaved.favorites, []); assert.equal(profileSaved.revision, 1);
  });
  const stale = await post("/studio/state", { ...initial, group: "profile" });
  const viewerInitial = ok(await get("/studio/state", "viewer"));
  const viewerOwn = ok(await post("/studio/state", { ...viewerInitial, group: "profile", profile: { ...viewerInitial.profile, nickname: "只读成员的偏好" } }, "viewer"));
  const viewerBrand = await post("/studio/state", { ...viewerOwn, group: "brand", brand: { ...viewerOwn.brand, name: "must not rename" } }, "viewer");
  const ownerAgain = ok(await get("/studio/state"));
  check("personal state is user-scoped; viewers may save preferences but not brand settings", () => {
    assert.equal(stale.status, 409); assert.equal(viewerBrand.status, 403);
    assert.equal(ownerAgain.profile.nickname, "我的个人昵称"); assert.equal(viewerOwn.profile.nickname, "只读成员的偏好");
  });
  const rulesBefore = await prisma.brandRule.count({ where: { workspaceId: ws } });
  const brandSaved = ok(await post("/studio/state", { ...ownerAgain, group: "brand",
    profile: { ...ownerAgain.profile, nickname: "ignored profile" },
    brand: { name: "真实品牌修改", colors: ["#123456", "#ABCDEF", "#7C5CFF"], font: "serif", notes: "这是草稿，尚未确认生成规则" } }));
  const editorState = ok(await get("/studio/state", "editor"));
  const viewerBrandConflict = await post("/studio/state", { ...viewerOwn, group: "profile" }, "viewer");
  const renamed = await prisma.brandWorkspace.findUniqueOrThrow({ where: { id: ws } });
  const rulesAfter = await prisma.brandRule.count({ where: { workspaceId: ws } });
  check("shared brand draft persists without promoting generation rules or changing private profiles", () => {
    assert.equal(renamed.name, "真实品牌修改"); assert.equal(brandSaved.profile.nickname, "我的个人昵称");
    assert.deepEqual(editorState.brand, brandSaved.brand); assert.equal(editorState.profile.nickname, "Integration test");
    assert.equal(rulesAfter, rulesBefore); assert.equal(viewerBrandConflict.status, 409);
  });
  const race = await Promise.all(["first", "second"].map(nickname => post("/studio/state", { ...brandSaved, group: "profile", profile: { ...brandSaved.profile, nickname } })));
  const afterRace = ok(await get("/studio/state"));
  check("concurrent shell writes have one winner and one conflict", () => {
    assert.deepEqual(race.map(r => r.status).sort(), [200, 409]);
    assert.equal(afterRace.revision, brandSaved.revision + 1);
    assert.equal(afterRace.profile.nickname, race.find(r => r.status === 200)!.data.profile.nickname);
  });

  const createPayload = { projectName: "  首页创建项目  ", brief: "首页中文需求\n" + "细".repeat(2500), requestId: randomUUID() };
  const creation = await Promise.all([post("/compare/api/create", createPayload), post("/compare/api/create", createPayload)]);
  const pid = ok(creation[0]).projectId; ok(creation[1]);
  const conflictingRetry = await post("/compare/api/create", { ...createPayload, brief: "changed request" });
  const createdRows = await prisma.project.count({ where: { workspaceId: ws, name: "首页创建项目" } });
  check("concurrent create retries produce exactly one real project and reject changed content", () => {
    assert.equal(creation[1].data.projectId, pid); assert.equal(createdRows, 1); assert.equal(conflictingRetry.status, 409);
  });
  const viewerCreate = await post("/compare/api/create", { ...createPayload, requestId: randomUUID() }, "viewer");
  const invalidCreate = await post("/compare/api/create", { projectName: "Missing idempotency key", brief: "" });
  check("project creation requires edit permission and a retry identifier", () => { assert.equal(viewerCreate.status, 403); assert.equal(invalidCreate.status, 422); });
  const context = ok(await get("/compare/api/context", "owner", pid));
  check("homepage brief survives project creation without truncating the document context", () => {
    assert.equal(context.brief, createPayload.brief); assert.equal(context.revision, 1); assert.equal(context.notes, "");
  });
  const ctxSaved = ok(await post("/compare/api/context", { projectId: pid, revision: context.revision, brief: "修改需求\n保持换行", notes: "中文笔记" }));
  const ctxStale = await post("/compare/api/context", { projectId: pid, revision: context.revision, brief: "stale", notes: "" });
  const ctxReadOnly = await post("/compare/api/context", { projectId: pid, revision: ctxSaved.revision, brief: "denied", notes: "" }, "viewer");
  const ctxReload = ok(await get("/compare/api/context", "editor", pid));
  check("project context is shared, revision-checked, and cannot be overwritten by viewers", () => {
    assert.equal(ctxStale.status, 409); assert.equal(ctxReadOnly.status, 403); assert.deepEqual(ctxReload, ctxSaved);
  });

  const secondBrand = await call("owner", "/api/workspaces", "POST", { name: "Separate studio brand" }); assert.equal(secondBrand.status, 201);
  const ws2 = secondBrand.data.id;
  const secondProject = ok(await post("/compare/api/create", createPayload, "owner", ws2));
  const favoriteForeign = await post("/studio/state", { ...afterRace, group: "favorites", favorites: [secondProject.projectId] });
  const foreignContext = await get("/compare/api/context", "owner", secondProject.projectId);
  const favoriteSaved = ok(await post("/studio/state", { ...afterRace, group: "favorites", favorites: [pid, pid],
    profile: { ...afterRace.profile, nickname: "ignored again" }, brand: { ...afterRace.brand, name: "ignored brand again" } }));
  check("favorites validate project ownership, deduplicate ids, and leave other settings intact", () => {
    assert.equal(favoriteForeign.status, 422); assert.equal(foreignContext.status, 404); assert.notEqual(secondProject.projectId, pid);
    assert.deepEqual(favoriteSaved.favorites, [pid]); assert.deepEqual(favoriteSaved.profile, afterRace.profile); assert.deepEqual(favoriteSaved.brand, afterRace.brand);
  });
  const viewerFavorites = ok(await get("/studio/state", "viewer"));
  check("favorite selections stay private while collaborators see the same shared brand", () => {
    assert.deepEqual(viewerFavorites.favorites, []); assert.deepEqual(viewerFavorites.brand, favoriteSaved.brand);
  });
  const forbiddenContext = await post("/compare/api/context", { projectId: secondProject.projectId, revision: 1, brief: "forbidden", notes: "" });
  const forbiddenArchive = await post("/studio/project-archive", { projectId: secondProject.projectId, archived: true, revision: 0, projectVersion: "novart-0" });
  const retainedForeignContext = ok(await get("/compare/api/context", "owner", secondProject.projectId, ws2));
  check("a project id from another brand cannot be edited or archived through the active brand", () => {
    assert.equal(forbiddenContext.status, 404); assert.equal(forbiddenArchive.status, 404); assert.equal(retainedForeignContext.brief, createPayload.brief);
  });
  ok(await call("owner", "/api/workbench/session", "POST", { workspaceId: ws2 }));
  const cookieState = ok(await call("owner", "/studio/state"));
  const pinnedState = ok(await get("/studio/state"));
  const pinnedLibrary = ok(await get("/studio/project-library"));
  check("workspace URL stays authoritative after another tab changes the brand cookie", () => {
    assert.equal(cookieState.brand.name, "Separate studio brand"); assert.equal(pinnedState.brand.name, "真实品牌修改");
    assert.ok(pinnedLibrary.projects.some((p: any) => p.projectId === pid));
    assert.ok(!pinnedLibrary.projects.some((p: any) => p.projectId === secondProject.projectId));
  });
  ok(await call("owner", "/api/workbench/session", "POST", { workspaceId: ws }));

  // The native restore path requires inputForm.text; prompt-only fixtures used
  // to pass the API check while producing drafts the real UI could not reopen.
  const draft = { projectId: pid, revision: 0, inputForm: { text: "给我一个海边方案\n角色保持一致", ratio: "1:1", model: "preferred-model", paramList: [], mentionPreviewList: [], lexicalJSONState: { root: { children: [] } } } };
  const emptyDraft = ok(await get("/studio/draft", "owner", pid));
  const savedDraft = ok(await post("/studio/draft", draft));
  const editorDraft = ok(await get("/studio/draft", "editor", pid));
  const savedEditorDraft = ok(await post("/studio/draft", { ...draft, inputForm: { text: "编辑者自己的文字" } }, "editor"));
  const reopenedDraft = ok(await get("/studio/draft", "owner", pid));
  check("chat drafts persist per user and do not leak to another collaborator", () => {
    assert.equal(emptyDraft.inputForm, null); assert.equal(emptyDraft.revision, 0);
    assert.deepEqual(reopenedDraft.inputForm, draft.inputForm); assert.equal(reopenedDraft.revision, 1);
    assert.equal(editorDraft.inputForm, null); assert.equal(editorDraft.revision, 0); assert.equal(savedEditorDraft.revision, 1);
  });
  check("empty, saved and reopened drafts expose complete native receipts and checked reference issues", () => {
    assert.deepEqual(emptyDraft, { projectId: pid, revision: 0, inputForm: null, updatedAt: null, referenceIssues: [] });
    for (const receipt of [emptyDraft, savedDraft, editorDraft, savedEditorDraft, reopenedDraft]) {
      assert.deepEqual(WorkbenchDraftView.parse(receipt), receipt); assert.deepEqual(receipt.referenceIssues, []);
    }
    assert.deepEqual(savedDraft, reopenedDraft); assert.equal(savedDraft.revision, draft.revision + 1);
    assert.deepEqual(savedDraft.inputForm, draft.inputForm); assert.ok(savedDraft.updatedAt > 0);
  });
  const invalidDrafts = await Promise.all([
    {}, { prompt: "unrestorable" }, { text: null }, { text: 3 }, [],
  ].map(inputForm => post("/studio/draft", { ...draft, revision: savedDraft.revision, inputForm })));
  const nativeMetadata = await Promise.all([
    post("/studio/draft", { ...draft, revision: savedDraft.revision, cid: "native-only" }),
    post("/compare/api/context", { projectId: pid, revision: ctxSaved.revision, brief: "", notes: "", cid: "native-only" }),
    post("/studio/project-archive", { projectId: pid, archived: true, revision: 0, projectVersion: "novart-0", cid: "native-only" }),
  ]);
  check("shell writes reject native-only cid and drafts the original composer cannot restore", () => {
    assert.deepEqual(invalidDrafts.map(result => result.status), [422, 422, 422, 422, 422]);
    assert.deepEqual(nativeMetadata.map(result => result.status), [422, 422, 422]);
  });
  const staleDraft = await post("/studio/draft", { ...draft, inputForm: { text: "stale overwrite" } });
  const viewerDraft = await post("/studio/draft", draft, "viewer");
  const foreignDraft = await post("/studio/draft", { ...draft, projectId: secondProject.projectId });
  const outsiderDraft = await get("/studio/draft", "outsider", pid);
  const mediaDraft = await post("/studio/draft", { ...draft, revision: savedDraft.revision, inputForm: { text: "保留正文", attachments: [{ url: "blob:transient" }] } });
  const mediaFields = ["imageUrl", "thumbnail", "videoUrl", "audioUrl", "fileUrl", "url", "src", "originalUrl"];
  const mediaForms = await Promise.all(mediaFields.map(field => post("/studio/draft", { ...draft, revision: savedDraft.revision,
    inputForm: { text: "保留正文", paramList: [{ data: { [field]: "https://local-assets.invalid/" + "a".repeat(64) } }] } })));
  const malformedMedia = await post("/studio/draft", { ...draft, revision: savedDraft.revision, inputForm: { text: "保留正文", audioUrl: ["https://media.invalid/audio"] } });
  const largeDraft = await post("/studio/draft", { ...draft, revision: savedDraft.revision, inputForm: { text: "x".repeat(257 * 1024) } });
  let deep: Record<string, unknown> = { text: "deep" }; for (let i = 0; i < 65; i++) deep = { next: deep };
  const deepDraft = await post("/studio/draft", { ...draft, revision: savedDraft.revision, inputForm: { text: "", deep } });
  const retainedDraft = ok(await get("/studio/draft", "owner", pid));
  check("draft conflicts, permissions, transient media, size and depth failures retain the saved draft", () => {
    assert.equal(staleDraft.status, 409); assert.equal(viewerDraft.status, 403); assert.equal(foreignDraft.status, 404); assert.equal(outsiderDraft.status, 404);
    assert.equal(mediaDraft.status, 422); assert.equal(largeDraft.status, 413); assert.equal(deepDraft.status, 422); assert.deepEqual(retainedDraft, reopenedDraft);
  });
  check("all native media fields require real persistence, including audio and persistent-looking URLs", () => {
    assert.deepEqual(mediaForms.map(result => result.status), mediaFields.map(() => 422));
    assert.equal(malformedMedia.status, 422); assert.deepEqual(retainedDraft, reopenedDraft);
  });

  const docEndpoint = `/api/workspaces/${ws}/projects/${pid}/editor-document`;
  const document = { format: "novart-native-v1", canvas: encode("studio roundtrip"), revision: 0, mutationId: randomUUID() };
  ok(await call("owner", docEndpoint, "PUT", document));
  const status = ok(await get("/compare/api/status", "owner", pid));
  const library = ok(await get("/studio/project-library"));
  const listed = library.projects.find((p: any) => p.projectId === pid);
  check("saved native canvas feeds real project-library and save-status metadata", () => {
    assert.equal(status.version, "novart-1"); assert.ok(status.savedAt > 0); assert.equal(status.saveError, null);
    assert.equal(listed.projectName, "首页创建项目"); assert.equal(listed.hasCanvas, true); assert.equal(listed.version, status.version); assert.equal(listed.archivedAt, null);
  });
  const archivePayload = { projectId: pid, archived: true, revision: 0, projectVersion: "novart-0" };
  const staleArchive = await post("/studio/project-archive", archivePayload);
  const viewerArchive = await post("/studio/project-archive", { ...archivePayload, projectVersion: status.version }, "viewer");
  const archived = ok(await post("/studio/project-archive", { ...archivePayload, projectVersion: status.version }));
  const staleRestore = await post("/studio/project-archive", { ...archivePayload, archived: false, projectVersion: status.version });
  const archiveLibrary = ok(await get("/studio/project-library"));
  const archivedListed = archiveLibrary.projects.find((p: any) => p.projectId === pid);
  check("archive checks both document version and archive revision, while retaining the project", () => {
    assert.equal(staleArchive.status, 409); assert.equal(viewerArchive.status, 403); assert.equal(archived.archived, true); assert.equal(staleRestore.status, 409);
    assert.ok(archivedListed.archivedAt > 0); assert.equal(archivedListed.archiveRevision, 1); assert.equal(archivedListed.hasCanvas, true);
  });
  const archivedContext = await post("/compare/api/context", { projectId: pid, revision: ctxSaved.revision, brief: "must retain", notes: "" });
  const archivedDraft = await post("/studio/draft", { ...draft, revision: savedDraft.revision, inputForm: null });
  const archivedDoc = await call("owner", docEndpoint);
  check("archiving locks context, chat draft and document writes without discarding content", () => {
    assert.equal(archivedContext.status, 409); assert.equal(archivedDraft.status, 409);
    assert.equal(archivedDoc.data.canvas, document.canvas); assert.equal(archivedDoc.data.readOnly, true);
  });
  ok(await post("/studio/project-archive", { ...archivePayload, archived: false, revision: 1, projectVersion: status.version }));
  const cleared = ok(await post("/studio/draft", { projectId: pid, revision: savedDraft.revision, inputForm: null }));
  const clearedReopen = ok(await get("/studio/draft", "owner", pid));
  const editorRetained = ok(await get("/studio/draft", "editor", pid));
  check("restoring resumes editing and explicit null clears only the current user's draft", () => {
    assert.equal(cleared.revision, 2); assert.equal(clearedReopen.inputForm, null); assert.equal(clearedReopen.revision, 2);
    assert.deepEqual(WorkbenchDraftView.parse(cleared), cleared); assert.deepEqual(cleared.referenceIssues, []);
    assert.deepEqual(cleared, clearedReopen);
    assert.deepEqual(editorRetained, savedEditorDraft);
  });
  const mutations: Array<[string, unknown]> = [
    ["/studio/state", { ...favoriteSaved, group: "profile" }], ["/compare/api/create", { ...createPayload, requestId: randomUUID() }],
    ["/compare/api/context", { projectId: pid, revision: ctxSaved.revision, brief: "cross origin", notes: "" }],
    ["/studio/draft", { projectId: pid, revision: 2, inputForm: { text: "cross origin" } }],
    ["/studio/project-archive", { ...archivePayload, revision: 2, projectVersion: status.version }],
  ];
  const crossOrigin = await Promise.all(mutations.map(([route, body]) => call("owner", path(route), "POST", body, "https://foreign.invalid")));
  const accountChanged = await call("owner", path("/studio/draft"), "POST", { projectId: pid, revision: 2, inputForm: { text: "old tab" } }, base, { "X-Novart-User": editorId });
  const finalDraft = ok(await get("/studio/draft", "owner", pid));
  check("all studio write endpoints reject cross-origin requests and old-account tabs cannot mutate", () => {
    assert.deepEqual(crossOrigin.map(r => r.status), [403, 403, 403, 403, 403]); assert.equal(accountChanged.status, 409); assert.deepEqual(finalDraft, clearedReopen);
  });
  const unsupported = await post("/studio/start/upload", { name: "upload not wired yet" });
  check("unconnected homepage upload remains an explicit failure, never a fake success", () => assert.equal(unsupported.status, 503));
  const legacyDescription = "Existing project requirements must survive first archive";
  const legacy = await call("owner", `/api/workspaces/${ws}/projects`, "POST", { name: "Legacy archive", description: legacyDescription });
  assert.equal(legacy.status, 201);
  const legacyId = legacy.data.id;
  ok(await post("/studio/project-archive", { projectId: legacyId, archived: true, revision: 0, projectVersion: "novart-0" }));
  ok(await post("/studio/project-archive", { projectId: legacyId, archived: false, revision: 1, projectVersion: "novart-0" }));
  const legacyContext = ok(await get("/compare/api/context", "owner", legacyId));
  check("first archive and restore preserves requirements from a project created by the original API", () => assert.equal(legacyContext.brief, legacyDescription));
  const emptyThread = await post("/api/canva/agent/queryAgentLastThread", { projectId: pid, cid: "1791452226131qfvxtohg" });
  const foreignThread = await post("/api/canva/agent/queryAgentLastThread", { projectId: secondProject.projectId });
  const unsupportedAi = await post("/api/canva/agent/createThread", { projectId: pid });
  check("projects without generation history return an actual empty thread, and unconnected AI cannot run", () => {
    assert.equal(emptyThread.status, 200); assert.equal(emptyThread.data.code, 0); assert.equal(emptyThread.data.data, null);
    assert.equal(foreignThread.status, 404); assert.equal(unsupportedAi.status, 503);
  });
}
