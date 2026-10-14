import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ user: vi.fn(), lock: vi.fn(), quota: vi.fn(), create: vi.fn(), member: vi.fn(), tx: vi.fn(), cookie: vi.fn(), receipt: vi.fn(), receiptCreate: vi.fn() }));
function api() { return {
  ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } },
  requireUser: f.user,
  parse: (schema: { parse: (value: unknown) => unknown }, value: unknown) => schema.parse(value),
  ok: (value: unknown, init?: ResponseInit) => Object.assign(Response.json(value, init), { cookies: { set: f.cookie } }),
  handleError: (error: any) => Response.json({ error: error.message }, { status: error.status ?? (error.issues ? 422 : 500) }),
}; }
vi.mock("@/lib/api", () => api());
vi.mock("../../../apps/web/src/lib/api", () => api());
vi.mock("../../db/src/index", () => ({ prisma: { $transaction: f.tx }, Prisma: { TransactionIsolationLevel: { ReadCommitted: "ReadCommitted" } } }));
vi.mock("@/lib/quota", () => ({ assertCanCreateWorkspace: f.quota }));
vi.mock("@/lib/brand-cookie", () => ({ ACTIVE_BRAND_COOKIE: "brandai-active-brand", ACTIVE_BRAND_COOKIE_MAX_AGE: 31536000 }));
vi.mock("@/lib/workbench-origin", async () => await import("../../../apps/web/src/lib/workbench-origin"));
vi.mock("@/lib/workbench-request", async () => await import("../../../apps/web/src/lib/workbench-request"));

import { POST } from "../../../apps/web/src/app/api/workspaces/route";

let tx: any;
const request = (body: unknown = { name: "第二个品牌" }, headers: Record<string, string> = {}) => new Request("https://studio.invalid/api/workspaces", {
  method: "POST", headers: { "content-type": "application/json", origin: "https://studio.invalid", "X-Novart-User": "owner", ...headers }, body: JSON.stringify(body),
});
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("AUTH_URL", "https://studio.invalid");
  f.user.mockResolvedValue({ id: "owner" }); f.lock.mockResolvedValue([{ id: "owner" }]);
  f.create.mockResolvedValue({ id: "new-workspace", ownerId: "owner", name: "第二个品牌" });
  f.receipt.mockResolvedValue(null);
  tx = { $queryRaw: f.lock, brandWorkspace: { create: f.create }, membership: { create: f.member }, studioBrandCreation: { findUnique: f.receipt, create: f.receiptCreate } };
  f.tx.mockImplementation(fn => fn(tx));
});
afterEach(() => vi.unstubAllEnvs());

describe("brand creation HTTP boundary (unit DB fixtures)", () => {
  it("retains the legacy 201 workspace format and commits owner membership with the quota check in one transaction", async () => {
    const response = await POST(request({ name: "  第二个品牌  ", ownerId: "foreign-owner", workspaceId: "foreign-workspace" }));
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(201);
    expect(await response.json()).toMatchObject({ id: "new-workspace", ownerId: "owner" });
    expect(f.lock.mock.calls[0][0].join("")).toContain("FOR UPDATE"); expect(f.lock.mock.calls[0].slice(1)).toEqual(["owner"]);
    expect(f.quota).toHaveBeenCalledWith("owner", tx);
    expect(f.create).toHaveBeenCalledWith({ data: { ownerId: "owner", name: "第二个品牌", industry: undefined, websiteUrl: undefined } });
    expect(f.member).toHaveBeenCalledWith({ data: { userId: "owner", workspaceId: "new-workspace", role: "OWNER" } });
    expect(f.tx).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "ReadCommitted", timeout: 5000 });
    expect(f.cookie).toHaveBeenCalledWith("brandai-active-brand", "new-workspace", { path: "/", maxAge: 31536000, sameSite: "lax", secure: true });
    expect(f.lock.mock.invocationCallOrder[0]).toBeLessThan(f.quota.mock.invocationCallOrder[0]);
    expect(f.quota.mock.invocationCallOrder[0]).toBeLessThan(f.create.mock.invocationCallOrder[0]);
    expect(f.member.mock.invocationCallOrder[0]).toBeLessThan(f.cookie.mock.invocationCallOrder[0]);
    expect(f.receipt).not.toHaveBeenCalled(); expect(f.receiptCreate).not.toHaveBeenCalled();
  });
  it("allows the configured public CDS origin even when the internal URL and Host are rewritten", async () => {
    const req = new Request("http://127.0.0.1:15441/api/workspaces", { method: "POST", headers: { "content-type": "application/json", host: "127.0.0.1:15441", origin: "https://studio.invalid" }, body: JSON.stringify({ name: "CDS 品牌" }) });
    expect((await POST(req)).status).toBe(201);
  });
  it.each([401, 403])("preserves authentication/account disabled failures (%i) before any write", async status => {
    f.user.mockRejectedValue(Object.assign(new Error("denied"), { status }));
    expect((await POST(request())).status).toBe(status); expect(f.tx).not.toHaveBeenCalled(); expect(f.cookie).not.toHaveBeenCalled();
  });
  it("rejects a switched account before its brand is created", async () => {
    expect((await POST(request(undefined, { "X-Novart-User": "previous-account" }))).status).toBe(409);
    expect(f.tx).not.toHaveBeenCalled(); expect(f.cookie).not.toHaveBeenCalled();
  });
  it("rejects cross-origin creation before entering a database transaction", async () => {
    expect((await POST(request(undefined, { origin: "https://foreign.invalid" }))).status).toBe(403);
    expect(f.tx).not.toHaveBeenCalled(); expect(f.cookie).not.toHaveBeenCalled();
  });
  it.each([
    [{ name: " " }, {}, 422],
    [{ name: "x".repeat(5000) }, {}, 413],
    [{ name: "brand" }, { "content-type": "text/plain" }, 415],
    [{ name: "brand", websiteUrl: "not-a-url" }, {}, 422],
  ])("rejects blank, oversized, wrong-type and malformed input without writes", async (body, headers, status) => {
    expect((await POST(request(body, headers))).status).toBe(status); expect(f.tx).not.toHaveBeenCalled(); expect(f.cookie).not.toHaveBeenCalled();
  });
  it("honors a plan refusal without creating a workspace or selecting it", async () => {
    f.quota.mockRejectedValue(Object.assign(new Error("brand quota reached"), { status: 402 }));
    expect((await POST(request())).status).toBe(402); expect(f.create).not.toHaveBeenCalled(); expect(f.member).not.toHaveBeenCalled(); expect(f.cookie).not.toHaveBeenCalled();
  });
  it("revalidates an active owner under the lock and rejects one disabled during creation", async () => {
    f.lock.mockResolvedValue([]);
    expect((await POST(request())).status).toBe(403); expect(f.quota).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled(); expect(f.cookie).not.toHaveBeenCalled();
  });
  it("does not publish a cookie or report success if membership fails inside the transaction", async () => {
    f.member.mockRejectedValue(new Error("membership write failed"));
    expect((await POST(request())).status).toBe(500); expect(f.cookie).not.toHaveBeenCalled();
  });

  it("replays one acknowledged create intent without another quota check, brand or member insert", async () => {
    const mutation = "AD717F54-3DDD-4AFD-8ACA-392AB1624656", headers = { "X-Novart-Mutation": mutation };
    const first = await POST(request({ name: "  第二个品牌  " }, headers));
    expect(first.status).toBe(201);
    const stored = f.receiptCreate.mock.calls[0][0].data;
    expect(stored).toMatchObject({ userId: "owner", mutationId: mutation.toLowerCase(), workspaceId: "new-workspace" });
    expect(stored.inputDigest).toMatch(/^[0-9a-f]{64}$/);
    f.receipt.mockResolvedValue({ ...stored, workspace: await first.clone().json() });
    const replay = await POST(request({ name: "第二个品牌" }, headers));
    expect(replay.status).toBe(201); expect(await replay.json()).toEqual(await first.json());
    expect(f.quota).toHaveBeenCalledTimes(1); expect(f.create).toHaveBeenCalledTimes(1); expect(f.member).toHaveBeenCalledTimes(1);
    expect(f.receiptCreate).toHaveBeenCalledTimes(1); expect(f.cookie).toHaveBeenCalledTimes(2);
    expect(f.receipt).toHaveBeenLastCalledWith({ where: { userId_mutationId: { userId: "owner", mutationId: mutation.toLowerCase() } }, include: { workspace: true } });
    expect(f.member.mock.invocationCallOrder[0]).toBeLessThan(f.receiptCreate.mock.invocationCallOrder[0]);
    expect(f.receiptCreate.mock.invocationCallOrder[0]).toBeLessThan(f.cookie.mock.invocationCallOrder[0]);
  });
  it.each(["name", "industry", "websiteUrl"])("rejects changing %s under the same create intent", async field => {
    const headers = { "X-Novart-Mutation": "ad717f54-3ddd-4afd-8aca-392ab1624656" };
    const first = await POST(request({ name: "第二个品牌" }, headers));
    f.receipt.mockResolvedValue({ ...f.receiptCreate.mock.calls[0][0].data, workspace: await first.json() });
    const value = field === "websiteUrl" ? "https://example.invalid" : "不同内容";
    expect((await POST(request({ name: "第二个品牌", [field]: value }, headers))).status).toBe(409);
    expect(f.create).toHaveBeenCalledTimes(1); expect(f.member).toHaveBeenCalledTimes(1); expect(f.quota).toHaveBeenCalledTimes(1); expect(f.cookie).toHaveBeenCalledTimes(1);
  });
  it("preserves a deleted-brand receipt and refuses to resurrect it on replay", async () => {
    const headers = { "X-Novart-Mutation": "ad717f54-3ddd-4afd-8aca-392ab1624656" };
    expect((await POST(request(undefined, headers))).status).toBe(201);
    f.receipt.mockResolvedValue({ ...f.receiptCreate.mock.calls[0][0].data, workspaceId: null, workspace: null });
    expect((await POST(request(undefined, headers))).status).toBe(410);
    expect(f.create).toHaveBeenCalledTimes(1); expect(f.member).toHaveBeenCalledTimes(1); expect(f.cookie).toHaveBeenCalledTimes(1);
  });
  it("keeps equal brand names as distinct intents instead of deduplicating by name", async () => {
    f.create.mockResolvedValueOnce({ id: "first-brand", ownerId: "owner", name: "第二个品牌" });
    f.create.mockResolvedValueOnce({ id: "second-brand", ownerId: "owner", name: "第二个品牌" });
    const first = await POST(request(undefined, { "X-Novart-Mutation": "ad717f54-3ddd-4afd-8aca-392ab1624656" }));
    const second = await POST(request(undefined, { "X-Novart-Mutation": "cf3b9068-d35d-436c-8f01-81a1c2b726f4" }));
    expect(first.status).toBe(201); expect(second.status).toBe(201);
    expect((await first.json()).id).not.toBe((await second.json()).id);
    expect(f.create).toHaveBeenCalledTimes(2); expect(f.member).toHaveBeenCalledTimes(2); expect(f.receiptCreate).toHaveBeenCalledTimes(2);
  });
  it("does not return a replayed brand whose ownership has changed", async () => {
    const headers = { "X-Novart-Mutation": "ad717f54-3ddd-4afd-8aca-392ab1624656" };
    expect((await POST(request(undefined, headers))).status).toBe(201);
    f.receipt.mockResolvedValue({ ...f.receiptCreate.mock.calls[0][0].data, workspace: { id: "new-workspace", ownerId: "foreign-owner", name: "第二个品牌" } });
    expect((await POST(request(undefined, headers))).status).toBe(404); expect(f.cookie).toHaveBeenCalledTimes(1);
  });
  it.each(["", "not-a-uuid", "ad717f54-3ddd-0afd-8aca-392ab1624656"])("rejects an invalid create intent before any transaction: %s", async mutation => {
    expect((await POST(request(undefined, { "X-Novart-Mutation": mutation }))).status).toBe(400);
    expect(f.tx).not.toHaveBeenCalled(); expect(f.cookie).not.toHaveBeenCalled();
  });
  it("reports no success when the durable receipt cannot commit with its brand", async () => {
    f.receiptCreate.mockRejectedValue(new Error("receipt write failed"));
    expect((await POST(request(undefined, { "X-Novart-Mutation": "ad717f54-3ddd-4afd-8aca-392ab1624656" }))).status).toBe(500);
    expect(f.cookie).not.toHaveBeenCalled();
  });
});
