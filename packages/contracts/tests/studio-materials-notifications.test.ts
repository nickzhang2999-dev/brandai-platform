import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ generations: vi.fn(), tasks: vi.fn(), uploads: vi.fn(), projects: vi.fn(), studio: vi.fn() }));
vi.mock("../../db/src/index", () => ({ prisma: { generation: { findMany: f.generations }, asyncTask: { findMany: f.tasks }, studioMaterialUpload: { findMany: f.uploads }, project: { findMany: f.projects } } }));
vi.mock("../../../apps/web/src/lib/brand-preview", () => ({ BRAND_PREVIEW_PROJECT_NAME: "hidden-preview" }));
vi.mock("../../../apps/web/src/lib/studio-notifications", () => ({ listStudioGenerationNotifications: f.studio }));
import { listWorkspaceNotifications } from "../../../apps/web/src/lib/notifications";
const upload = { taskId: "upload-task", projectId: "p", fileName: "my image.png", task: { status: "SUCCEEDED", error: null, updatedAt: new Date("2026-10-09T00:00:00Z") } };
beforeEach(() => { vi.resetAllMocks(); f.generations.mockResolvedValue([]); f.tasks.mockResolvedValue([]); f.uploads.mockResolvedValue([upload]); f.projects.mockResolvedValue([{ id: "p" }]); f.studio.mockResolvedValue([]); });
describe("private upload terminal notifications", () => {
  it("queries uploads by authenticated user plus workspace and never puts them in the shared task query", async () => {
    const items = await listWorkspaceNotifications("w", 30, "u");
    expect(f.uploads).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: "w", userId: "u", task: { workspaceId: "w", kind: "STUDIO_UPLOAD", status: { in: ["SUCCEEDED", "FAILED"] } } } }));
    expect(f.tasks.mock.calls[0][0].where.kind.in).not.toContain("STUDIO_UPLOAD");
    expect(items).toEqual([{ id: "task:upload-task", kind: "STUDIO_UPLOAD", status: "SUCCEEDED", title: "图片上传完成", detail: "my image.png 已保存，可返回画布查看或加入图片。", href: "/canvas?workspaceId=w&projectId=p&taskId=upload-task", createdAt: "2026-10-09T00:00:00.000Z" }]);
    expect(f.generations.mock.calls[0][0].where.studioRequest).toEqual({ is: null });
  });
  it("a legacy caller without a user id cannot accidentally read private upload events", async () => {
    expect(await listWorkspaceNotifications("w")).toEqual([]); expect(f.uploads).not.toHaveBeenCalled();
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
    expect(items[1]).toMatchObject({ kind: "RECOGNIZE", title: "素材识别完成", detail: "新增 2 条规则草稿", href: "/brand-knowledge" });
  });
  it("product scope does not fetch or surface legacy workspace task events", async () => {
    const items = await listWorkspaceNotifications("w", 30, "u", "studio");
    expect(items).toHaveLength(1); expect(f.generations).not.toHaveBeenCalled(); expect(f.tasks).not.toHaveBeenCalled();
    expect(f.studio).toHaveBeenCalledWith("w", "u", 30);
  });
});
