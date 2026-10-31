import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ memberships: vi.fn(), workspaces: vi.fn() }));
vi.mock("../../../packages/db/src/index", () => ({ prisma: { membership: { findMany: f.memberships }, brandWorkspace: { findMany: f.workspaces } } }));
vi.mock("../src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
import { getWorkbenchSession } from "../src/lib/workbench-session";

beforeEach(() => {
  vi.resetAllMocks();
  f.memberships.mockResolvedValue([{ workspaceId: "shared", role: "VIEWER" }]);
  f.workspaces.mockResolvedValue([
    { id: "owned", name: "自有品牌", ownerId: "u" },
    { id: "shared", name: "成员品牌", ownerId: "other" },
  ]);
});

describe("workbench multi-brand session scope (unit DB fixtures)", () => {
  it("lists both owned and accessible member brands without creating a default on GET", async () => {
    expect(await getWorkbenchSession({ id: "u", name: "owner" })).toEqual({ user: { id: "u", name: "owner" },
      workspaces: [{ id: "owned", name: "自有品牌", role: "OWNER", canDelete: true }, { id: "shared", name: "成员品牌", role: "VIEWER", canDelete: false }], activeWorkspaceId: "owned" });
    expect(f.memberships).toHaveBeenCalledWith({ where: { userId: "u" }, select: { workspaceId: true, role: true } });
    expect(f.workspaces).toHaveBeenCalledWith({ where: { OR: [{ ownerId: "u" }, { id: { in: ["shared"] } }] },
      select: { id: true, name: true, ownerId: true }, orderBy: { createdAt: "asc" } });
  });
  it("keeps an explicit member brand selected after refresh regardless of the default owner order", async () => {
    expect(await getWorkbenchSession({ id: "u" }, "shared", true)).toMatchObject({ activeWorkspaceId: "shared", user: { name: "" } });
  });
  it("rejects an inaccessible pinned workspace instead of silently falling back to another brand", async () => {
    await expect(getWorkbenchSession({ id: "u" }, "foreign", true)).rejects.toMatchObject({ status: 404 });
  });
  it("discards an old account preference cookie while retaining the current user's member boundary", async () => {
    expect(await getWorkbenchSession({ id: "u" }, "previous-account-cookie", false)).toMatchObject({ activeWorkspaceId: "owned" });
  });
  it("returns an empty session for a new user, allowing explicit creation instead of writing on GET", async () => {
    f.memberships.mockResolvedValue([]); f.workspaces.mockResolvedValue([]);
    expect(await getWorkbenchSession({ id: "u" })).toEqual({ user: { id: "u", name: "" }, workspaces: [], activeWorkspaceId: null });
    expect(f.workspaces).toHaveBeenCalledWith(expect.objectContaining({ where: { OR: [{ ownerId: "u" }, { id: { in: [] } }] } }));
  });
});
