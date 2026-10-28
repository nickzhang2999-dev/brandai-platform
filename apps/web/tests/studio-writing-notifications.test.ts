import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ tasks: vi.fn(), projects: vi.fn() }));
vi.mock("@brandai/db", () => ({ prisma: { asyncTask: { findMany: f.tasks }, project: { findMany: f.projects } } }));
import { listWritingNotifications } from "@/lib/studio-writing-notifications";
const row = { id: "private-task", refId: "p&x=1", status: "SUCCEEDED", updatedAt: new Date("2026-10-27T01:00:00Z") };
beforeEach(() => { vi.resetAllMocks(); f.tasks.mockResolvedValue([row]); f.projects.mockResolvedValue([{ id: row.refId }]); });
describe("private writing notifications", () => {
  it("queries only workspace/user terminal tasks and returns no request text or provider diagnostic", async () => {
    f.tasks.mockResolvedValue([{ ...row, status: "FAILED", error: "secret diagnostic", inputJson: { prompt: "private-text" }, resultJson: { text: "private-answer" } }]);
    const result = await listWritingNotifications("ws", "user", 30);
    expect(f.tasks.mock.calls[0][0]).toMatchObject({ where: { workspaceId: "ws", kind: "STUDIO_WRITING", inputJson: { path: ["userId"], equals: "user" }, status: { in: ["SUCCEEDED", "FAILED"] } } });
    for (const secret of ["secret diagnostic", "private-text", "private-answer"]) expect(JSON.stringify(result)).not.toContain(secret);
    const url = new URL(result[0].href!, "https://local.invalid"); expect(url.searchParams.get("projectId")).toBe(row.refId); expect(url.searchParams.get("workspaceId")).toBe("ws");
  });
  it("requires a user, bounds retrieval and excludes deleted or cross-workspace projects", async () => {
    expect(await listWritingNotifications("ws", "", 30)).toEqual([]); expect(f.tasks).not.toHaveBeenCalled();
    f.projects.mockResolvedValue([]); expect(await listWritingNotifications("ws", "user", 999)).toEqual([]);
    expect(f.tasks.mock.calls[0][0].take).toBe(100); expect(f.projects.mock.calls[0][0].where.workspaceId).toBe("ws");
  });
});
