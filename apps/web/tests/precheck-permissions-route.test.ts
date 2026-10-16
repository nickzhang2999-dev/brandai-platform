import { beforeEach, describe, expect, it, vi } from "vitest";

// Execute real handlers, authentication, workspace role ranking, key validation
// and serialization. Only session, DB and service I/O are synthetic; no network
// or real provider request is made by these authorization tests.
const f = vi.hoisted(() => ({
  session: vi.fn(), user: vi.fn(), workspace: vi.fn(), membership: vi.fn(),
  project: vi.fn(), task: vi.fn(),
}));
vi.mock("../../../packages/db/src/index", () => ({ prisma: {
  user: { findUnique: f.user },
  brandWorkspace: { findUnique: f.workspace },
  membership: { findUnique: f.membership },
  project: { findUnique: f.project },
} }));
vi.mock("../src/auth", () => ({ auth: f.session }));
vi.mock("@/lib/api", async () => import("../src/lib/api"));
vi.mock("@/lib/workspace", async () => import("../src/lib/workspace"));
vi.mock("@/lib/compliance-tasks", () => ({ createComplianceTask: f.task }));

import { POST as compliancePrecheck } from "../src/app/api/workspaces/[wsId]/compliance/precheck/route";
import { POST as generationPrecheck } from "../src/app/api/workspaces/[wsId]/generations/precheck/route";

const params = { params: Promise.resolve({ wsId: "brand-a" }) };
function request(body: unknown, path = "assets") {
  return new Request(`http://127.0.0.1/api/workspaces/brand-a/${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  f.session.mockResolvedValue({ user: { id: "user-a" } });
  f.user.mockResolvedValue({ isActive: true });
  f.workspace.mockResolvedValue({ id: "brand-a", ownerId: "owner-a", name: "品牌 A" });
  f.membership.mockResolvedValue({ id: "membership-a", role: "EDITOR" });
  f.project.mockResolvedValue({ id: "project-a", workspaceId: "brand-a", name: "项目 A" });
  f.task.mockResolvedValue({ taskId: "task-a", status: "PENDING" });
});

const prechecks = [
  { name: "compliance", handler: compliancePrecheck, body: { workspaceId: "brand-a", text: "品牌文案" } },
  { name: "generation", handler: generationPrecheck, body: { projectId: "project-a", sceneType: "SCENE", sellingPoint: "品牌文案" } },
] as const;

describe.each(prechecks)("$name precheck EDITOR gate", ({ handler, body }) => {
  it.each(["VIEWER", "REVIEWER"])("rejects %s before parsing, project reads or external work", async role => {
    f.membership.mockResolvedValue({ role });
    // An invalid body must not bypass or precede the permission gate.
    const response = await handler(request(null), params);
    expect(response.status).toBe(403);
    expect(f.project).not.toHaveBeenCalled();
    expect(f.task).not.toHaveBeenCalled();
  });

  it.each(["EDITOR", "OWNER"])("accepts %s and preserves service request/response", async role => {
    if (role === "OWNER") f.workspace.mockResolvedValue({ id: "brand-a", ownerId: "user-a", name: "品牌 A" });
    const response = await handler(request(body), params);
    // Prechecks are durable tasks: the handler only accepts and returns 202.
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ taskId: "task-a", status: "PENDING" });
    if (handler === compliancePrecheck) {
      expect(f.task).toHaveBeenCalledWith("brand-a", "COMPLIANCE_PRECHECK", { userId: "user-a", text: "品牌文案" });
    } else {
      expect(f.task).toHaveBeenCalledWith("brand-a", "GENERATION_PRECHECK", { userId: "user-a", projectId: "project-a", text: "品牌文案" });
    }
    if (role === "OWNER") expect(f.membership).not.toHaveBeenCalled();
  });

  it("rejects a nonmember even when the workspace and project exist", async () => {
    f.membership.mockResolvedValue(null);
    expect((await handler(request(body), params)).status).toBe(404);
    expect(f.project).not.toHaveBeenCalled();
    expect(f.task).not.toHaveBeenCalled();
  });

  it.each(["anonymous", "disabled"])("rejects an %s identity before workspace access", async identity => {
    if (identity === "anonymous") f.session.mockResolvedValue(null);
    else f.user.mockResolvedValue({ isActive: false });
    expect((await handler(request(body), params)).status).toBe(identity === "anonymous" ? 401 : 403);
    expect(f.workspace).not.toHaveBeenCalled();
    expect(f.project).not.toHaveBeenCalled();
    expect(f.task).not.toHaveBeenCalled();
  });
});

it("generation precheck still checks project ownership for an editor", async () => {
  f.project.mockResolvedValue({ id: "project-b", workspaceId: "brand-b" });
  const response = await generationPrecheck(request(prechecks[1].body), params);
  expect(response.status).toBe(404);
  expect(f.task).not.toHaveBeenCalled();
});
