import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { BrandDeletionInput } from "@brandai/contracts";
const f = vi.hoisted(() => ({ user: vi.fn(), remove: vi.fn(), preview: vi.fn(), cookie: vi.fn(), cookieGet: vi.fn() }));
function api() { return {
  ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } }, requireUser: f.user,
  parse: (schema: { parse: (value: unknown) => unknown }, value: unknown) => schema.parse(value),
  ok: (value: unknown, init?: ResponseInit) => Object.assign(Response.json(value, init), { cookies: { set: f.cookie } }),
  handleError: (error: any) => Response.json({ error: error.message }, { status: error.status ?? (error.issues ? 422 : 500) }),
}; }
vi.mock("@/lib/api", () => api()); vi.mock("../src/lib/api", () => api());
vi.mock("@/lib/brand-deletion", () => ({ deleteBrand: f.remove, previewBrandDeletion: f.preview }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: f.cookieGet }) }));
vi.mock("@/lib/workspace", () => ({ requireOwnedWorkspace: vi.fn(), requireWorkspaceRole: vi.fn() }));
import { DELETE } from "../src/app/api/workspaces/[wsId]/route";
import { GET } from "../src/app/api/workspaces/[wsId]/deletion/route";
const params = { params: Promise.resolve({ wsId: "w" }) };
const body = { confirmationName: "品牌", confirmationToken: "a".repeat(64), mutationId: "ad717f54-3ddd-4afd-8aca-392ab1624656" };
const result = { ok: true, deletedWorkspaceId: "w", nextWorkspaceId: "next", redirectTo: "/studio?workspaceId=next#/home" };
const request = (value: unknown = body, headers: Record<string, string> = {}) => new Request("https://studio.invalid/api/workspaces/w", {
  method: "DELETE", headers: { "content-type": "application/json", origin: "https://studio.invalid", "X-Novart-User": "owner", ...headers }, body: JSON.stringify(value),
});
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("AUTH_URL", "https://studio.invalid");
  f.user.mockResolvedValue({ id: "owner" }); f.cookieGet.mockReturnValue({ value: "current" });
  f.remove.mockImplementation(async (_workspace, _user, input) => { BrandDeletionInput.parse(input); return result; });
  f.preview.mockResolvedValue({ workspaceId: "w", name: "品牌" });
});
afterEach(() => vi.unstubAllEnvs());
describe("brand deletion HTTP boundary", () => {
  it("passes actor, confirmed input and active preference to the transaction, then sets authoritative cookie", async () => {
    const response = await DELETE(request(), params);
    expect(response.status).toBe(200); expect(await response.json()).toEqual(result);
    expect(f.remove).toHaveBeenCalledWith("w", "owner", body, "current");
    expect(f.cookie).toHaveBeenCalledWith("brandai-active-brand", "next", { path: "/", sameSite: "lax", secure: true, maxAge: 31536000 });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("clears a deleted last-brand cookie", async () => {
    f.remove.mockResolvedValue({ ...result, nextWorkspaceId: null, redirectTo: "/studio" });
    expect((await DELETE(request(), params)).status).toBe(200);
    expect(f.cookie).toHaveBeenCalledWith("brandai-active-brand", "", expect.objectContaining({ maxAge: 0 }));
  });
  it.each([401, 403])("preserves auth failure %i without deletion or cookie changes", async status => {
    f.user.mockRejectedValue(Object.assign(new Error("denied"), { status }));
    expect((await DELETE(request(), params)).status).toBe(status); expect(f.remove).not.toHaveBeenCalled(); expect(f.cookie).not.toHaveBeenCalled();
  });
  it("refuses cross-origin or changed-account deletes before the transaction", async () => {
    expect((await DELETE(request(body, { origin: "https://foreign.invalid" }), params)).status).toBe(403);
    expect((await DELETE(request(body, { "X-Novart-User": "other" }), params)).status).toBe(409);
    expect(f.remove).not.toHaveBeenCalled(); expect(f.cookie).not.toHaveBeenCalled();
  });
  it.each([[{}, {}, 422], [{ ...body, confirmationName: "x".repeat(5000) }, {}, 413], [body, { "content-type": "text/plain" }, 415]])("bounds and validates confirmation", async (value, headers, status) => {
    expect((await DELETE(request(value, headers as Record<string, string>), params)).status).toBe(status); expect(f.cookie).not.toHaveBeenCalled();
  });
  it.each([403, 404, 409, 500])("does not report success or write a cookie when the service fails (%i)", async status => {
    f.remove.mockRejectedValue(Object.assign(new Error("not deleted"), { status }));
    expect((await DELETE(request(), params)).status).toBe(status); expect(f.cookie).not.toHaveBeenCalled();
  });
  it("previews without deletion or cookie side effects and rejects a switched actor", async () => {
    const response = await GET(new Request("https://studio.invalid/api/workspaces/w/deletion"), params);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(f.preview).toHaveBeenCalledWith("w", "owner"); expect(f.remove).not.toHaveBeenCalled(); expect(f.cookie).not.toHaveBeenCalled();
    expect((await GET(new Request("https://studio.invalid/api/workspaces/w/deletion", { headers: { "X-Novart-User": "other" } }), params)).status).toBe(409);
  });
});
