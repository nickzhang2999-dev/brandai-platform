import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ session: vi.fn(), origin: vi.fn(), read: vi.fn(), write: vi.fn() }));
vi.mock("@/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } },
  ok: (value: unknown) => Response.json(value), handleError: (error: any) => Response.json({ error: error.message }, { status: error.status ?? 400 }) }));
vi.mock("@/lib/studio-session", () => ({ studioSession: f.session }));
vi.mock("@/lib/workbench-origin", () => ({ isWorkbenchSameOrigin: f.origin }));
vi.mock("@/lib/studio-brand-knowledge", () => ({ readStudioBrandDraftImport: f.read, importStudioBrandDraft: f.write }));
import { GET, POST } from "../../../apps/web/src/app/api/studio/brand-knowledge/import-draft/route";
const request = () => new Request("https://app.invalid/api/studio/brand-knowledge/import-draft?workspaceId=w", { method: "POST", headers: { "content-type": "application/json", "X-Novart-User": "u", origin: "https://app.invalid" }, body: JSON.stringify({ mutationId: "mutation", expectedDraftRevision: 4 }) });
beforeEach(() => { vi.resetAllMocks(); f.session.mockResolvedValue({ user: { id: "actual-user" }, workspaceId: "actual-workspace" }); f.origin.mockReturnValue(true); f.read.mockResolvedValue({ available: true }); f.write.mockResolvedValue({ created: 2 }); });
describe("brand draft import HTTP boundary", () => {
  it("uses authoritative session scope, not body identity", async () => {
    expect((await POST(request())).status).toBe(200);
    expect(f.write).toHaveBeenCalledWith("actual-workspace", "actual-user", { mutationId: "mutation", expectedDraftRevision: 4 });
  });
  it("rejects a cross-origin write before importing", async () => {
    f.origin.mockReturnValue(false); expect((await POST(request())).status).toBe(403); expect(f.write).not.toHaveBeenCalled();
  });
  it.each([401, 404, 409])("retains real session/account-switch failures (%i)", async status => {
    f.session.mockRejectedValue(Object.assign(new Error("denied"), { status })); expect((await POST(request())).status).toBe(status); expect(f.write).not.toHaveBeenCalled();
  });
  it("reads state without importing or requiring a write-origin check", async () => {
    expect((await GET(new Request("https://app.invalid/api/studio/brand-knowledge/import-draft?workspaceId=w"))).status).toBe(200);
    expect(f.read).toHaveBeenCalledWith("actual-workspace", "actual-user"); expect(f.write).not.toHaveBeenCalled(); expect(f.origin).not.toHaveBeenCalled();
  });
});
