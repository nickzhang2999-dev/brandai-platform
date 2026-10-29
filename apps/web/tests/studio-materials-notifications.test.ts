vi.mock("@/lib/studio-writing-notifications", () => ({ listWritingNotifications: async () => [] }));
import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ generations: vi.fn(), tasks: vi.fn(), uploads: vi.fn(), projects: vi.fn(), studio: vi.fn(), layers: vi.fn() }));
vi.mock("../../../packages/db/src/index", () => ({ prisma: { generation: { findMany: f.generations }, asyncTask: { findMany: f.tasks }, studioMaterialUpload: { findMany: f.uploads }, project: { findMany: f.projects } } }));
vi.mock("../src/lib/brand-preview", () => ({ BRAND_PREVIEW_PROJECT_NAME: "hidden-preview" }));
vi.mock("../src/lib/studio-notifications", () => ({ listStudioGenerationNotifications: f.studio }));
vi.mock("../src/lib/studio-layer-notifications", () => ({ listStudioLayerNotifications: f.layers }));
vi.mock("../src/lib/studio-workflow-notifications", () => ({ listStudioWorkflowNotifications: async () => [] }));
vi.mock("../src/lib/studio-copywriting-notifications", () => ({ listCopywritingNotifications: async () => [] }));
import { listWorkspaceNotifications } from "../src/lib/notifications";
const upload = { taskId: "upload-task", projectId: "p", fileName: "my image.png", task: { status: "SUCCEEDED", error: null, updatedAt: new Date("2026-10-09T00:00:00Z") } };
beforeEach(() => { vi.resetAllMocks(); f.generations.mockResolvedValue([]); f.tasks.mockResolvedValue([]); f.uploads.mockResolvedValue([upload]); f.projects.mockResolvedValue([{ id: "p" }]); f.studio.mockResolvedValue([]); f.layers.mockResolvedValue([]); });
describe("private upload terminal notifications", () => {
  it("opens an existing legacy generation in the image library instead of an empty native canvas", async () => {
    f.uploads.mockResolvedValue([]);
    f.generations.mockResolvedValue([{ id: "g", projectId: "p", status: "SUCCEEDED", sceneType: "SCENE", error: null,
      finishedAt: new Date("2026-10-09T00:00:00Z"), createdAt: new Date("2026-10-09T00:00:00Z"), _count: { versions: 1 } }]);
    expect((await listWorkspaceNotifications("w", 30, "u"))[0].href).toBe("/generated?workspaceId=w&generationId=g");
  });
  it("links projectless brand-library uploads to the real brand library without a phantom project", async () => {
    f.uploads.mockResolvedValue([{ ...upload, projectId: null, attachToProject: false }]);
    const items = await listWorkspaceNotifications("w", 30, "u", "studio");
    expect(items[0]).toMatchObject({ href: "/studio?workspaceId=w#/resources", status: "SUCCEEDED" });
    expect(f.projects).not.toHaveBeenCalled();
    f.uploads.mockResolvedValue([{ ...upload, projectId: null, attachToProject: true }]);
    expect(await listWorkspaceNotifications("w", 30, "u", "studio")).toEqual([]);
  });
  it("queries uploads by authenticated user plus workspace and never puts them in the shared task query", async () => {
    const items = await listWorkspaceNotifications("w", 30, "u");
    expect(f.uploads).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: "w", userId: "u", task: { workspaceId: "w", kind: "STUDIO_UPLOAD", status: { in: ["SUCCEEDED", "FAILED"] } } } }));
    expect(f.tasks.mock.calls[0][0].where.kind.in).not.toContain("STUDIO_UPLOAD");
    expect(items).toEqual([{ id: "task:upload-task", kind: "STUDIO_UPLOAD", status: "SUCCEEDED", title: "图片上传完成", detail: "my image.png 已保存，可返回画布查看或加入图片。", href: "/canvas?workspaceId=w&projectId=p&taskId=upload-task", createdAt: "2026-10-09T00:00:00.000Z" }]);
    expect(f.generations.mock.calls[0][0].where.studioRequest).toEqual({ is: null });
  });
  it("a legacy caller without a user id cannot accidentally read private upload events", async () => {
    expect(await listWorkspaceNotifications("w")).toEqual([]); expect(f.uploads).not.toHaveBeenCalled();
    expect(f.studio).not.toHaveBeenCalled(); expect(f.layers).not.toHaveBeenCalled();
  });
  it("filters deleted or mismatched projects before creating a product deep link", async () => {
    f.projects.mockResolvedValue([]); expect(await listWorkspaceNotifications("w", 30, "u")).toEqual([]);
    expect(f.projects).toHaveBeenCalledWith({ where: { workspaceId: "w", id: { in: ["p"] } }, select: { id: true } });
  });
  it("shows the durable readable failure and preserves other task behavior", async () => {
    f.uploads.mockResolvedValue([{ ...upload, task: { ...upload.task, status: "FAILED", error: "图片已损坏，请重新选择。" } }]);
    f.tasks.mockResolvedValue([{ id: "existing", kind: "RECOGNIZE", status: "SUCCEEDED", refCount: 2, updatedAt: new Date("2026-10-08T00:00:00Z") }]);
    const items = await listWorkspaceNotifications("w", 30, "u");
    expect(items[0]).toMatchObject({ status: "FAILED", title: "图片上传失败", detail: "图片已损坏，请重新选择。" });
    expect(items[1]).toMatchObject({ kind: "RECOGNIZE", title: "素材识别完成", detail: "新增 2 条规则草稿", href: "/brand-knowledge?workspaceId=w" });
  });
  it("product scope does not fetch or surface legacy workspace task events", async () => {
    const items = await listWorkspaceNotifications("w", 30, "u", "studio");
    expect(items).toHaveLength(1); expect(f.generations).not.toHaveBeenCalled(); expect(f.tasks).not.toHaveBeenCalled();
    expect(f.studio).toHaveBeenCalledWith("w", "u", 30);
    expect(f.layers).toHaveBeenCalledWith("w", "u", 30);
  });
  it("merges successful and failed layer events with uploads and generation by terminal time", async () => {
    const layer = { id: "studio-decomposition:layers", kind: "STUDIO_DECOMPOSITION", status: "SUCCEEDED", title: "AI 图层已保存", detail: "返回画布查看。",
      href: "/canvas?workspaceId=w&projectId=p&layerRequestId=layers", createdAt: "2026-10-09T00:03:00.000Z" };
    const failed = { ...layer, id: "studio-decomposition:failed", status: "FAILED", title: "AI 分层未完成", href: "/canvas?workspaceId=w&projectId=p&layerRequestId=failed", createdAt: "2026-10-09T00:01:00.000Z" };
    const generation = { ...layer, id: "studio-generation:generated", kind: "STUDIO_GENERATION", href: "/canvas?workspaceId=w&projectId=p&requestId=generated", createdAt: "2026-10-09T00:02:00.000Z" };
    f.layers.mockResolvedValue([failed, layer]); f.studio.mockResolvedValue([generation]);
    const items = await listWorkspaceNotifications("w", 30, "u", "studio");
    expect(f.layers).toHaveBeenCalledWith("w", "u", 30);
    expect(items.map(item => item.id)).toEqual([layer.id, generation.id, failed.id, "task:upload-task"]);
    expect(items[0]).toEqual(layer); expect(items[2]).toEqual(failed);
    expect(f.generations).not.toHaveBeenCalled(); expect(f.tasks).not.toHaveBeenCalled();
    expect((await listWorkspaceNotifications("w", 2, "u", "studio")).map(item => item.id)).toEqual([layer.id, generation.id]);
  });
  it("does not consult any private product source without an authenticated user, including studio-only scope", async () => {
    expect(await listWorkspaceNotifications("w", 30, undefined, "studio")).toEqual([]);
    expect(f.uploads).not.toHaveBeenCalled(); expect(f.studio).not.toHaveBeenCalled(); expect(f.layers).not.toHaveBeenCalled();
  });
});
