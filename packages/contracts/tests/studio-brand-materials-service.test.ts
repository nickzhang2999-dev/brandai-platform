import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ role: vi.fn(), project: vi.fn(), asset: vi.fn(), many: vi.fn(), transaction: vi.fn(), query: vi.fn(), count: vi.fn(), upsert: vi.fn(), link: vi.fn(), task: vi.fn(), expire: vi.fn(), enqueue: vi.fn() }));
vi.mock("../../db/src/index", () => ({ prisma: { asset: { findFirst: f.asset, findMany: f.many }, $transaction: f.transaction, asyncTask: { updateMany: f.expire } } }));
vi.mock("../../../apps/web/src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("../../../apps/web/src/lib/workspace", () => ({ requireWorkspaceRole: f.role }));
vi.mock("../../../apps/web/src/lib/studio-materials", () => ({ requireStudioMaterialProject: f.project }));
vi.mock("../../../apps/web/src/lib/studio-brand-materials-queue", () => ({ enqueueStudioBrandMaterial: f.enqueue }));
import { listStudioBrandMaterials, mutateStudioBrandMaterial, readStudioBrandMaterial, trustedStudioBrandAsset } from "../../../apps/web/src/lib/studio-brand-materials";
import { studioBrandMaterialSourceDigest } from "../../../apps/web/src/lib/studio-brand-materials-trust";
let asset: any;
const sha = "b".repeat(64);
beforeEach(() => {
  vi.resetAllMocks();
  asset = { id: "a", workspaceId: "w", storageKey: "w/a.png", url: "https://store.invalid/w/a.png", mimeType: "image/png", fileName: "产品.png", sizeBytes: 100,
    generationVersionId: null, libraryKind: "MATERIAL", createdAt: new Date("2026-10-14T00:00:00Z"), availableForGeneration: true, deprecatedAt: null,
    studioBrandMaterialReceipt: null, studioUploads: [], studioGeneratedMaterial: null };
  f.role.mockResolvedValue({ role: "EDITOR" }); f.project.mockResolvedValue(undefined); f.asset.mockImplementation(async () => structuredClone(asset)); f.many.mockResolvedValue([]);
  f.query.mockResolvedValue([{ id: "a", archivedAt: null }]); f.count.mockResolvedValue(0); f.enqueue.mockResolvedValue(false);
  f.upsert.mockImplementation(async ({ create }) => { asset.studioBrandMaterialReceipt = { ...create, task: { workspaceId: "w", status: "PENDING", kind: "STUDIO_MATERIAL_VERIFY" } }; });
  f.transaction.mockImplementation(fn => fn({ $queryRaw: f.query, asset: { findFirst: f.asset }, projectAsset: { upsert: f.link },
    studioBrandMaterialReceipt: { count: f.count, upsert: f.upsert }, asyncTask: { create: f.task } }));
});
function verified() {
  asset.studioBrandMaterialReceipt = { assetId: "a", taskId: "task", workspaceId: "w", sha256: sha, width: 10, height: 10, mimeType: "image/png",
    sourceDigest: studioBrandMaterialSourceDigest(asset), task: { workspaceId: "w", status: "SUCCEEDED", kind: "STUDIO_MATERIAL_VERIFY" } };
}

describe("brand-wide real library service decisions (simulated DB)", () => {
  it("returns paginated same-brand images, never an unbounded project upload list", async () => {
    f.many.mockResolvedValue([asset, { ...asset, id: "b", createdAt: new Date("2026-10-13T00:00:00Z") }]);
    const first = await listStudioBrandMaterials("w", "u", { limit: 1, search: "产品" });
    expect(first.items).toHaveLength(1); expect(first.items[0]!.material).toBeUndefined(); expect(first.nextCursor).toBeTruthy();
    expect(f.many).toHaveBeenCalledWith(expect.objectContaining({ take: 2, where: expect.objectContaining({ workspaceId: "w", deprecatedAt: null, availableForGeneration: true }), orderBy: [{ createdAt: "desc" }, { id: "desc" }] }));
    await listStudioBrandMaterials("w", "u", { cursor: first.nextCursor! });
    expect(f.many.mock.calls[1]![0].where.AND).toContainEqual({ OR: [{ createdAt: { lt: asset.createdAt } }, { createdAt: asset.createdAt, id: { lt: "a" } }] });
    await expect(listStudioBrandMaterials("w", "u", { cursor: "forged" })).rejects.toMatchObject({ status: 422 });
  });
  it("authorizes viewers for library browsing before querying, and editors for writes", async () => {
    f.role.mockRejectedValueOnce({ status: 404 }); await expect(listStudioBrandMaterials("other", "u", {})).rejects.toMatchObject({ status: 404 }); expect(f.many).not.toHaveBeenCalled();
    f.role.mockRejectedValueOnce({ status: 403 }); await expect(mutateStudioBrandMaterial("w", "viewer", "a", { operation: "verify" })).rejects.toMatchObject({ status: 403 }); expect(f.task).not.toHaveBeenCalled();
  });
  it("durably accepts verification even if Redis is unavailable, and retries only the same task", async () => {
    const one = await mutateStudioBrandMaterial("w", "u", "a", { operation: "verify" });
    const two = await mutateStudioBrandMaterial("w", "u", "a", { operation: "verify" });
    expect(one).toMatchObject({ assetId: "a", status: "PENDING" }); expect(one.taskId).toBe(two.taskId);
    expect(f.task).toHaveBeenCalledOnce(); expect(f.upsert).toHaveBeenCalledOnce(); expect(f.enqueue).toHaveBeenCalledWith(one.taskId);
    expect(f.query.mock.calls.some(([strings]) => strings.join("").includes("pg_advisory_xact_lock"))).toBe(true);
  });
  it("reuses one actual Asset in two same-brand projects with idempotent links", async () => {
    verified();
    const one = await mutateStudioBrandMaterial("w", "u", "a", { operation: "link", projectId: "one", assetSha256: sha });
    const two = await mutateStudioBrandMaterial("w", "u", "a", { operation: "link", projectId: "two", assetSha256: sha });
    expect(one.assetId).toBe(two.assetId); expect(f.link).toHaveBeenCalledTimes(2); expect(f.task).not.toHaveBeenCalled();
    expect(f.link.mock.calls.map(([args]) => args.create.projectId)).toEqual(["one", "two"]);
    expect(f.project).toHaveBeenCalledWith("w", "u", "two", true);
  });
  it("rejects forged hashes, unverified assets, archived projects and foreign/deleted IDs before linking", async () => {
    await expect(mutateStudioBrandMaterial("w", "u", "a", { operation: "link", projectId: "p", assetSha256: sha })).rejects.toMatchObject({ status: 409 });
    verified(); await expect(mutateStudioBrandMaterial("w", "u", "a", { operation: "link", projectId: "p", assetSha256: "c".repeat(64) })).rejects.toMatchObject({ status: 422 });
    f.query.mockResolvedValueOnce([{ archivedAt: new Date() }]); await expect(mutateStudioBrandMaterial("w", "u", "a", { operation: "link", projectId: "p", assetSha256: sha })).rejects.toMatchObject({ status: 409 });
    f.asset.mockResolvedValueOnce(null); await expect(mutateStudioBrandMaterial("w", "u", "foreign", { operation: "link", projectId: "p", assetSha256: sha })).rejects.toMatchObject({ status: 404 });
    expect(f.link).not.toHaveBeenCalled();
  });
  it("never revives stale, disabled or failed proofs and preserves an unverified row", async () => {
    verified(); expect(trustedStudioBrandAsset(asset)).toBeTruthy();
    asset.sizeBytes += 1; expect(trustedStudioBrandAsset(asset)).toBeNull();
    expect(await readStudioBrandMaterial("w", "u", "a")).toEqual({ assetId: "a", status: "UNVERIFIED" });
    verified(); asset.availableForGeneration = false; expect(trustedStudioBrandAsset(asset)).toBeNull();
    asset.availableForGeneration = true; asset.studioBrandMaterialReceipt.task.status = "FAILED";
    expect(await readStudioBrandMaterial("w", "u", "a")).toMatchObject({ status: "FAILED", error: expect.any(String) });
  });
  it("trusts same-brand upload receipts from another source project, never foreign tasks", async () => {
    asset.studioUploads = [{ workspaceId: "w", projectId: "other-project", assetId: "a", sha256: sha, width: 10, height: 10, mimeType: "image/png", objectKey: "w/a.png",
      task: { workspaceId: "w", kind: "STUDIO_UPLOAD", status: "SUCCEEDED" } }];
    expect(trustedStudioBrandAsset(asset)?.assetId).toBe("a");
    asset.studioUploads[0].task.workspaceId = "foreign"; expect(trustedStudioBrandAsset(asset)).toBeNull();
  });
});
