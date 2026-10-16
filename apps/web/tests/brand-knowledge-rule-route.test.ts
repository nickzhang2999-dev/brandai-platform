import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  user: vi.fn(), role: vi.fn(), load: vi.fn(), current: vi.fn(), lock: vi.fn(),
  assets: vi.fn(), retire: vi.fn(), update: vi.fn(), remove: vi.fn(), transaction: vi.fn(),
}));
vi.mock("../../../packages/db/src/index", () => ({ prisma: { brandRule: { findUnique: f.load }, $transaction: f.transaction }, Prisma: {} }));
vi.mock("@/lib/api", () => ({
  ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } },
  requireUser: f.user, parse: (schema: any, input: unknown) => schema.parse(input),
  ok: (value: unknown) => Response.json(value), handleError: (error: any) => Response.json({ error: error.message }, { status: error.status ?? 400 }),
}));
vi.mock("@/lib/workspace", () => ({ requireWorkspaceRole: f.role }));
vi.mock("@/lib/rules", () => ({ serializeRule: (rule: unknown) => rule }));
import { PATCH, DELETE } from "../src/app/api/workspaces/[wsId]/rules/[ruleId]/route";

const params = { params: Promise.resolve({ wsId: "w", ruleId: "r" }) };
const request = (body: unknown) => new Request("https://app.invalid/api/workspaces/w/rules/r", {
  method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const base = { id: "r", workspaceId: "w", type: "logo", status: "DRAFT", evidence: [], structured: null };
beforeEach(() => {
  vi.resetAllMocks(); f.user.mockResolvedValue({ id: "u" }); f.role.mockResolvedValue({ role: "EDITOR" });
  f.load.mockResolvedValue(base); f.current.mockResolvedValue(base); f.lock.mockResolvedValue([{ id: "w" }]);
  f.assets.mockResolvedValue([]); f.update.mockImplementation(({ data }) => ({ ...base, ...data }));
  f.transaction.mockImplementation(fn => fn({ $queryRaw: f.lock, asset: { findMany: f.assets },
    brandRule: { findFirst: f.current, updateMany: f.retire, update: f.update, delete: f.remove } }));
});

describe("knowledge rule mutation boundary", () => {
  it("confirms under the shared workspace lock and retires only same-workspace/type peers", async () => {
    expect((await PATCH(request({ status: "CONFIRMED" }), params)).status).toBe(200);
    expect(f.role).toHaveBeenCalledWith("w", "u", "EDITOR");
    expect(f.current).toHaveBeenCalledWith({ where: { id: "r", workspaceId: "w" } });
    expect(f.lock.mock.invocationCallOrder[0]).toBeLessThan(f.current.mock.invocationCallOrder[0]!);
    expect(f.retire).toHaveBeenCalledWith({ where: { workspaceId: "w", type: "logo", status: "CONFIRMED", NOT: { id: "r" } }, data: { status: "REJECTED" } });
    expect(f.retire.mock.invocationCallOrder[0]).toBeLessThan(f.update.mock.invocationCallOrder[0]!);
  });
  it.each([403, 404])("keeps unauthorized/foreign workspace denial before a write (%i)", async status => {
    f.role.mockRejectedValue(Object.assign(new Error("denied"), { status }));
    expect((await PATCH(request({ status: "CONFIRMED" }), params)).status).toBe(status);
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it("rejects a foreign rule ID independently of workspace membership", async () => {
    f.load.mockResolvedValue({ ...base, workspaceId: "other" });
    expect((await PATCH(request({ status: "CONFIRMED" }), params)).status).toBe(404);
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it("does not publish a rule referencing a foreign asset or retire valid peers", async () => {
    f.current.mockResolvedValue({ ...base, evidence: [{ assetId: "foreign" }] });
    expect((await PATCH(request({ status: "CONFIRMED" }), params)).status).toBe(400);
    expect(f.retire).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled();
  });
  it("still allows rejecting a legacy rule whose old evidence was removed", async () => {
    f.current.mockResolvedValue({ ...base, status: "CONFIRMED", evidence: [{ assetId: "deleted" }] });
    expect((await PATCH(request({ status: "REJECTED" }), params)).status).toBe(200);
    expect(f.assets).not.toHaveBeenCalled(); expect(f.update).toHaveBeenCalledWith({ where: { id: "r" }, data: { status: "REJECTED" } });
  });
  it("validates newly edited structured asset references even while a rule remains draft", async () => {
    expect((await PATCH(request({ structured: { primary_logo_asset_id: "foreign" } }), params)).status).toBe(400);
    expect(f.assets).toHaveBeenCalledWith({ where: { workspaceId: "w", id: { in: ["foreign"] } }, select: { id: true } });
    expect(f.update).not.toHaveBeenCalled();
  });
  it("keeps ordinary deletion physical and scoped, without import-specific soft deletion", async () => {
    expect((await DELETE(new Request("https://app.invalid/api/workspaces/w/rules/r", { method: "DELETE" }), params)).status).toBe(200);
    expect(f.lock.mock.invocationCallOrder[0]).toBeLessThan(f.current.mock.invocationCallOrder[0]!);
    expect(f.remove).toHaveBeenCalledWith({ where: { id: "r" } }); expect(f.update).not.toHaveBeenCalled();
  });
  it("does not mutate a rule that disappears before the lock is acquired", async () => {
    f.current.mockResolvedValue(null);
    expect((await PATCH(request({ status: "CONFIRMED" }), params)).status).toBe(404);
    expect(f.retire).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled();
  });
});
