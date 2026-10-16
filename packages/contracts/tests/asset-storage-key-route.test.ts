import { beforeEach, describe, expect, it, vi } from "vitest";

// Execute real handlers, authentication, workspace role ranking, key validation
// and serialization. Only session, DB and service I/O are synthetic; no network
// or real provider request is made by these authorization tests.
const f = vi.hoisted(() => ({
  session: vi.fn(), user: vi.fn(), workspace: vi.fn(), membership: vi.fn(),
  create: vi.fn(), storage: vi.fn(),
}));
vi.mock("../../db/src/index", () => ({ prisma: {
  user: { findUnique: f.user },
  brandWorkspace: { findUnique: f.workspace },
  membership: { findUnique: f.membership },
  asset: { create: f.create },
} }));
vi.mock("../../../apps/web/src/auth", () => ({ auth: f.session }));
vi.mock("@/lib/api", async () => import("../../../apps/web/src/lib/api"));
vi.mock("@/lib/workspace", async () => import("../../../apps/web/src/lib/workspace"));
vi.mock("@/lib/assets", async () => import("../../../apps/web/src/lib/assets"));
vi.mock("@/lib/asset-storage-key", async () => import("../../../apps/web/src/lib/asset-storage-key"));
vi.mock("@/lib/settings", () => ({ getEffectiveStorage: f.storage }));

import { POST as createAsset } from "../../../apps/web/src/app/api/workspaces/[wsId]/assets/route";

const params = { params: Promise.resolve({ wsId: "brand-a" }) };
function request(body: unknown, path = "assets") {
  return new Request(`http://127.0.0.1/api/workspaces/brand-a/${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}
function assetInput(storageKey = "brand-a/uploads/uuid.png") {
  return { workspaceId: "brand-a", category: "PRODUCT", fileName: "产品.png",
    mimeType: "image/png", sizeBytes: 42, storageKey };
}

beforeEach(() => {
  vi.resetAllMocks();
  f.session.mockResolvedValue({ user: { id: "user-a" } });
  f.user.mockResolvedValue({ isActive: true });
  f.workspace.mockResolvedValue({ id: "brand-a", ownerId: "owner-a", name: "品牌 A" });
  f.membership.mockResolvedValue({ id: "membership-a", role: "EDITOR" });
  f.storage.mockResolvedValue({ publicUrl: "https://cdn.invalid/bucket///" });
  f.create.mockImplementation(async ({ data }) => ({ ...data, id: "asset-new",
    createdAt: new Date("2026-10-16T00:00:00Z"), isFavorite: false, availableForGeneration: true }));
});

describe("client asset storage key boundary", () => {
  it.each([
    "brand-b/uploads/secret.png", "brand-ab/uploads/secret.png", "/brand-a/upload.png",
    "https://source.invalid/brand-a/upload.png", "brand-a/../brand-b/secret.png",
    "brand-a/upload..png", "brand-a/\\../brand-b/secret.png", "brand-a/%2e%2e/brand-b/secret.png",
    "brand-a/%252e%252e/brand-b/secret.png", "brand-a/file.png?next=brand-b", "brand-a/file.png#other",
    "brand-a/./file.png", "brand-a//file.png", "brand-a/", "brand-a/\nfile.png", "",
  ])("rejects unsafe key %j before storage lookup or DB mutation", async key => {
    const response = await createAsset(request(assetInput(key)), params);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ details: { fieldErrors: { storageKey: expect.any(Array) } } });
    expect(f.storage).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.membership).toHaveBeenCalledWith({
      where: { userId_workspaceId: { userId: "user-a", workspaceId: "brand-a" } }, select: { role: true },
    });
  });

  it("does not let a body workspace override the authenticated path workspace", async () => {
    const response = await createAsset(request({ ...assetInput("brand-b/uploads/secret.png"), workspaceId: "brand-b" }), params);
    expect(response.status).toBe(422);
    expect(f.create).not.toHaveBeenCalled();
    expect(f.storage).not.toHaveBeenCalled();
  });

  it("persists the validated workspace key without changing upload metadata", async () => {
    const response = await createAsset(request({ ...assetInput(), workspaceId: "body-spoof", libraryKind: "TEMPLATE" }), params);
    expect(response.status).toBe(201);
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.create).toHaveBeenCalledWith({ data: {
      workspaceId: "brand-a", category: "PRODUCT", libraryKind: "TEMPLATE", fileName: "产品.png",
      storageKey: "brand-a/uploads/uuid.png", url: "https://cdn.invalid/bucket/brand-a/uploads/uuid.png",
      mimeType: "image/png", sizeBytes: 42, source: "UPLOAD",
    } });
    expect(await response.json()).toMatchObject({ id: "asset-new", workspaceId: "brand-a",
      fileName: "产品.png", libraryKind: "TEMPLATE", createdAt: "2026-10-16T00:00:00.000Z" });
  });

  it("rejects nonmembership before validation so a valid prefix does not grant access", async () => {
    f.membership.mockResolvedValue(null);
    const response = await createAsset(request(assetInput()), params);
    expect(response.status).toBe(404);
    expect(f.storage).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
  });

  it("keeps schema validation and EDITOR requirements on asset creation", async () => {
    const missing = { ...assetInput(), storageKey: null };
    expect((await createAsset(request(missing), params)).status).toBe(422);
    f.membership.mockResolvedValue({ role: "VIEWER" });
    expect((await createAsset(request(assetInput()), params)).status).toBe(403);
    expect(f.storage).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
  });
});
