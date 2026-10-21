import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ find: vi.fn(), count: vi.fn(), create: vi.fn(), asset: vi.fn(), lock: vi.fn(), permission: vi.fn(), enabled: vi.fn(), enqueue: vi.fn() }));
vi.mock("@brandai/db", () => ({ prisma: { $transaction: async (work: (tx: unknown) => unknown) => work({
  $executeRaw: f.lock, asyncTask: { findUnique: f.find, count: f.count, create: f.create }, asset: { findFirst: f.asset },
}) } }));
vi.mock("@/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("@/lib/studio-materials", () => ({ requireStudioMaterialProject: f.permission }));
vi.mock("@/lib/studio-copywriting-provider", () => ({ copywritingEnabled: f.enabled }));
vi.mock("@/lib/studio-copywriting-queue", () => ({ enqueueStudioCopywriting: f.enqueue }));
import { submitCopywriting, copyTaskId } from "@/lib/studio-copywriting";
const request = { mutationId: "23d272a3-acce-49a0-9c20-32a31c3a2837", prompt: "写文案" };
let saved: any;
beforeEach(() => {
  vi.resetAllMocks(); saved = undefined; f.enabled.mockReturnValue(true); f.count.mockResolvedValue(0);
  f.find.mockImplementation(async () => saved);
  f.create.mockImplementation(async ({ data }) => (saved = { ...data, status: "PENDING", createdAt: new Date(), error: null, resultJson: null }));
});
it("persists before returning, without waiting for Redis, and reuses an identical receipt", async () => {
  const first = await submitCopywriting("w", "p", "u", request);
  // PostgreSQL JSONB may return keys in a different order.
  saved.inputJson.request = Object.fromEntries(Object.entries(saved.inputJson.request).reverse());
  expect(await submitCopywriting("w", "p", "u", request)).toEqual(first);
  expect(f.create).toHaveBeenCalledTimes(1); expect(f.enqueue).not.toHaveBeenCalled();
  expect(f.permission).toHaveBeenCalledWith("w", "u", "p", true);
  expect(saved.expiresAt.getTime()).toBeGreaterThan(Date.now());
});
it("rejects reuse of a mutation id with changed content", async () => {
  await submitCopywriting("w", "p", "u", request);
  await expect(submitCopywriting("w", "p", "u", { ...request, prompt: "changed" })).rejects.toMatchObject({ status: 409 });
  expect(f.create).toHaveBeenCalledTimes(1);
});
it("does not queue for missing permission or missing provider configuration", async () => {
  f.permission.mockRejectedValueOnce(new Error("denied"));
  await expect(submitCopywriting("w", "p", "u", request)).rejects.toThrow("denied");
  f.enabled.mockReturnValue(false);
  await expect(submitCopywriting("w", "p", "u", request)).rejects.toMatchObject({ status: 503 });
  expect(f.create).not.toHaveBeenCalled();
});
it("rejects foreign or removed reference assets before a paid job exists", async () => {
  f.asset.mockResolvedValue(null);
  await expect(submitCopywriting("w", "p", "u", { ...request, image: { assetId: "foreign", assetSha256: "a".repeat(64) } })).rejects.toMatchObject({ status: 422 });
  expect(f.asset).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId: "w", projectLinks: { some: { projectId: "p", project: { workspaceId: "w" } } } }) }));
  expect(f.create).not.toHaveBeenCalled();
});
it("bounds active work and short-term request frequency", async () => {
  f.count.mockResolvedValueOnce(1);
  await expect(submitCopywriting("w", "p", "u", request)).rejects.toMatchObject({ status: 409 });
  f.count.mockResolvedValueOnce(0).mockResolvedValueOnce(5);
  await expect(submitCopywriting("w", "p", "u", request)).rejects.toMatchObject({ status: 429 });
  expect(f.create).not.toHaveBeenCalled();
});
it("isolates idempotency identities across projects, workspaces, and accounts", () => {
  const ids = [copyTaskId("w", "p", "u", request.mutationId), copyTaskId("other", "p", "u", request.mutationId), copyTaskId("w", "other", "u", request.mutationId), copyTaskId("w", "p", "other", request.mutationId)];
  expect(new Set(ids).size).toBe(4);
});
