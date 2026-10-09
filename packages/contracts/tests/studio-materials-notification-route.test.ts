import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ user: vi.fn(), member: vi.fn(), list: vi.fn() }));
vi.mock("@/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } }, requireUser: f.user,
  ok: (data: unknown) => Response.json(data), handleError: (error: { status?: number }) => Response.json({}, { status: error.status ?? 500 }) }));
vi.mock("@/lib/workspace", () => ({ requireOwnedWorkspace: f.member }));
vi.mock("@/lib/notifications", () => ({ listWorkspaceNotifications: f.list }));
import { GET } from "../../../apps/web/src/app/api/workspaces/[wsId]/notifications/route";
const params = { params: Promise.resolve({ wsId: "w" }) };
beforeEach(() => { vi.resetAllMocks(); f.user.mockResolvedValue({ id: "u" }); f.member.mockResolvedValue({ id: "w" }); f.list.mockResolvedValue([]); });
describe("upload notification session isolation", () => {
  it("forwards only server identity after membership validation", async () => {
    expect((await GET(new Request("http://127.0.0.1/notifications"), params)).status).toBe(200);
    expect(f.member).toHaveBeenCalledWith("w", "u"); expect(f.list).toHaveBeenCalledWith("w", 30, "u", "all");
  });
  it("rejects an old account's notification component after session switching", async () => {
    const request = new Request("http://127.0.0.1/notifications", { headers: { "X-Novart-User": "old-account" } });
    expect((await GET(request, params)).status).toBe(409); expect(f.member).not.toHaveBeenCalled(); expect(f.list).not.toHaveBeenCalled();
  });
  it("does not query notifications outside the user's workspace", async () => {
    f.member.mockRejectedValue({ status: 404 }); expect((await GET(new Request("http://127.0.0.1/notifications"), params)).status).toBe(404); expect(f.list).not.toHaveBeenCalled();
  });
  it("allows only the explicit product scope and rejects unknown scopes", async () => {
    expect((await GET(new Request("http://127.0.0.1/notifications?scope=studio"), params)).status).toBe(200);
    expect(f.list).toHaveBeenCalledWith("w", 30, "u", "studio");
    f.list.mockClear();
    expect((await GET(new Request("http://127.0.0.1/notifications?scope=everyone"), params)).status).toBe(422);
    expect(f.list).not.toHaveBeenCalled();
  });
});
