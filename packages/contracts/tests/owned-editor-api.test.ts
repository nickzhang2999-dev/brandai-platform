import { afterEach, describe, expect, it, vi } from "vitest";
import { createOwnedEditorApi } from "../../../apps/web/src/components/owned-canvas/owned-editor-api";

const identity = { workspaceId: "owned-w", projectId: "owned-p", userId: "owned-u" };
const document = { workspaceId: identity.workspaceId, projectId: identity.projectId, format: "novart-native-v1", canvas: "", revision: 0, checksum: null, updatedAt: null, readOnly: false };
const mutationId = "4b106a7f-d393-49c2-a396-511d8f010101";
const material = { id: "asset-a", assetId: "asset-a", assetSha256: "a".repeat(64), fileName: "fixture.png", mimeType: "image/png", sizeBytes: 20, width: 10, height: 20, url: "/api/workspaces/owned-w/assets/asset-a/raw", kind: "image" };
const upload = { projectId: identity.projectId, taskId: "task-a", mutationId, status: "SUCCEEDED", progress: 100, expiresAt: "2099-01-01T00:00:00.000Z", material };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const setup = (fetcher: typeof fetch, signal?: AbortSignal) => createOwnedEditorApi(identity.workspaceId, identity.projectId, identity.userId, { fetcher, origin: "https://novart.test", signal });
afterEach(() => vi.useRealTimers());

describe("owned editor product API", () => {
  it("pins document requests to the server page identity with cookie authentication", async () => {
    const fetcher = vi.fn().mockResolvedValue(response(document));
    await setup(fetcher).session.load();
    expect(fetcher.mock.calls[0]![0]).toBe("/api/workspaces/owned-w/projects/owned-p/editor-document?workspaceId=owned-w");
    const init = fetcher.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get("X-Novart-User")).toBe(identity.userId);
    expect(init.credentials).toBe("same-origin");
    expect(init.cache).toBe("no-store");
    expect(new Headers(init.headers).has("authorization")).toBe(false);
  });

  it("does not accept another workspace's otherwise valid material receipt", async () => {
    const api = setup(vi.fn().mockResolvedValue(response([{ ...material, url: "/api/workspaces/other/assets/asset-a/raw" }])));
    await expect(api.listMaterials()).rejects.toMatchObject({ status: 422 });
  });

  it("does not turn malformed or foreign-project upload receipts into success", async () => {
    const foreign = setup(vi.fn().mockResolvedValue(response({ ...upload, projectId: "other-project" })));
    await expect(foreign.getUpload("task-a")).rejects.toMatchObject({ status: 422 });
    const malformed = setup(vi.fn().mockResolvedValue(response({ ...upload, material: undefined })));
    await expect(malformed.getUpload("task-a")).rejects.toMatchObject({ code: "INVALID_RECEIPT" });
  });

  it("preserves a real configuration error without inventing a generated result", async () => {
    const api = setup(vi.fn().mockResolvedValue(response({ error: "真实图片生成服务尚未配置。" }, 503)));
    await expect(api.submitGeneration({ projectId: identity.projectId, mutationId, prompt: "Test image", workflowRevision: 0, documentRevision: 0, sizeSelection: { ratioKey: "1:1", resolutionTier: "1K" } })).rejects.toMatchObject({ message: "真实图片生成服务尚未配置。", status: 503, uncertain: true });
  });

  it("keeps the request timeout connected after headers while the JSON body stalls", async () => {
    vi.useFakeTimers();
    let bodyAborted = false;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(new ReadableStream({
      start(controller) { init?.signal?.addEventListener("abort", () => { bodyAborted = true; controller.error(new DOMException("Aborted", "AbortError")); }, { once: true }); },
    })));
    const pending = setup(fetcher).listMaterials();
    const assertion = expect(pending).rejects.toMatchObject({ status: null });
    await vi.advanceTimersByTimeAsync(20001);
    await assertion;
    expect(bodyAborted).toBe(true);
  });

  it("also cancels body reading on editor unmount", async () => {
    const controller = new AbortController();
    let abortBody!: () => void;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(new ReadableStream({
      start(body) { abortBody = () => controller.abort(); init?.signal?.addEventListener("abort", () => body.error(new DOMException("Aborted", "AbortError")), { once: true }); },
    })));
    const pending = setup(fetcher, controller.signal).listMaterials();
    const assertion = expect(pending).rejects.toBeDefined();
    await Promise.resolve(); abortBody(); await assertion;
  });

  it("stops upload polling at the bounded client window without resubmission", async () => {
    vi.useFakeTimers();
    const task = { ...upload, status: "PENDING", progress: 0, material: undefined };
    const fetcher = vi.fn().mockImplementation(async () => response(task));
    const api = setup(fetcher);
    const pending = api.pollUpload(task as never, vi.fn(), 3000);
    await vi.advanceTimersByTimeAsync(3001);
    expect((await pending).status).toBe("PENDING");
    expect(fetcher.mock.calls.length).toBeGreaterThan(0);
    expect(fetcher.mock.calls.every(call => call[1]?.method === undefined)).toBe(true);
  });
});
