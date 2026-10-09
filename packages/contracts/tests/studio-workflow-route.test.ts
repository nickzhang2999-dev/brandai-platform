import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
const f = vi.hoisted(() => ({ session: vi.fn(), read: vi.fn(), assets: vi.fn(), save: vi.fn(), image: vi.fn(), upload: vi.fn(), task: vi.fn(), materials: vi.fn() }));
vi.mock("../../../apps/web/src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("../../../apps/web/src/lib/studio-session", () => ({ studioSession: f.session }));
vi.mock("../../../apps/web/src/lib/studio-assets", () => ({ studioAsset: vi.fn(), studioHtml: vi.fn() }));
vi.mock("../../../apps/web/src/lib/editor-documents", () => ({ readEditorDocument: vi.fn() }));
vi.mock("../../../apps/web/src/lib/studio-state", () => ({}));
vi.mock("../../../apps/web/src/lib/studio-workflow", () => ({ readStudioWorkflow: f.read, readStudioWorkflowAssets: f.assets, saveStudioWorkflow: f.save, studioWorkflowImage: f.image }));
vi.mock("../../../apps/web/src/lib/studio-materials", () => ({ submitStudioMaterial: f.upload, readStudioMaterialUpload: f.task, listStudioMaterials: f.materials }));
import { studioRoute } from "../../../apps/web/src/lib/studio-route";

const base = "http://127.0.0.1:3000";
const sha = "a".repeat(64);
beforeEach(() => {
  vi.resetAllMocks();
  f.session.mockResolvedValue({ user: { id: "server-user" }, workspaceId: "server-workspace", session: {} });
  f.read.mockResolvedValue({ revision: 1 }); f.assets.mockResolvedValue({ assets: [] }); f.save.mockResolvedValue({ revision: 2 });
  f.image.mockResolvedValue("/api/workspaces/server-workspace/assets/a/raw");
  f.upload.mockResolvedValue({ taskId: "task", status: "PENDING" }); f.task.mockResolvedValue({ tasks: [] }); f.materials.mockResolvedValue([]);
});
const request = (path: string, body?: unknown) => new Request(base + path, body === undefined ? {} : {
  method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify(body),
});

describe("authenticated workflow and material routes", () => {
  it.each([["/workflow", "read"], ["/workflow/assets", "assets"], ["/studio/materials", "materials"]] as const)(
    "routes %s with server-resolved user/workspace and project query", async (path, method) => {
      const response = await studioRoute(request(path + "?projectId=p"));
      expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
      expect(f[method]).toHaveBeenCalledWith("server-workspace", "server-user", { projectId: "p" });
    },
  );
  it("passes the exact save body only after same-origin validation", async () => {
    const body = { projectId: "p", revision: 0, mode: "generate", target: null, references: [] };
    expect((await studioRoute(request("/workflow", body))).status).toBe(200);
    expect(f.save).toHaveBeenCalledWith("server-workspace", "server-user", body);
    f.save.mockClear();
    const crossOrigin = new Request(base + "/workflow", { method: "POST", headers: { origin: "https://other.invalid", "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await studioRoute(crossOrigin)).status).toBe(403); expect(f.save).not.toHaveBeenCalled();
  });
  it("passes multipart intact for asynchronous upload and returns an accepted receipt", async () => {
    const form = new FormData(); form.set("projectId", "p"); form.set("file", new Blob(["fixture"], { type: "image/png" }), "image.png");
    const req = new Request(base + "/studio/material-upload", { method: "POST", headers: { origin: base }, body: form });
    const response = await studioRoute(req);
    expect(response.status).toBe(202); expect(await response.json()).toEqual({ taskId: "task", status: "PENDING" });
    expect(f.upload).toHaveBeenCalledWith("server-workspace", "server-user", req); expect(req.bodyUsed).toBe(false);
  });
  it("supports upload task lookup and current-user task listing without inventing an absent task ID", async () => {
    expect((await studioRoute(request("/studio/material-upload?projectId=p&taskId=task"))).status).toBe(200);
    expect(f.task).toHaveBeenLastCalledWith("server-workspace", "server-user", { projectId: "p", taskId: "task" });
    await studioRoute(request("/studio/material-upload?projectId=p"));
    expect(f.task).toHaveBeenLastCalledWith("server-workspace", "server-user", { projectId: "p" });
  });
  it("returns only the authorized same-origin image proxy with no-store headers", async () => {
    const response = await studioRoute(request(`/workflow/image/${sha}?projectId=p`));
    expect(response.status).toBe(307); expect(response.headers.get("location")).toBe("/api/workspaces/server-workspace/assets/a/raw");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(f.image).toHaveBeenCalledWith("server-workspace", "server-user", { projectId: "p" }, sha);
  });
  it("keeps input/authorization/availability failures visible and does not turn unknown actions into success", async () => {
    f.read.mockRejectedValueOnce(new ZodError([]));
    expect((await studioRoute(request("/workflow?projectId=p"))).status).toBe(422);
    f.session.mockRejectedValueOnce(new Error("private detail"));
    const response = await studioRoute(request("/workflow?projectId=p"));
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("private detail");
    expect((await studioRoute(request("/workflow/unimplemented", {}))).status).toBe(503);
  });
});
