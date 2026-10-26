import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ tasks: vi.fn(), projects: vi.fn() }));
vi.mock("@brandai/db", () => ({ prisma: { asyncTask: { findMany: f.tasks }, project: { findMany: f.projects } } }));
import { listCopywritingNotifications } from "@/lib/studio-copywriting-notifications";
beforeEach(() => vi.resetAllMocks());
it("scopes terminal notifications to the requesting workspace and account", async () => {
  f.tasks.mockResolvedValue([{ id: "t", kind: "STUDIO_COPYWRITING", refId: "p", status: "SUCCEEDED", updatedAt: new Date(0) }]);
  f.projects.mockResolvedValue([{ id: "p" }]);
  const result = await listCopywritingNotifications("w", "u", 10);
  expect(f.tasks).toHaveBeenCalledWith(expect.objectContaining({ where: {
    workspaceId: "w", kind: "STUDIO_COPYWRITING", inputJson: { path: ["userId"], equals: "u" }, status: { in: ["SUCCEEDED", "FAILED"] },
  } }));
  expect(f.projects).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: "w", id: { in: ["p"] } } }));
  expect(result[0]).toMatchObject({ kind: "STUDIO_COPYWRITING", title: "文案已生成", href: "/canvas?workspaceId=w&projectId=p" });
});
it("does not emit dead links or events belonging to a different task kind", async () => {
  f.tasks.mockResolvedValue([
    { id: "t", kind: "STUDIO_COPYWRITING", refId: "deleted", status: "FAILED", updatedAt: new Date(0) },
    { id: "other", kind: "GENERATE", refId: "p", status: "SUCCEEDED", updatedAt: new Date(0) },
  ]);
  f.projects.mockResolvedValue([]);
  expect(await listCopywritingNotifications("w", "u", 10)).toEqual([]);
});
