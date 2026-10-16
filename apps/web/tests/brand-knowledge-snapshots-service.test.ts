import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ transaction: vi.fn(), lock: vi.fn(), snapshot: vi.fn(), create: vi.fn(), rules: vi.fn(), readRules: vi.fn(), retire: vi.fn(), upsert: vi.fn(), assets: vi.fn() }));
vi.mock("../../../packages/db/src/index", () => ({ prisma: { $transaction: f.transaction }, Prisma: { DbNull: "db-null" } }));
vi.mock("@/lib/rules", () => ({ getConfirmedRules: f.readRules }));
vi.mock("../src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
import { createRuleSnapshot, restoreRuleSnapshot } from "../src/lib/rule-snapshots";
const rule = { id: "r", workspaceId: "w", type: "color", strength: "WEAK", status: "CONFIRMED", value: {}, summary: "blue", evidence: [], createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
let snapshot: any; let tx: any;
beforeEach(() => {
  vi.resetAllMocks(); snapshot = { id: "s", workspaceId: "w", rules: [rule], ruleCount: 1 };
  f.lock.mockResolvedValue([{ id: "w" }]); f.snapshot.mockImplementation(() => snapshot);
  f.readRules.mockResolvedValue([rule]); f.rules.mockResolvedValue([]); f.assets.mockResolvedValue([]);
  f.create.mockImplementation(({ data }) => ({ ...data, id: "backup", note: null, createdById: null, createdAt: new Date(0) }));
  tx = { $queryRaw: f.lock, ruleSnapshot: { findUnique: f.snapshot, create: f.create }, asset: { findMany: f.assets }, brandRule: { findMany: f.rules, updateMany: f.retire, upsert: f.upsert } };
  f.transaction.mockImplementation(fn => fn(tx));
});
describe("atomic brand rule snapshot restore", () => {
  it("captures the locked transaction's confirmed rules without changing default ordering", async () => {
    expect((await createRuleSnapshot("w", { label: "v1" }, "u")).ruleCount).toBe(1);
    expect(f.readRules).toHaveBeenCalledWith("w", { client: tx }); expect(f.lock.mock.invocationCallOrder[0]).toBeLessThan(f.readRules.mock.invocationCallOrder[0]!);
  });
  it("backs up and restores within the same transaction after ownership checks", async () => {
    expect(await restoreRuleSnapshot("w", "s", "u")).toEqual({ restored: 1, retired: 0, backupSnapshotId: "backup" });
    expect(f.transaction).toHaveBeenCalledTimes(1); expect(f.create.mock.invocationCallOrder[0]).toBeLessThan(f.upsert.mock.invocationCallOrder[0]!);
    expect(f.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "r" }, create: expect.objectContaining({ workspaceId: "w", status: "CONFIRMED" }) }));
  });
  it("never interprets corrupt snapshot JSON as an empty library", async () => {
    snapshot.rules = { broken: true };
    await expect(restoreRuleSnapshot("w", "s", "u")).rejects.toThrow("SNAPSHOT_INVALID"); expect(f.create).not.toHaveBeenCalled(); expect(f.retire).not.toHaveBeenCalled();
  });
  it.each(["foreignSnapshot", "foreignRule", "foreignExistingId", "duplicateId", "countMismatch"])("rejects scope/integrity defect %s before any backup or mutation", async failure => {
    if (failure === "foreignSnapshot") snapshot.workspaceId = "foreign";
    if (failure === "foreignRule") snapshot.rules = [{ ...rule, workspaceId: "foreign" }];
    if (failure === "foreignExistingId") f.rules.mockResolvedValue([{ id: "r", workspaceId: "foreign" }]);
    if (failure === "duplicateId") { snapshot.rules = [rule, rule]; snapshot.ruleCount = 2; }
    if (failure === "countMismatch") snapshot.ruleCount = 2;
    await expect(restoreRuleSnapshot("w", "s", "u")).rejects.toThrow(); expect(f.create).not.toHaveBeenCalled(); expect(f.upsert).not.toHaveBeenCalled();
  });
  it("rejects foreign evidence even when the serialized rule workspace is correct", async () => {
    snapshot.rules = [{ ...rule, evidence: [{ assetId: "foreign", note: "evidence" }] }];
    await expect(restoreRuleSnapshot("w", "s", "u")).rejects.toThrow(); expect(f.create).not.toHaveBeenCalled();
  });
});
