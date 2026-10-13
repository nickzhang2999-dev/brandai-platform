import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ list: vi.fn(), projects: vi.fn(), user: vi.fn(), membership: vi.fn(), activity: vi.fn() }));
vi.mock("../../db/src/index", () => ({ prisma: { studioDecompositionRequest: { findMany: f.list }, project: { findMany: f.projects } } }));
vi.mock("@/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } },
  requireUser: f.user, handleError: (error: any) => Response.json({ error: error.message }, { status: error.status ?? 500 }) }));
vi.mock("@/lib/workspace", () => ({ requireOwnedWorkspace: f.membership }));
vi.mock("@/lib/studio-layer-notifications", () => ({ listStudioLayerActivity: f.activity }));
import { listStudioLayerActivity, listStudioLayerNotifications } from "../../../apps/web/src/lib/studio-layer-notifications";
import { GET } from "../../../apps/web/src/app/api/workspaces/[wsId]/studio-layer-activity/route";

const row = (overrides: Record<string, unknown> = {}) => ({
  id: "request", workspaceId: "w", userId: "u", projectId: "p", status: "SUCCEEDED", layerCount: 4,
  createdAt: new Date("2026-10-12T00:00:00Z"), updatedAt: new Date("2026-10-12T00:02:00Z"), expiresAt: new Date("2026-10-12T00:06:00Z"),
  error: "private-provider.invalid?token=synthetic", outputJson: { imageUrl: "https://private-provider.invalid" }, intent: "private intent", ...overrides,
});
beforeEach(() => {
  vi.resetAllMocks(); f.list.mockResolvedValue([row()]); f.projects.mockResolvedValue([{ id: "p", workspaceId: "w" }]);
  f.user.mockResolvedValue({ id: "u" }); f.membership.mockResolvedValue({ id: "w" }); f.activity.mockResolvedValue({ requests: [] });
});

describe("actor-private Studio layer projections", () => {
  it("selects only small terminal fields and links back to the exact layer request", async () => {
    const notices = await listStudioLayerNotifications("w", "u", 30);
    expect(f.list).toHaveBeenCalledWith({ where: { workspaceId: "w", userId: "u", status: { in: ["SUCCEEDED", "FAILED"] } },
      select: { id: true, workspaceId: true, userId: true, projectId: true, status: true, updatedAt: true }, orderBy: { updatedAt: "desc" }, take: 30 });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ id: "studio-decomposition:request", kind: "STUDIO_DECOMPOSITION", status: "SUCCEEDED", href: "/canvas?workspaceId=w&projectId=p&layerRequestId=request", createdAt: "2026-10-12T00:02:00.000Z" });
    expect(JSON.stringify(notices)).not.toMatch(/private-provider|private intent|outputJson|token/);
  });
  it("does not echo any raw failure or private model output", async () => {
    f.list.mockResolvedValue([row({ status: "FAILED" })]);
    const notices = await listStudioLayerNotifications("w", "u", 30);
    expect(notices[0]).toMatchObject({ status: "FAILED", title: "AI 分层未完成" });
    expect(notices[0]!.detail).toContain("请勿重复提交"); expect(JSON.stringify(notices)).not.toMatch(/private-provider|synthetic|private intent/);
  });
  it.each(["foreignWorkspace", "foreignUser", "deletedProject", "foreignProject", "notTerminal"])("omits %s from the terminal inbox", async scenario => {
    if (scenario === "foreignWorkspace") f.list.mockResolvedValue([row({ workspaceId: "other" })]);
    if (scenario === "foreignUser") f.list.mockResolvedValue([row({ userId: "other" })]);
    if (scenario === "deletedProject") f.projects.mockResolvedValue([]);
    if (scenario === "foreignProject") f.projects.mockResolvedValue([{ id: "p", workspaceId: "other" }]);
    if (scenario === "notTerminal") f.list.mockResolvedValue([row({ status: "RUNNING" })]);
    expect(await listStudioLayerNotifications("w", "u", 30)).toEqual([]);
  });
  it("sorts terminal events by completion time and clamps caller-controlled limits", async () => {
    f.list.mockResolvedValue([row(), row({ id: "newer", updatedAt: new Date("2026-10-12T00:03:00Z") })]);
    expect((await listStudioLayerNotifications("w", "u", 1))[0]!.id).toBe("studio-decomposition:newer");
    await listStudioLayerNotifications("w", "u", 10000); expect(f.list.mock.lastCall![0].take).toBe(50);
    f.list.mockClear(); expect(await listStudioLayerNotifications("w", "u", 0)).toEqual([]); expect(f.list).not.toHaveBeenCalled();
  });
  it("returns all four activity states with no raw source, intent, user or provider metadata", async () => {
    f.list.mockResolvedValue(["PENDING", "RUNNING", "SUCCEEDED", "FAILED"].map((status, index) => row({ id: `r${index}`, status })));
    const result = await listStudioLayerActivity("w", "u");
    expect(result.requests.map(item => item.status)).toEqual(["PENDING", "RUNNING", "SUCCEEDED", "FAILED"]);
    expect(result.requests[0]).toEqual({ id: "r0", requestId: "r0", projectId: "p", status: "PENDING", createdAt: "2026-10-12T00:00:00.000Z", expiresAt: "2026-10-12T00:06:00.000Z", layerCount: 4 });
    expect(f.list.mock.lastCall![0].take).toBe(50); expect(f.list.mock.lastCall![0].select).not.toHaveProperty("outputJson");
    expect(JSON.stringify(result)).not.toMatch(/private-provider|private intent|error|assetId|userId|workspaceId/);
    expect(f.projects).toHaveBeenCalledWith({ where: { workspaceId: "w", id: { in: ["p"] } }, select: { id: true, workspaceId: true } });
  });
  it("keeps activity scoped even when cleanup left orphan requests", async () => {
    f.list.mockResolvedValue([row(), row({ id: "foreign", workspaceId: "other" }), row({ id: "someone", userId: "other" }), row({ id: "gone", projectId: "deleted" })]);
    expect((await listStudioLayerActivity("w", "u")).requests.map(item => item.id)).toEqual(["request"]);
  });
});

describe("Studio layer activity HTTP permission boundary", () => {
  const context = { params: Promise.resolve({ wsId: "w" }) };
  const request = (user = "u") => new Request("https://app.invalid/api/workspaces/w/studio-layer-activity", { headers: { "X-Novart-User": user } });
  it("uses actual membership scope and disables caching for successful responses", async () => {
    const response = await GET(request(), context);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store");
    expect(f.membership).toHaveBeenCalledWith("w", "u"); expect(f.activity).toHaveBeenCalledWith("w", "u");
    expect(f.membership.mock.invocationCallOrder[0]).toBeLessThan(f.activity.mock.invocationCallOrder[0]!);
  });
  it("rejects account switches before workspace data is loaded", async () => {
    const response = await GET(request("previous-user"), context);
    expect(response.status).toBe(409); expect(response.headers.get("cache-control")).toContain("no-store");
    expect(f.membership).not.toHaveBeenCalled(); expect(f.activity).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404])("retains denied status %i with no cached body or activity query", async status => {
    const error = Object.assign(new Error("denied"), { status });
    if (status === 401) f.user.mockRejectedValue(error); else f.membership.mockRejectedValue(error);
    const response = await GET(request(), context);
    expect(response.status).toBe(status); expect(response.headers.get("cache-control")).toContain("no-store"); expect(f.activity).not.toHaveBeenCalled();
  });
});
