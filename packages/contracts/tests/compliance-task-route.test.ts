import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ auth: vi.fn(), user: vi.fn(), role: vi.fn(), task: vi.fn(), project: vi.fn(), brand: vi.fn() }));
vi.mock("../../db/src/index", () => ({ prisma: { user: { findUnique: f.user }, project: { findUnique: f.project }, brandWorkspace: { findUnique: f.brand } } }));
vi.mock("@/auth", () => ({ auth: f.auth }));
vi.mock("@/lib/api", async () => import("../../../apps/web/src/lib/api"));
vi.mock("@/lib/workspace", () => ({ requireWorkspaceRole: f.role }));
vi.mock("@/lib/compliance-tasks", () => ({ createComplianceTask: f.task }));
import { ApiException } from "../../../apps/web/src/lib/api";
import { POST as textCheck } from "../../../apps/web/src/app/api/workspaces/[wsId]/compliance/precheck/route";
import { POST as generationCheck } from "../../../apps/web/src/app/api/workspaces/[wsId]/generations/precheck/route";
const invoke = (post: typeof textCheck, body: unknown) => post(new Request("http://local/precheck", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ wsId: "w" }) });
const brief = { projectId: "p", sceneType: "SOCIAL_POSTER", sellingPoint: "Brief" };
beforeEach(() => {
  vi.resetAllMocks(); f.auth.mockResolvedValue({ user: { id: "u" } }); f.user.mockResolvedValue({ isActive: true });
  f.project.mockResolvedValue({ id: "p", workspaceId: "w", name: "Project", brief: "Fallback" });
  f.brand.mockResolvedValue({ name: "Brand", industry: "Design" }); f.task.mockResolvedValue({ taskId: "t", status: "PENDING" });
});
describe("asynchronous precheck HTTP boundaries", () => {
  it("accepts a text task under the URL workspace and server identity", async () => {
    const response = await invoke(textCheck, { text: "Text", workspaceId: "foreign", userId: "intruder" });
    expect(response.status).toBe(202); expect(await response.json()).toEqual({ taskId: "t", status: "PENDING" });
    expect(f.role).toHaveBeenCalledWith("w", "u", "EDITOR");
    expect(f.task).toHaveBeenCalledWith("w", "COMPLIANCE_PRECHECK", { userId: "u", text: "Text" });
  });
  it("accepts the generation brief after project ownership validation", async () => {
    expect((await invoke(generationCheck, brief)).status).toBe(202);
    expect(f.role).toHaveBeenCalledWith("w", "u", "EDITOR");
    expect(f.task).toHaveBeenCalledWith("w", "GENERATION_PRECHECK", { userId: "u", projectId: "p", text: "Brief" });
  });
  it.each([textCheck, generationCheck])("rejects a viewer before any task is created", async post => {
    f.role.mockRejectedValue(new ApiException(403, "Forbidden"));
    expect((await invoke(post, { ...brief, text: "Text" })).status).toBe(403); expect(f.task).not.toHaveBeenCalled();
  });
  it.each([textCheck, generationCheck])("rejects a deactivated account before queuing", async post => {
    f.user.mockResolvedValue({ isActive: false });
    expect((await invoke(post, { ...brief, text: "Text" })).status).toBe(403); expect(f.task).not.toHaveBeenCalled();
  });
  it("rejects a foreign project before resolving brand rules or accepting work", async () => {
    f.project.mockResolvedValue({ id: "p", workspaceId: "foreign" });
    expect((await invoke(generationCheck, brief)).status).toBe(404); expect(f.brand).not.toHaveBeenCalled(); expect(f.task).not.toHaveBeenCalled();
  });
  it.each([[textCheck, { text: 42 }], [generationCheck, { ...brief, sceneType: "INVALID" }]] as const)("rejects invalid input without a receipt", async (post, body) => {
    expect((await invoke(post, body)).status).toBe(422); expect(f.task).not.toHaveBeenCalled();
  });
});
