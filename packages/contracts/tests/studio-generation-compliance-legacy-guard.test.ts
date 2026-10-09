import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ generation: vi.fn(), version: vi.fn(), studio: vi.fn(), role: vi.fn(), user: vi.fn(), check: vi.fn(), save: vi.fn() }));
vi.mock("../../db/src/index", () => ({ prisma: { generation: { findUnique: f.generation }, generationVersion: { findUnique: f.version }, studioGenerationRequest: { findUnique: f.studio } } }));
vi.mock("@/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } },
  requireUser: f.user, handleError: (error: any) => Response.json({ error: error.message }, { status: error.status ?? 500 }), ok: (value: unknown) => Response.json(value) }));
vi.mock("@/lib/workspace", () => ({ requireWorkspaceRole: f.role }));
vi.mock("@/lib/compliance", () => ({ runComplianceCheck: f.check }));
vi.mock("@/lib/generations", () => ({ setVersionComplianceReport: f.save }));
import { POST } from "../../../apps/web/src/app/api/workspaces/[wsId]/generations/[genId]/versions/[versionId]/recheck/route";
const run = () => POST(new Request("http://local/recheck", { method: "POST" }), { params: Promise.resolve({ wsId: "w", genId: "g", versionId: "v" }) });
beforeEach(() => {
  vi.resetAllMocks(); f.user.mockResolvedValue({ id: "u" }); f.generation.mockResolvedValue({ id: "g", workspaceId: "w", sellingPoint: "hello", scene: "scene" });
  f.version.mockResolvedValue({ id: "v", generationId: "g", imageUrl: "https://legacy/image.png" }); f.studio.mockResolvedValue(null);
  f.check.mockResolvedValue({ report: { overall: "PASS", checkedAt: new Date().toISOString() } }); f.save.mockResolvedValue({ id: "v" });
});
describe("legacy synchronous recheck boundary", () => {
  it("rejects product versions before any direct provider invocation", async () => {
    f.studio.mockResolvedValue({ id: "product-request" }); expect((await run()).status).toBe(409); expect(f.check).not.toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled();
  });
  it("preserves legacy version recheck behavior", async () => {
    expect((await run()).status).toBe(200); expect(f.check).toHaveBeenCalledWith({ workspaceId: "w", text: "hello。scene", imageUrl: "https://legacy/image.png" }); expect(f.save).toHaveBeenCalledTimes(1);
  });
  it("keeps workspace ownership checks before product task lookup", async () => {
    f.generation.mockResolvedValue({ workspaceId: "foreign" }); expect((await run()).status).toBe(404); expect(f.studio).not.toHaveBeenCalled(); expect(f.check).not.toHaveBeenCalled();
  });
});
