import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ count: vi.fn(), find: vi.fn(), create: vi.fn(), tx: vi.fn(), txCount: vi.fn(), promote: vi.fn(), hash: vi.fn(), open: vi.fn() }));
vi.mock("../../../packages/db/src/index", () => ({ prisma: { user: { count: f.count, findUnique: f.find, create: f.create }, $transaction: f.tx }, Prisma: { TransactionIsolationLevel: { Serializable: "Serializable" }, PrismaClientKnownRequestError: class extends Error {} } }));
vi.mock("@/lib/api", () => ({
  ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } },
  parse: (schema: { parse(value: unknown): unknown }, value: unknown) => schema.parse(value),
  ok: (value: unknown, init?: ResponseInit) => Response.json(value, init),
  handleError: (error: any) => Response.json({ error: error.message }, { status: error.status ?? (error.issues ? 422 : 500) }),
}));
vi.mock("@/lib/admin", async () => await import("../src/lib/admin"));
vi.mock("@/lib/password", () => ({ hashPassword: f.hash }));
vi.mock("@/lib/settings", () => ({ isRegistrationOpen: f.open }));
import { POST } from "../src/app/api/auth/register/route";
import { isAdminUser } from "../src/lib/admin";

const email = "synthetic-user@example.invalid";
const request = (body: unknown = { email, password: "synthetic-local-password" }) => new Request("http://127.0.0.1/api/auth/register", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("ADMIN_EMAILS", "");
  f.count.mockResolvedValue(0); f.find.mockResolvedValue(null); f.open.mockResolvedValue(false);
  f.hash.mockResolvedValue("synthetic-hash");
  f.create.mockResolvedValue({ id: "synthetic-user", email, isAdmin: false });
  f.txCount.mockResolvedValue(0);
  f.tx.mockImplementation(fn => fn({ user: { count: f.txCount, update: f.promote } }));
});
afterEach(() => vi.unstubAllEnvs());

describe("registration administrator boundary (unit DB fixtures)", () => {
  it.each(["", " , \t "])("rejects the first public signup in closed production with no configured admin: %s", async allow => {
    vi.stubEnv("ADMIN_EMAILS", allow);
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "注册暂未开放,请联系管理员" });
    expect(f.count).not.toHaveBeenCalled(); expect(f.find).not.toHaveBeenCalled();
    expect(f.hash).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled(); expect(f.tx).not.toHaveBeenCalled();
  });
  it("allows open production signup without promoting the first registrant", async () => {
    f.open.mockResolvedValue(true);
    const response = await POST(request());
    expect(response.status).toBe(201); expect(await response.json()).toEqual({ id: "synthetic-user", email });
    expect(f.create.mock.calls[0][0].data).not.toHaveProperty("isAdmin");
    expect(f.count).not.toHaveBeenCalled(); expect(f.tx).not.toHaveBeenCalled(); expect(f.promote).not.toHaveBeenCalled();
  });
  it("preserves explicit normalized ADMIN_EMAILS membership in closed production", async () => {
    vi.stubEnv("ADMIN_EMAILS", `  ${email.toUpperCase()}  , second@example.invalid`);
    expect((await POST(request())).status).toBe(201);
    expect(f.open).not.toHaveBeenCalled(); expect(f.tx).not.toHaveBeenCalled();
    expect(await isAdminUser("synthetic-user", email)).toBe(true);
    expect(await isAdminUser("unrelated-user", "unrelated@example.invalid")).toBe(false);
  });
  it("still rejects an unlisted registrant when an admin allowlist exists", async () => {
    vi.stubEnv("ADMIN_EMAILS", "operator@example.invalid");
    expect((await POST(request())).status).toBe(403); expect(f.create).not.toHaveBeenCalled();
  });
  it("preserves an explicitly provisioned User.isAdmin without an allowlist", async () => {
    f.find.mockResolvedValue({ isAdmin: true });
    expect(await isAdminUser("provisioned-admin", "operator@example.invalid")).toBe(true);
  });
  it.each(["development", "test"])("retains serializable first-admin bootstrap in %s", async environment => {
    vi.stubEnv("NODE_ENV", environment);
    expect((await POST(request())).status).toBe(201);
    expect(f.open).not.toHaveBeenCalled();
    expect(f.tx).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
    expect(f.promote).toHaveBeenCalledWith({ where: { id: "synthetic-user" }, data: { isAdmin: true } });
  });
  it("does not promote another local registrant when a concurrent bootstrap already won", async () => {
    vi.stubEnv("NODE_ENV", "development"); f.txCount.mockResolvedValue(1);
    expect((await POST(request())).status).toBe(201); expect(f.promote).not.toHaveBeenCalled();
  });
  it("does not reopen closed local registration after an administrator exists", async () => {
    vi.stubEnv("NODE_ENV", "development"); f.count.mockResolvedValue(1);
    expect((await POST(request())).status).toBe(403); expect(f.create).not.toHaveBeenCalled();
  });
  it("keeps duplicate and invalid signup responses and prevents account takeover", async () => {
    f.open.mockResolvedValue(true); f.find.mockResolvedValue({ id: "existing-oauth-user", passwordHash: null });
    expect((await POST(request())).status).toBe(409);
    expect((await POST(request({ email, password: "short" }))).status).toBe(422);
    expect(f.hash).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled();
  });
});
