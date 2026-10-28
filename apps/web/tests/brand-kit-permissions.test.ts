import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ task: vi.fn(), user: vi.fn(), workspace: vi.fn(), membership: vi.fn(), assets: vi.fn() }));
vi.mock("../../../packages/db/src/index", () => ({ prisma: {
  asyncTask: { findFirst: db.task }, user: { findUnique: db.user },
  brandWorkspace: { findUnique: db.workspace }, membership: { findUnique: db.membership }, asset: { findMany: db.assets },
} }));
vi.mock("@/lib/api", () => ({ ApiException: class extends Error {
  constructor(public status: number, message: string) { super(message); }
} }));

import { requireBrandKitTaskPermission } from "@/lib/brand-kit-permissions";

const taskId = "bkit_synthetic-receipt", workspaceId = "synthetic-workspace", userId = "synthetic-editor";
let task: { id: string; workspaceId: string; kind: string; inputJson: unknown } | null;
let account: { isActive: boolean } | null;
let workspace: { ownerId: string } | null;
let role: string | null;
let assets: { id: string; workspaceId: string; deprecatedAt: Date | null; availableForGeneration: boolean; category: string }[];

beforeEach(() => {
  vi.resetAllMocks();
  task = { id: taskId, workspaceId, kind: "RECOGNIZE", inputJson: { userId } };
  account = { isActive: true }; workspace = { ownerId: "synthetic-owner" }; role = "EDITOR";
  assets = [{ id: "synthetic-source", workspaceId, deprecatedAt: null, availableForGeneration: true, category: "LOGO" }];
  db.task.mockImplementation(({ where }) => task && task.id === where.id && task.workspaceId === where.workspaceId
    && where.kind.in.includes(task.kind) ? task : null);
  db.user.mockImplementation(({ where }) => where.id === userId ? account : null);
  db.workspace.mockImplementation(({ where }) => where.id === workspaceId ? workspace : null);
  db.membership.mockImplementation(({ where }) => where.userId_workspaceId.userId === userId
    && where.userId_workspaceId.workspaceId === workspaceId && role ? { role } : null);
  db.assets.mockImplementation(({ where }) => assets.filter(asset => asset.workspaceId === where.workspaceId
    && where.id.in.includes(asset.id) && asset.deprecatedAt === where.deprecatedAt
    && asset.availableForGeneration === where.availableForGeneration
    && (!where.category || asset.category === where.category)).map(({ id }) => ({ id })));
});

const check = () => requireBrandKitTaskPermission(taskId, workspaceId, ["synthetic-source"]);

describe("Brand Kit worker permission revalidation", () => {
  it.each([undefined, "legacy-receipt"])("preserves legacy task behavior without new queries: %s", async legacyId => {
    await requireBrandKitTaskPermission(legacyId, "old-workspace", []);
    for (const query of Object.values(db)) expect(query).not.toHaveBeenCalled();
  });

  it("allows the current editor and reads only permission fields, never asset URLs", async () => {
    await expect(check()).resolves.toBeUndefined();
    expect(db.membership).toHaveBeenCalledOnce();
    expect(db.user).toHaveBeenCalledWith({ where: { id: userId }, select: { isActive: true } });
    expect(db.assets.mock.calls[0]?.[0].select).toEqual({ id: true });
  });

  it("allows an active owner without a Membership row, matching the existing role guard", async () => {
    workspace = { ownerId: userId }; role = null;
    await expect(check()).resolves.toBeUndefined();
    expect(db.membership).not.toHaveBeenCalled();
  });

  it.each([null, "VIEWER", "REVIEWER"])("rejects a removed or downgraded member: %s", async removedRole => {
    role = removedRole;
    await expect(check()).rejects.toMatchObject({ status: 403, message: "品牌解析任务的编辑权限已失效，已停止处理。" });
    expect(db.assets).not.toHaveBeenCalled();
  });

  it.each([null, { isActive: false }])("rejects a deleted or disabled account even if it owns the workspace", async state => {
    workspace = { ownerId: userId }; account = state;
    await expect(check()).rejects.toMatchObject({ status: 403, message: "品牌解析任务的发起账号已不可用，已停止处理。" });
    expect(db.workspace).not.toHaveBeenCalled();
  });

  it("rejects missing workspace or a receipt from another workspace", async () => {
    workspace = null;
    await expect(check()).rejects.toMatchObject({ status: 403 });
    task!.workspaceId = "foreign-workspace"; db.user.mockClear();
    await expect(check()).rejects.toMatchObject({ status: 403 });
    expect(db.user).not.toHaveBeenCalled();
  });

  it.each([null, {}, { userId: 3 }, { userId: "" }, [userId]])("does not accept missing or malformed task actor metadata: %s", async input => {
    task!.inputJson = input;
    await expect(check()).rejects.toMatchObject({ status: 403 });
    expect(db.user).not.toHaveBeenCalled();
  });

  it("does not treat missing or another-kind bkit receipts as legacy tasks", async () => {
    task!.kind = "EDIT";
    await expect(check()).rejects.toMatchObject({ status: 403 });
    task = null;
    await expect(check()).rejects.toMatchObject({ status: 403 });
  });

  it.each([{ deprecatedAt: new Date(0) }, { availableForGeneration: false }, { workspaceId: "foreign-workspace" }, { id: "other-source" }])(
    "rejects a removed, unavailable, foreign or missing source: %s", async patch => {
      Object.assign(assets[0]!, patch);
      await expect(check()).rejects.toMatchObject({ status: 409, message: "原素材已被移除、停用或不再属于当前品牌，已停止处理。" });
    });

  it("rechecks permission and assets on each call instead of caching a pre-model decision", async () => {
    await check();
    assets[0]!.deprecatedAt = new Date();
    await expect(check()).rejects.toMatchObject({ status: 409 });
    assets[0]!.deprecatedAt = null; role = null;
    await expect(check()).rejects.toMatchObject({ status: 403 });
  });

  it("keeps the manual route's VI_DOC and single-source boundary", async () => {
    task!.kind = "PARSE_MANUAL";
    await expect(check()).rejects.toMatchObject({ status: 409 });
    assets[0]!.category = "VI_DOC";
    await expect(check()).resolves.toBeUndefined();
    await expect(requireBrandKitTaskPermission(taskId, workspaceId, ["synthetic-source", "other-source"])).rejects.toMatchObject({ status: 409 });
  });

  it("validates the complete nonempty bounded source set, allowing duplicate request IDs", async () => {
    await expect(requireBrandKitTaskPermission(taskId, workspaceId, ["synthetic-source", "synthetic-source"])).resolves.toBeUndefined();
    for (const ids of [[], [""], Array.from({ length: 51 }, (_, index) => `source-${index}`)]) {
      await expect(requireBrandKitTaskPermission(taskId, workspaceId, ids)).rejects.toMatchObject({ status: 409 });
    }
    await expect(requireBrandKitTaskPermission(taskId, workspaceId, ["synthetic-source", "foreign-source"])).rejects.toMatchObject({ status: 409 });
  });
});
