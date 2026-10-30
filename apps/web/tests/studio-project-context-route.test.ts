import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ user: vi.fn(), origin: vi.fn(), body: vi.fn(), read: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/api", () => ({ requireUser: f.user, ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("@/lib/workbench-origin", () => ({ isWorkbenchSameOrigin: f.origin }));
vi.mock("@/lib/workbench-request", () => ({ readWorkbenchJson: f.body }));
vi.mock("@/lib/studio-project-context", () => ({ readStudioProjectContext: f.read, saveStudioProjectContext: f.save }));
import { GET, PUT } from "../src/app/api/workspaces/[wsId]/projects/[projectId]/studio-project-context/route";
import { ApiException } from "@/lib/api";
const context = { params: Promise.resolve({ wsId: "w", projectId: "p" }) };
beforeEach(() => { vi.resetAllMocks(); f.user.mockResolvedValue({ id: "u" }); f.origin.mockReturnValue(true); f.body.mockResolvedValue({ expectedRevision: 1 }); f.read.mockResolvedValue({ revision: 1 }); f.save.mockResolvedValue({ revision: 2 }); });
describe("project context routes (no database/model)", () => {
  it("scopes reads and returns non-cacheable JSON", async () => {
    const response = await GET(new Request("http://localhost/api/project-context"), context);
    expect(f.read).toHaveBeenCalledWith("w", "u", "p"); expect(response.headers.get("cache-control")).toBe("no-store"); expect(await response.json()).toEqual({ revision: 1 });
  });
  it("bounds same-origin writes and forwards only the authenticated user identity", async () => {
    const req = new Request("http://localhost/api/project-context", { method: "PUT" }); const response = await PUT(req, context);
    expect(f.body).toHaveBeenCalledWith(req, 48 * 1024); expect(f.save).toHaveBeenCalledWith("w", "u", "p", { expectedRevision: 1 }); expect(response.status).toBe(200);
  });
  it("rejects foreign origin and stale user identity before mutation", async () => {
    f.origin.mockReturnValue(false); expect((await PUT(new Request("http://localhost/api/project-context", { method: "PUT" }), context)).status).toBe(403);
    expect((await GET(new Request("http://localhost/api/project-context", { headers: { "X-Novart-User": "other" } }), context)).status).toBe(409);
    expect(f.body).not.toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
  });
  it("preserves safe conflict status and hides arbitrary database errors", async () => {
    f.save.mockRejectedValue(new ApiException(409, "资料已更新")); expect((await PUT(new Request("http://localhost/api/project-context", { method: "PUT" }), context)).status).toBe(409);
    f.read.mockRejectedValue(new Error("private-db-uri")); const response = await GET(new Request("http://localhost/api/project-context"), context);
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("private-db-uri");
  });
});
