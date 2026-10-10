import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
const f = vi.hoisted(() => ({ session: vi.fn(), read: vi.fn(), assets: vi.fn(), save: vi.fn(), image: vi.fn(), upload: vi.fn(), task: vi.fn(), materials: vi.fn(), generate: vi.fn(), generation: vi.fn(), retryArchive: vi.fn(), compliance: vi.fn(), retryCompliance: vi.fn() }));
vi.mock("../../../apps/web/src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("../../../apps/web/src/lib/studio-session", () => ({ studioSession: f.session }));
vi.mock("../../../apps/web/src/lib/studio-assets", async importOriginal => ({ ...await importOriginal<typeof import("../../../apps/web/src/lib/studio-assets")>(), studioAsset: vi.fn() }));
vi.mock("../../../apps/web/src/lib/editor-documents", () => ({ readEditorDocument: vi.fn() }));
vi.mock("../../../apps/web/src/lib/studio-state", () => ({}));
vi.mock("../../../apps/web/src/lib/studio-workflow", () => ({ readStudioWorkflow: f.read, readStudioWorkflowAssets: f.assets, saveStudioWorkflow: f.save, studioWorkflowImage: f.image }));
vi.mock("../../../apps/web/src/lib/studio-materials", () => ({ submitStudioMaterial: f.upload, readStudioMaterialUpload: f.task, listStudioMaterials: f.materials }));
vi.mock("../../../apps/web/src/lib/studio-generation", () => ({ submitStudioGeneration: f.generate, readStudioGeneration: f.generation }));
vi.mock("../../../apps/web/src/lib/studio-generation-artifacts", () => ({ retryStudioGenerationArtifacts: f.retryArchive }));
vi.mock("../../../apps/web/src/lib/studio-generation-compliance", () => ({ readStudioGenerationCompliance: f.compliance, retryStudioGenerationCompliance: f.retryCompliance }));
import { studioRoute } from "../../../apps/web/src/lib/studio-route";
import { studioAsset } from "../../../apps/web/src/lib/studio-assets";
import { readEditorDocument } from "../../../apps/web/src/lib/editor-documents";

const base = "http://127.0.0.1:3000";
const sha = "a".repeat(64);
beforeEach(() => {
  vi.resetAllMocks();
  f.session.mockResolvedValue({ user: { id: "server-user" }, workspaceId: "server-workspace", session: {} });
  f.read.mockResolvedValue({ revision: 1 }); f.assets.mockResolvedValue({ assets: [] }); f.save.mockResolvedValue({ revision: 2 });
  f.image.mockResolvedValue("/api/workspaces/server-workspace/assets/a/raw");
  f.upload.mockResolvedValue({ taskId: "task", status: "PENDING" }); f.task.mockResolvedValue({ tasks: [] }); f.materials.mockResolvedValue([]);
  f.generate.mockResolvedValue({ requestId: "gen", status: "PENDING" });
  f.generation.mockResolvedValue({ requestId: "gen", status: "SUCCEEDED", resultState: "PENDING", results: [] });
  f.compliance.mockResolvedValue({ versionId: "v", status: "FAILED", report: null });
  f.retryCompliance.mockResolvedValue({ versionId: "v", status: "PENDING", report: null });
});
afterEach(() => vi.unstubAllEnvs());
const request = (path: string, body?: unknown) => new Request(base + path, body === undefined ? {} : {
  method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify(body),
});

describe("authenticated workflow and material routes", () => {
  it.each(["/studio", "/canvas?projectId=p"])("injects only the server license configuration into authenticated %s HTML", async path => {
    vi.stubEnv("NOVART_TLDRAW_LICENSE_KEY", "synthetic-not-a-real-license");
    vi.mocked(studioAsset).mockResolvedValue({ bytes: Buffer.from('<html><head><script src="/native.js"></script></head><body></body></html>'), mime: "text/html" });
    vi.mocked(readEditorDocument).mockResolvedValue({ readOnly: true } as Awaited<ReturnType<typeof readEditorDocument>>);
    const response = await studioRoute(request(path + (path.includes("?") ? "&" : "?") + "NOVART_TLDRAW_LICENSE_KEY=untrusted-query"));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    const serialized = html.match(/<script id="novart-product-context" type="application\/json">([^<]*)<\/script>/)?.[1];
    expect(JSON.parse(serialized!).canvasLicense).toEqual({ key: "synthetic-not-a-real-license", status: "configured" });
    expect(html).not.toContain("untrusted-query");
  });
  it("does not serve license context before authentication succeeds", async () => {
    f.session.mockRejectedValue(new Error("session unavailable"));
    const response = await studioRoute(request("/studio"));
    expect(response.status).not.toBe(200); expect(studioAsset).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain("canvasLicense");
  });
  it("checks a published version by server identity and retries only the check", async () => {
    const read = await studioRoute(request("/studio/generation/compliance?projectId=p&versionId=v&userId=other"));
    expect(read.status).toBe(200); expect(f.compliance).toHaveBeenCalledWith("server-workspace", "server-user", { projectId: "p", versionId: "v" });
    const response = await studioRoute(request("/studio/generation/compliance/retry", { projectId: "p", versionId: "v" }));
    expect(response.status).toBe(202); expect(await response.json()).toEqual({ versionId: "v", status: "PENDING", report: null });
    expect(f.retryCompliance).toHaveBeenCalledWith("server-workspace", "server-user", { projectId: "p", versionId: "v" });
    expect(f.generate).not.toHaveBeenCalled(); expect(f.retryArchive).not.toHaveBeenCalled();
  });
  it("rejects cross-origin check retry before any paid check is accepted", async () => {
    const req = new Request(base + "/studio/generation/compliance/retry", { method: "POST", headers: { origin: "https://other.invalid", "content-type": "application/json" }, body: JSON.stringify({ projectId: "p", versionId: "v" }) });
    expect((await studioRoute(req)).status).toBe(403); expect(f.retryCompliance).not.toHaveBeenCalled();
  });
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
  it("accepts generation with server identity and rejects a cross-origin paid action", async () => {
    const body = { projectId: "p", mutationId: "mutation", prompt: "A new image" };
    const response = await studioRoute(request("/studio/generation", body));
    expect(response.status).toBe(202); expect(await response.json()).toEqual({ requestId: "gen", status: "PENDING" });
    expect(f.generate).toHaveBeenCalledWith("server-workspace", "server-user", body);
    f.generate.mockClear();
    const crossOrigin = new Request(base + "/studio/generation", { method: "POST", headers: { origin: "https://other.invalid", "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await studioRoute(crossOrigin)).status).toBe(403); expect(f.generate).not.toHaveBeenCalled();
  });
  it("looks up generation by server scope and does not forward query-supplied identity", async () => {
    await studioRoute(request("/studio/generation?projectId=p&requestId=gen&userId=victim&workspaceId=other"));
    expect(f.generation).toHaveBeenLastCalledWith("server-workspace", "server-user", { projectId: "p", requestId: "gen" });
    await studioRoute(request("/studio/generation?projectId=p"));
    expect(f.generation).toHaveBeenLastCalledWith("server-workspace", "server-user", { projectId: "p" });
  });
  it("archive retry returns a complete refreshed receipt and never invokes generation", async () => {
    const body = { projectId: "p", requestId: "gen" };
    const response = await studioRoute(request("/studio/generation/retry-archive", body));
    expect(response.status).toBe(202); expect(await response.json()).toMatchObject({ requestId: "gen", status: "SUCCEEDED", resultState: "PENDING" });
    expect(f.retryArchive).toHaveBeenCalledWith("server-workspace", "server-user", body);
    expect(f.generation).toHaveBeenCalledWith("server-workspace", "server-user", body);
    expect(f.generate).not.toHaveBeenCalled();
  });
  it("does not return a successful retry receipt when archive authorization fails", async () => {
    f.retryArchive.mockRejectedValueOnce(new Error("private detail"));
    const response = await studioRoute(request("/studio/generation/retry-archive", { projectId: "p", requestId: "gen" }));
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("private detail");
    expect(f.generation).not.toHaveBeenCalled(); expect(f.generate).not.toHaveBeenCalled();
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
