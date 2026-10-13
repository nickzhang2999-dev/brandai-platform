/** Real Auth.js/password sessions, HTTP routes and disposable PostgreSQL.
 * Called by verify-workbench-backend.ts. Account fixtures come from that runner;
 * every brand, membership, draft, rule and snapshot mutation below uses HTTP.
 * Prisma is read-only evidence here. No AI provider or worker calls are made.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@brandai/db";
import { ListRuleSnapshotsResponse, RestoreRuleSnapshotResult, WorkbenchShellState } from "@brandai/contracts";
import { StudioBrandDraftImportResult, StudioBrandDraftImportState } from "../../../packages/contracts/src/studio-brand-knowledge";

type Result = { status: number; data: any };
type Options = {
  call: (actor: string, path: string, method?: string, body?: unknown, origin?: string, headers?: Record<string, string>) => Promise<Result>;
  check: (label: string, fn: () => void) => void;
  base: string;
  ws: string;
};

function assertDisposable(base: string) {
  const database = new URL(process.env.DATABASE_URL ?? "http://invalid");
  assert.equal(database.pathname, "/novart_integration_test", "Brand knowledge acceptance requires the disposable integration database");
  assert.ok(["localhost", "127.0.0.1"].includes(database.hostname), "Database must be loopback");
  const app = new URL(base);
  assert.ok(["localhost", "127.0.0.1"].includes(app.hostname), "Application must be loopback");
  assert.equal(app.protocol, "http:", "The local HTTP/password harness does not accept remote origins");
}

const ok = (result: Result, expected = 200) => {
  assert.equal(result.status, expected, "Unexpected knowledge API status");
  return result.data;
};

export async function verifyStudioBrandKnowledgeBackend({ call, check, base, ws }: Options) {
  assertDisposable(base);
  // Rules belong to a brand, not a project. A fresh brand prevents this suite
  // from retiring rules or changing drafts used by the other backend suites.
  const sourceMembers = ok(await call("owner", `/api/workspaces/${ws}/members`));
  const editor = sourceMembers.members.find((member: any) => member.role === "EDITOR");
  const viewer = sourceMembers.members.find((member: any) => member.role === "VIEWER");
  assert.ok(editor?.email && viewer?.email, "Runner must establish its editor and viewer memberships first");
  const createdBrand = ok(await call("owner", "/api/workspaces", "POST", { name: `Knowledge HTTP acceptance ${randomUUID().slice(0, 8)}` }), 201);
  const knowledgeWs: string = createdBrand.id;
  const route = (name: string, workspace = knowledgeWs) => `${name}?workspaceId=${encodeURIComponent(workspace)}`;
  const rulesPath = `/api/workspaces/${knowledgeWs}/rules`;
  const snapshotPath = `${rulesPath}/snapshots`;
  const importPath = route("/api/studio/brand-knowledge/import-draft");
  const readRules = async (actor = "owner") => ok(await call(actor, rulesPath)) as any[];
  const readShell = async (actor = "owner") => WorkbenchShellState.parse(ok(await call(actor, route("/studio/state"))));
  const readImport = async (actor = "owner") => StudioBrandDraftImportState.parse(ok(await call(actor, importPath)));
  const importDraft = (body: unknown, actor = "owner") => call(actor, importPath, "POST", body);
  const patchRule = (ruleId: string, body: unknown, actor = "owner") => call(actor, `${rulesPath}/${ruleId}`, "PATCH", body);
  const restore = (snapshotId: string, actor = "owner", workspace = knowledgeWs) =>
    call(actor, `/api/workspaces/${workspace}/rules/snapshots/${snapshotId}/restore`, "POST", {});
  const confirmed = (rules: any[]) => rules.filter(rule => rule.status === "CONFIRMED");
  const ruleState = (rules: any[]) => rules.map(rule => ({ id: rule.id, type: rule.type, status: rule.status,
    summary: rule.summary, strength: rule.strength, value: rule.value, structured: rule.structured ?? null,
    evidence: rule.evidence })).sort((a, b) => a.id.localeCompare(b.id));

  try {
    ok(await call("owner", `/api/workspaces/${knowledgeWs}/members`, "POST", { email: editor.email, role: "EDITOR" }), 201);
    ok(await call("owner", `/api/workspaces/${knowledgeWs}/members`, "POST", { email: viewer.email, role: "VIEWER" }), 201);
    const project = ok(await call("owner", `/api/workspaces/${knowledgeWs}/projects`, "POST", { name: "Knowledge acceptance independent project" }), 201);
    const projectRow = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    check("knowledge acceptance isolates its brand and project through the real API", () => {
      assert.notEqual(knowledgeWs, ws); assert.equal(projectRow.workspaceId, knowledgeWs);
    });

    const empty = await readImport("viewer");
    const noDraft = await importDraft({ mutationId: randomUUID(), expectedDraftRevision: 1 });
    const initialRules = await readRules();
    check("a new brand has no invented draft or knowledge and refuses import before save", () => {
      assert.deepEqual(empty, { available: false, draftRevision: 0, importableTypes: [], hasNotes: false });
      assert.equal(noDraft.status, 404); assert.deepEqual(initialRules, []);
    });

    let shell = await readShell();
    const brand = { ...shell.brand, colors: ["#123456", "#ABCDEF", "#7C5CFF"], font: "serif" as const,
      notes: "真实 HTTP 草稿备注：仅作待确认来源，不自动作为生成约束。" };
    shell = WorkbenchShellState.parse(ok(await call("owner", route("/studio/state"), "POST", { ...shell, group: "brand", brand })));
    // Personal writes change shell revision but not the shared brand revision.
    // This catches accidentally using WorkbenchShellState.revision for import.
    for (const density of ["compact", "comfortable"] as const) {
      shell = WorkbenchShellState.parse(ok(await call("owner", route("/studio/state"), "POST", {
        ...shell, group: "profile", profile: { ...shell.profile, density },
      })));
    }
    const available = await readImport("editor");
    const draftRow = await prisma.workbenchBrandDraft.findUniqueOrThrow({ where: { workspaceId: knowledgeWs } });
    check("saved brand draft reopens for collaborators and exposes its own PostgreSQL revision", () => {
      assert.deepEqual(draftRow.colors, brand.colors); assert.equal(draftRow.font, brand.font); assert.equal(draftRow.notes, brand.notes);
      assert.equal(available.draftRevision, draftRow.revision); assert.notEqual(available.draftRevision, shell.revision);
      assert.deepEqual(available.importableTypes, ["color", "font"]); assert.equal(available.hasNotes, true);
    });

    const input = { mutationId: randomUUID(), expectedDraftRevision: available.draftRevision };
    const imports = await Promise.all([importDraft(input), importDraft(input)]);
    const receipts = imports.map(result => StudioBrandDraftImportResult.parse(ok(result)));
    const receipt = receipts.find(result => !result.replayed)!;
    const imported = await readRules("viewer");
    const storedReceipt = await prisma.workbenchKnowledgeImport.findFirstOrThrow({ where: { workspaceId: knowledgeWs, mutationId: input.mutationId } });
    check("concurrent lost-response retries create exactly two draft rules and one durable receipt", () => {
      assert.equal(receipts.length, 2); const first = receipts[0], second = receipts[1]; assert.ok(first && second);
      assert.equal(receipts.filter(result => result.replayed).length, 1); assert.ok(receipt);
      assert.deepEqual(first.ruleIds, second.ruleIds); assert.equal(imported.length, 2);
      assert.equal(imported.every(rule => rule.status === "DRAFT" && rule.strength === "WEAK"), true);
      assert.deepEqual(storedReceipt.ruleIds, receipt.ruleIds); assert.equal(storedReceipt.ruleCount, 2);
      assert.equal(storedReceipt.draftRevision, draftRow.revision); assert.equal(receipt.notesPreserved, true);
    });
    const color = imported.find(rule => rule.type === "color")!;
    const font = imported.find(rule => rule.type === "font")!;
    const confirmedInitially = confirmed(imported);
    check("import preserves explicit palette/font sources without silently activating generation rules", () => {
      assert.deepEqual(color.value.colors, brand.colors); assert.deepEqual(font.value.fonts, ["serif"]);
      assert.equal(color.value.novartSource.mutationId, input.mutationId); assert.equal(font.value.novartSource.draftRevision, draftRow.revision);
      assert.equal(color.structured.module, "color"); assert.equal(font.structured.module, "font");
      assert.equal(confirmedInitially.length, 0);
    });

    const changedReceipt = await importDraft({ ...input, expectedDraftRevision: input.expectedDraftRevision + 1 });
    const invalidReceipt = await importDraft({ ...input, unexpected: "not part of the contract" });
    const countAfterConflicts = await prisma.brandRule.count({ where: { workspaceId: knowledgeWs } });
    check("changed retry content and unknown fields cannot create extra rules", () => {
      assert.equal(changedReceipt.status, 409); assert.equal(invalidReceipt.status, 422); assert.equal(countAfterConflicts, 2);
    });

    ok(await patchRule(color.id, { status: "CONFIRMED", strength: "STRONG" }, "editor"));
    ok(await patchRule(font.id, { status: "CONFIRMED" }));
    const confirmedRules = await readRules("viewer");
    const databaseConfirmed = await prisma.brandRule.findMany({ where: { workspaceId: knowledgeWs, status: "CONFIRMED" } });
    check("explicit confirmation persists the shared effective rule set and rule strength", () => {
      assert.equal(confirmed(confirmedRules).length, 2); assert.equal(databaseConfirmed.length, 2);
      assert.equal(databaseConfirmed.find(rule => rule.id === color.id)?.strength, "STRONG");
    });

    const savedSnapshot = ok(await call("editor", snapshotPath, "POST", { label: "HTTP 已确认品牌知识版本", note: "包含真实草稿导入并确认的颜色与字体" }), 201);
    const snapshotRow = await prisma.ruleSnapshot.findUniqueOrThrow({ where: { id: savedSnapshot.id } });
    const snapshotList = ListRuleSnapshotsResponse.parse(ok(await call("viewer", snapshotPath)));
    check("knowledge snapshot stores the confirmed payload in PostgreSQL and lists metadata for viewers", () => {
      assert.equal(snapshotRow.workspaceId, knowledgeWs); assert.equal(snapshotRow.ruleCount, 2);
      assert.deepEqual(ruleState(snapshotRow.rules as any[]), ruleState(confirmed(confirmedRules)));
      assert.ok(snapshotList.snapshots.some(snapshot => snapshot.id === savedSnapshot.id && snapshot.ruleCount === 2));
      assert.ok(snapshotList.snapshots.every(snapshot => !("rules" in snapshot)));
    });

    const replacement = ok(await call("editor", rulesPath, "POST", { type: "color", summary: "新颜色规则", value: { colors: ["#654321"] } }), 201);
    ok(await patchRule(replacement.id, { status: "CONFIRMED" }, "editor"));
    const replacedRules = await readRules("viewer");
    check("confirming a replacement retires the earlier rule of the same type atomically", () => {
      assert.equal(replacedRules.find(rule => rule.id === color.id)?.status, "REJECTED");
      assert.equal(replacedRules.find(rule => rule.id === replacement.id)?.status, "CONFIRMED");
      assert.equal(confirmed(replacedRules).filter(rule => rule.type === "color").length, 1);
    });

    ok(await call("editor", `${rulesPath}/${font.id}`, "DELETE"));
    const replayAfterDelete = StudioBrandDraftImportResult.parse(ok(await importDraft(input)));
    const deletedFont = await prisma.brandRule.findUnique({ where: { id: font.id } });
    check("replaying the durable import receipt does not resurrect a subsequently deleted rule", () => {
      assert.equal(replayAfterDelete.replayed, true); assert.deepEqual(replayAfterDelete.ruleIds, receipt.ruleIds); assert.equal(deletedFont, null);
    });

    const preRestore = await readRules();
    const restored = RestoreRuleSnapshotResult.parse(ok(await restore(savedSnapshot.id, "editor")));
    const afterRestore = await readRules("viewer");
    const backup = await prisma.ruleSnapshot.findUniqueOrThrow({ where: { id: restored.backupSnapshotId } });
    check("snapshot restore recreates deleted originals, retires replacements and captures a real backup", () => {
      assert.equal(restored.restored, 2); assert.equal(restored.retired, 1);
      assert.deepEqual(ruleState(confirmed(afterRestore)), ruleState(confirmed(confirmedRules)));
      assert.equal(afterRestore.find(rule => rule.id === replacement.id)?.status, "REJECTED");
      assert.equal(backup.workspaceId, knowledgeWs); assert.deepEqual(ruleState(backup.rules as any[]), ruleState(confirmed(preRestore)));
    });
    const rolledForward = RestoreRuleSnapshotResult.parse(ok(await restore(backup.id)));
    const afterBackupRestore = await readRules("viewer");
    check("the pre-restore backup can undo the rollback without losing historical rules", () => {
      assert.deepEqual(ruleState(confirmed(afterBackupRestore)), ruleState(confirmed(preRestore)));
      assert.equal(rolledForward.restored, 1); assert.equal(rolledForward.retired, 2);
      assert.ok(afterBackupRestore.some(rule => rule.id === color.id)); assert.ok(afterBackupRestore.some(rule => rule.id === font.id));
    });

    const priorRules = ruleState(await readRules());
    const priorSnapshotCount = await prisma.ruleSnapshot.count({ where: { workspaceId: knowledgeWs } });
    const priorImportCount = await prisma.workbenchKnowledgeImport.count({ where: { workspaceId: knowledgeWs } });
    const viewerAttempts = await Promise.all([
      importDraft({ mutationId: randomUUID(), expectedDraftRevision: draftRow.revision }, "viewer"),
      call("viewer", rulesPath, "POST", { type: "copy", summary: "不允许写入" }),
      patchRule(replacement.id, { summary: "不允许修改" }, "viewer"),
      call("viewer", `${rulesPath}/${replacement.id}`, "DELETE"),
      call("viewer", snapshotPath, "POST", { label: "不允许快照" }),
      restore(savedSnapshot.id, "viewer"),
    ]);
    const viewerSession = ok(await call("viewer", `/api/workbench/session?workspaceId=${knowledgeWs}`));
    check("viewer role is server-authoritative and all knowledge write paths reject it", () => {
      assert.equal(viewerSession.workspaces.find((workspace: any) => workspace.id === knowledgeWs)?.role, "VIEWER");
      assert.deepEqual(viewerAttempts.map(result => result.status), [403, 403, 403, 403, 403, 403]);
    });

    const outsiders = await Promise.all([
      call("outsider", rulesPath), call("outsider", snapshotPath), call("outsider", importPath),
      importDraft({ mutationId: randomUUID(), expectedDraftRevision: draftRow.revision }, "outsider"),
      restore(savedSnapshot.id, "outsider"),
    ]);
    const crossedRule = await call("owner", `/api/workspaces/${ws}/rules/${replacement.id}`, "PATCH", { status: "CONFIRMED" });
    const crossedDelete = await call("owner", `/api/workspaces/${ws}/rules/${replacement.id}`, "DELETE");
    const crossedSnapshot = await restore(savedSnapshot.id, "owner", ws);
    check("nonmembers and same-owner cross-brand resource IDs cannot access or mutate knowledge", () => {
      assert.deepEqual(outsiders.map(result => result.status), [404, 404, 404, 404, 404]);
      assert.equal(crossedRule.status, 404); assert.equal(crossedDelete.status, 404); assert.equal(crossedSnapshot.status, 404);
    });

    const anonymous = await call("anonymous", importPath);
    const anonymousWrite = await importDraft(input, "anonymous");
    const foreignOrigin = await call("owner", importPath, "POST", { ...input, mutationId: randomUUID() }, "https://foreign.invalid");
    const ownerSession = ok(await call("owner", `/api/workbench/session?workspaceId=${knowledgeWs}`));
    const mismatch = await call("owner", importPath, "POST", input, base, { "X-Novart-User": editor.userId });
    const matchingUser = await call("owner", importPath, "GET", undefined, base, { "X-Novart-User": ownerSession.user.id });
    const afterDeniedRules = ruleState(await readRules());
    const afterDeniedSnapshots = await prisma.ruleSnapshot.count({ where: { workspaceId: knowledgeWs } });
    const afterDeniedImports = await prisma.workbenchKnowledgeImport.count({ where: { workspaceId: knowledgeWs } });
    check("anonymous, cross-origin and switched-account imports fail without touching persisted data", () => {
      assert.equal(anonymous.status, 401); assert.equal(anonymousWrite.status, 401); assert.equal(foreignOrigin.status, 403);
      assert.equal(mismatch.status, 409); assert.equal(matchingUser.status, 200);
      assert.deepEqual(afterDeniedRules, priorRules); assert.equal(afterDeniedSnapshots, priorSnapshotCount); assert.equal(afterDeniedImports, priorImportCount);
    });

    shell = await readShell("editor");
    const revisedBrand = { ...shell.brand, colors: ["#001122", "#334455", "#667788"], font: "mono" as const, notes: "更新后的草稿保留原导入回执。" };
    ok(await call("editor", route("/studio/state"), "POST", { ...shell, group: "brand", brand: revisedBrand }));
    const updatedDraft = await readImport();
    const oldRetry = StudioBrandDraftImportResult.parse(ok(await importDraft(input)));
    const staleNewIntent = await importDraft({ mutationId: randomUUID(), expectedDraftRevision: draftRow.revision });
    const freshInput = { mutationId: randomUUID(), expectedDraftRevision: updatedDraft.draftRevision };
    const freshReceipt = StudioBrandDraftImportResult.parse(ok(await importDraft(freshInput, "editor")));
    const finalRules = await readRules("viewer");
    const finalDraft = await prisma.workbenchBrandDraft.findUniqueOrThrow({ where: { workspaceId: knowledgeWs } });
    const finalImports = await prisma.workbenchKnowledgeImport.findMany({ where: { workspaceId: knowledgeWs } });
    check("a later draft preserves old receipts, rejects stale new imports and creates only fresh draft rules", () => {
      assert.equal(updatedDraft.draftRevision, draftRow.revision + 1); assert.equal(oldRetry.replayed, true);
      assert.deepEqual(oldRetry.ruleIds, receipt.ruleIds); assert.equal(staleNewIntent.status, 409);
      assert.equal(freshReceipt.replayed, false); assert.equal(freshReceipt.draftRevision, finalDraft.revision); assert.equal(finalImports.length, 2);
      const freshRules = finalRules.filter(rule => freshReceipt.ruleIds.includes(rule.id));
      assert.equal(freshRules.length, 2); assert.equal(freshRules.every(rule => rule.status === "DRAFT"), true);
      assert.deepEqual(ruleState(confirmed(finalRules)), ruleState(confirmed(afterBackupRestore)));
      assert.deepEqual(finalDraft.colors, revisedBrand.colors); assert.equal(finalDraft.notes, revisedBrand.notes);
    });
  } finally {
    // Leave the other suites' active-brand cookie untouched. Disposable rows
    // remain available for evidence until the parent tears down its test DB.
    ok(await call("owner", "/api/workbench/session", "POST", { workspaceId: ws }));
  }
}
