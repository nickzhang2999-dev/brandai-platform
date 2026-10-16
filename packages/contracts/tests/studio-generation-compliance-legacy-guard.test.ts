import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ generation: vi.fn(), version: vi.fn(), studio: vi.fn(), role: vi.fn(), user: vi.fn(), check: vi.fn(), save: vi.fn() }));
vi.mock("../../db/src/index", () => ({ prisma: { generation: { findUnique: f.generation }, generationVersion: { findUnique: f.version }, studioGenerationRequest: { findUnique: f.studio } } }));
vi.mock("@/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } },
  requireUser: f.user, handleError: (error: any) => Response.json({ error: error.message }, { status: error.status ?? 500 }), ok: (value: unknown, init?: ResponseInit) => Response.json(value, init) }));
vi.mock("@/lib/workspace", () => ({ requireWorkspaceRole: f.role }));
vi.mock("@/lib/compliance-tasks", () => ({ createComplianceTask: f.check }));
import { POST } from "../../../apps/web/src/app/api/workspaces/[wsId]/generations/[genId]/versions/[versionId]/recheck/route";
const run = () => POST(new Request("http://local/recheck", { method: "POST" }), { params: Promise.resolve({ wsId: "w", genId: "g", versionId: "v" }) });
beforeEach(() => {
  vi.resetAllMocks(); f.user.mockResolvedValue({ id: "u" }); f.generation.mockResolvedValue({ id: "g", workspaceId: "w", projectId: "p", sellingPoint: "hello", scene: "scene" });
  f.version.mockResolvedValue({ id: "v", generationId: "g", imageUrl: "https://legacy/image.png" }); f.studio.mockResolvedValue(null);
  f.check.mockResolvedValue({ taskId: "t", status: "PENDING" });
});
describe("legacy async recheck boundary", () => {
  it("rejects product versions before any direct provider invocation", async () => {
    f.studio.mockResolvedValue({ id: "product-request" }); expect((await run()).status).toBe(409); expect(f.check).not.toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled();
  });
  it("accepts a durable receipt without updating the version in the HTTP request", async () => {
    const response = await run(); expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ taskId: "t", status: "PENDING" });
    expect(f.role).toHaveBeenCalledWith("w", "u", "EDITOR");
    expect(f.check).toHaveBeenCalledWith("w", "COMPLIANCE_RECHECK", { userId: "u", projectId: "p", generationId: "g", versionId: "v", text: "hello。scene", imageUrl: "https://legacy/image.png" });
    expect(f.save).not.toHaveBeenCalled();
  });
  it("keeps workspace ownership checks before product task lookup", async () => {
    f.generation.mockResolvedValue({ workspaceId: "foreign" }); expect((await run()).status).toBe(404); expect(f.studio).not.toHaveBeenCalled(); expect(f.check).not.toHaveBeenCalled();
  });
});
