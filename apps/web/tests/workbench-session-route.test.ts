import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ user: vi.fn(), session: vi.fn(), getCookie: vi.fn(), setCookie: vi.fn() }));
function api() { return {
  ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } },
  requireUser: f.user,
  handleError: (error: any) => Response.json({ error: error.message }, { status: error.status ?? (error.issues ? 422 : 500) }),
}; }
vi.mock("@/lib/api", () => api());
vi.mock("../src/lib/api", () => api());
vi.mock("../node_modules/next/headers.js", () => ({ cookies: async () => ({ get: f.getCookie, set: f.setCookie }) }));
vi.mock("@/lib/workbench-session", () => ({ getWorkbenchSession: f.session }));
vi.mock("@/lib/brand-cookie", () => ({ ACTIVE_BRAND_COOKIE: "brandai-active-brand", ACTIVE_BRAND_COOKIE_MAX_AGE: 31536000 }));
import { GET, POST } from "../src/app/api/workbench/session/route";

const base = "https://studio.invalid/api/workbench/session";
const post = (workspaceId = "member-brand", extra: Record<string, string> = {}) => new Request(base, { method: "POST",
  headers: { "content-type": "application/json", origin: "https://studio.invalid", "X-Novart-User": "current-user", ...extra }, body: JSON.stringify({ workspaceId }) });
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("AUTH_URL", "https://studio.invalid");
  f.user.mockResolvedValue({ id: "current-user", name: "当前用户" }); f.getCookie.mockReturnValue({ value: "cookie-brand" });
  f.session.mockResolvedValue({ user: { id: "current-user", name: "当前用户" }, workspaces: [{ id: "member-brand", name: "共享品牌", role: "EDITOR" }], activeWorkspaceId: "member-brand" });
});
afterEach(() => vi.unstubAllEnvs());

describe("workbench brand selection HTTP boundary", () => {
  it("selects only the authenticated member brand and writes the authoritative refresh cookie after validation", async () => {
    const response = await POST(post());
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    expect(await response.json()).toMatchObject({ activeWorkspaceId: "member-brand" });
    expect(f.session).toHaveBeenCalledWith({ id: "current-user", name: "当前用户" }, "member-brand", true);
    expect(f.setCookie).toHaveBeenCalledWith("brandai-active-brand", "member-brand", { path: "/", maxAge: 31536000, sameSite: "lax", secure: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("keeps an explicit URL authoritative over the existing brand cookie on refresh", async () => {
    expect((await GET(new Request(base + "?workspaceId=member-brand"))).status).toBe(200);
    expect(f.session).toHaveBeenCalledWith({ id: "current-user", name: "当前用户" }, "member-brand", true); expect(f.setCookie).not.toHaveBeenCalled();
  });
  it("treats a cookie preference as revalidated fallback rather than an explicit inaccessible deep link", async () => {
    expect((await GET(new Request(base))).status).toBe(200);
    expect(f.session).toHaveBeenCalledWith({ id: "current-user", name: "当前用户" }, "cookie-brand", false); expect(f.setCookie).not.toHaveBeenCalled();
  });
  it.each(["", "x".repeat(129)])("rejects invalid explicit workspace IDs instead of falling back", async id => {
    expect((await GET(new Request(base + "?workspaceId=" + id))).status).toBe(422); expect(f.session).not.toHaveBeenCalled();
  });
  it("rejects an inaccessible brand with no selection-cookie mutation", async () => {
    f.session.mockRejectedValue(Object.assign(new Error("Brand not found"), { status: 404 }));
    expect((await POST(post("foreign-brand"))).status).toBe(404); expect(f.setCookie).not.toHaveBeenCalled();
  });
  it("rejects stale-account and cross-origin mutations before reading a brand", async () => {
    expect((await POST(post("member-brand", { "X-Novart-User": "previous-user" }))).status).toBe(409);
    expect((await POST(post("member-brand", { origin: "https://foreign.invalid" }))).status).toBe(403);
    expect(f.session).not.toHaveBeenCalled(); expect(f.setCookie).not.toHaveBeenCalled();
  });
  it.each([401, 403])("keeps authentication failures (%i) ahead of brand selection", async status => {
    f.user.mockRejectedValue(Object.assign(new Error("denied"), { status }));
    expect((await POST(post())).status).toBe(status); expect(f.session).not.toHaveBeenCalled(); expect(f.setCookie).not.toHaveBeenCalled();
  });
});
