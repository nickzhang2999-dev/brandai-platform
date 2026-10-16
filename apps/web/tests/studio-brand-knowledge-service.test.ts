import { beforeEach, describe, expect, it, vi } from "vitest";
import { StudioBrandDraftImportInput, StudioBrandDraftImportResult } from "../../../packages/contracts/src/studio-brand-knowledge";
const f = vi.hoisted(() => ({ gate: vi.fn(), lock: vi.fn(), draft: vi.fn(), workspace: vi.fn(), receipt: vi.fn(), saveReceipt: vi.fn(), rule: vi.fn(), transaction: vi.fn() }));
vi.mock("../../../packages/db/src/index", () => ({ prisma: { $transaction: f.transaction, workbenchBrandDraft: { findUnique: f.draft } }, Prisma: { TransactionIsolationLevel: { ReadCommitted: "ReadCommitted" } } }));
vi.mock("../src/lib/workspace", () => ({ requireWorkspaceRole: f.gate }));
vi.mock("../src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
import { importStudioBrandDraft, readStudioBrandDraftImport } from "../src/lib/studio-brand-knowledge";
const input = { mutationId: "71ae8509-1766-4730-a660-c7d927f173a6", expectedDraftRevision: 4 };
let receipts: any[];
beforeEach(() => {
  vi.resetAllMocks(); receipts = [];
  f.gate.mockResolvedValue({ role: "EDITOR" }); f.lock.mockResolvedValue([{ id: "w" }]);
  f.draft.mockResolvedValue({ workspaceId: "w", revision: 4, colors: ["#123456", "#ABCDEF", "#112233"], font: "serif", notes: "备注不是自动确认规则\n保留原文" });
  f.workspace.mockResolvedValue({ name: "品牌甲" });
  f.receipt.mockImplementation(({ where }) => receipts.find(r => Object.entries(where.workspaceId_userId_mutationId).every(([k, v]) => r[k] === v)) ?? null);
  f.saveReceipt.mockImplementation(({ data }) => { receipts.push(structuredClone(data)); return data; });
  f.rule.mockImplementation(({ data }) => ({ ...data, id: `rule-${f.rule.mock.calls.length}` }));
  const tx = { $queryRaw: f.lock, workbenchBrandDraft: { findUnique: f.draft }, brandWorkspace: { findUnique: f.workspace },
    workbenchKnowledgeImport: { findUnique: f.receipt, create: f.saveReceipt }, brandRule: { create: f.rule } };
  f.transaction.mockImplementation(fn => fn(tx));
});

describe("Studio saved brand draft import", () => {
  it("reports the brand draft's own revision and never writes on GET", async () => {
    expect(await readStudioBrandDraftImport("w", "u")).toEqual({ available: true, draftRevision: 4, importableTypes: ["color", "font"], hasNotes: true });
    expect(f.gate).toHaveBeenCalledWith("w", "u", "VIEWER"); expect(f.transaction).not.toHaveBeenCalled();
    f.draft.mockResolvedValue(null);
    expect(await readStudioBrandDraftImport("w", "u")).toEqual({ available: false, draftRevision: 0, importableTypes: [], hasNotes: false });
  });
  it("creates only two DRAFT candidates from stored data, with notes preserved in an independent receipt", async () => {
    const result = await importStudioBrandDraft("w", "u", input);
    expect(StudioBrandDraftImportResult.parse(result)).toEqual({ mutationId: input.mutationId, draftRevision: 4, ruleIds: ["rule-1", "rule-2"], created: 2, replayed: false, notesPreserved: true });
    expect(f.gate).toHaveBeenCalledWith("w", "u", "EDITOR"); expect(f.lock).toHaveBeenCalledTimes(1);
    expect(f.rule.mock.calls.map(c => c[0].data.status)).toEqual(["DRAFT", "DRAFT"]);
    expect(f.rule.mock.calls.map(c => c[0].data.type)).toEqual(["color", "font"]);
    expect(f.rule.mock.calls[0]![0].data.structured.palette).toEqual([{ hex: "#123456" }, { hex: "#ABCDEF" }, { hex: "#112233" }]);
    expect(f.rule.mock.calls[1]![0].data.structured).toEqual({ module: "font", fallback_fonts: ["serif"], license_status: "UNKNOWN" });
    expect(receipts[0].source.notes).toBe("备注不是自动确认规则\n保留原文"); expect(receipts[0].ruleCount).toBe(2);
  });
  it("replays the original receipt after draft changes or imported rules are deleted, without recreating rules", async () => {
    const first = await importStudioBrandDraft("w", "u", input); f.draft.mockResolvedValue(null);
    const replay = await importStudioBrandDraft("w", "u", input);
    expect(replay).toEqual({ ...first, replayed: true }); expect(f.rule).toHaveBeenCalledTimes(2); expect(f.saveReceipt).toHaveBeenCalledTimes(1);
  });
  it("keeps the same mutation scoped to the submitting member", async () => {
    await importStudioBrandDraft("w", "u", input); await importStudioBrandDraft("w", "v", input);
    expect(receipts.map(r => r.userId)).toEqual(["u", "v"]); expect(f.rule).toHaveBeenCalledTimes(4);
  });
  it("rejects a reused mutation with a different expected revision", async () => {
    await importStudioBrandDraft("w", "u", input);
    await expect(importStudioBrandDraft("w", "u", { ...input, expectedDraftRevision: 5 })).rejects.toMatchObject({ status: 409 });
    expect(f.rule).toHaveBeenCalledTimes(2);
  });
  it("rejects stale revision without changing current knowledge", async () => {
    await expect(importStudioBrandDraft("w", "u", { ...input, expectedDraftRevision: 3 })).rejects.toMatchObject({ status: 409 });
    expect(f.rule).not.toHaveBeenCalled(); expect(f.saveReceipt).not.toHaveBeenCalled();
  });
  it("does not replace a malformed saved draft with defaults", async () => {
    f.draft.mockResolvedValue({ revision: 4, colors: ["invalid"], font: "serif", notes: "original" });
    await expect(importStudioBrandDraft("w", "u", input)).rejects.toMatchObject({ status: 422 }); expect(f.rule).not.toHaveBeenCalled();
  });
  it("returns missing draft explicitly", async () => {
    f.draft.mockResolvedValue(null); await expect(importStudioBrandDraft("w", "u", input)).rejects.toMatchObject({ status: 404 }); expect(f.rule).not.toHaveBeenCalled();
  });
  it.each([403, 404])("denies unauthorized role or workspace before transaction (%i)", async status => {
    f.gate.mockRejectedValue(Object.assign(new Error("denied"), { status }));
    await expect(importStudioBrandDraft("foreign", "u", input)).rejects.toMatchObject({ status }); expect(f.transaction).not.toHaveBeenCalled();
  });
  it("uses the workspace lock before reading idempotency or draft state", async () => {
    await importStudioBrandDraft("w", "u", input);
    expect(f.lock.mock.invocationCallOrder[0]).toBeLessThan(f.receipt.mock.invocationCallOrder[0]!);
    expect(f.receipt.mock.invocationCallOrder[0]).toBeLessThan(f.draft.mock.invocationCallOrder[0]!);
    expect(f.saveReceipt.mock.invocationCallOrder[0]).toBeGreaterThan(f.rule.mock.invocationCallOrder[1]!);
  });
  it("rejects client supplied replacement brand content and invalid revision", async () => {
    expect(StudioBrandDraftImportInput.safeParse({ ...input, colors: ["#ffffff"] }).success).toBe(false);
    expect(StudioBrandDraftImportInput.safeParse({ ...input, expectedDraftRevision: 0 }).success).toBe(false);
    await expect(importStudioBrandDraft("w", "u", { ...input, userId: "other" })).rejects.toThrow(); expect(f.transaction).not.toHaveBeenCalled();
  });
  it("rejects an inconsistent persisted receipt instead of inventing a success", async () => {
    await importStudioBrandDraft("w", "u", input); receipts[0].receipt.ruleIds = [];
    await expect(importStudioBrandDraft("w", "u", input)).rejects.toMatchObject({ status: 409 }); expect(f.rule).toHaveBeenCalledTimes(2);
  });
});
