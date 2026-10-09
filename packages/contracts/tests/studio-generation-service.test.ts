import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ tx: vi.fn(), gate: vi.fn(), projectGate: vi.fn(), read: vi.fn(), many: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn(), gen: vi.fn(), clear: vi.fn(), query: vi.fn(), config: vi.fn(), prepare: vi.fn(), quota: vi.fn(), enqueue: vi.fn(), results: vi.fn() }));
vi.mock("../../db/src/index", () => ({ prisma: { $transaction: f.tx, studioGenerationRequest: { findUnique: f.read, findMany: f.many }, project: { findFirst: async () => ({ id: "p" }) } }, Prisma: { TransactionIsolationLevel: { Serializable: "Serializable" }, PrismaClientKnownRequestError: class extends Error {} } }));
vi.mock("../../../apps/web/src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("../../../apps/web/src/lib/workspace", () => ({ requireWorkspaceRole: f.gate }));
vi.mock("../../../apps/web/src/lib/studio-materials", () => ({ requireStudioMaterialProject: f.projectGate }));
vi.mock("../../../apps/web/src/lib/studio-generation-policy", () => ({ prepareStudioGeneration: f.prepare, requireStudioGenerationServices: f.config, hashStudioPayload: (v: unknown) => JSON.stringify(v), assertStudioGenerationCapacity: (n: number) => { if(n >=4) throw new Error("capacity"); } }));
vi.mock("../../../apps/web/src/lib/quota", () => ({ reserveGenerationQuotaInTransaction: f.quota }));
vi.mock("../../../apps/web/src/lib/studio-generation-queue", () => ({ enqueueStudioGeneration: f.enqueue }));
vi.mock("../../../apps/web/src/lib/studio-generation-artifacts", () => ({ readStudioGenerationResults: f.results }));
import { submitStudioGeneration, readStudioGeneration, expireStudioGenerations, dispatchStudioGenerations } from "../../../apps/web/src/lib/studio-generation";
const input = { projectId: "p", mutationId: "831a0280-2cf1-41ba-ac94-621053c4a4c6", prompt: "tree", sizeSelection: { ratioKey: "1:1", resolutionTier: "1K" }, workflowRevision: 0, documentRevision: 0 };
let tx: any, row: any;
beforeEach(() => {
  vi.resetAllMocks(); row = undefined; f.read.mockResolvedValue(null); f.many.mockResolvedValue([]); f.count.mockResolvedValue(0); f.gate.mockResolvedValue({ role: "OWNER" });
  f.prepare.mockResolvedValue({ contextHash: "context", generationData: { projectId: "p", workspaceId: "w" }, jobData: { workspaceId: "w", versionCount: 1 } }); f.quota.mockResolvedValue({ id: "g" }); f.enqueue.mockResolvedValue(false);
  f.create.mockImplementation(async ({ data }) => row = { ...data, status: "PENDING", error: null });
  tx = { $queryRaw: f.query, studioGenerationRequest: { findUnique: f.read, findMany: f.many, count: f.count, create: f.create, updateMany: f.update }, generation: { updateMany: f.gen }, studioGenerationOutput: { updateMany: f.clear } };
  f.tx.mockImplementation(fn => fn(tx)); f.results.mockResolvedValue({ resultState: "NOT_REQUESTED", results: [], archiveError: null, archiveExpiresAt: null, archiveProcessingExpiresAt: null, canRetryArchive: false });
});
describe("generation acceptance and DB outbox (transaction fixtures)", () => {
  it("accepts once with quota and receipt in the exact same SERIALIZABLE transaction even when Redis is down", async () => {
    const first = await submitStudioGeneration("w", "u", input);
    expect(first).toMatchObject({ status: "PENDING", projectId: "p", generationId: "g" });
    expect(f.quota).toHaveBeenCalledWith(tx, { workspaceId: "w", make: expect.any(Function) });
    expect(f.create.mock.calls[0][0].data).toMatchObject({ workspaceId: "w", userId: "u", projectId: "p", mutationId: input.mutationId, jobData: { generationId: "g", workspaceId: "w", versionCount: 1 } });
    expect(f.tx).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable", timeout: 15000 });
    f.read.mockResolvedValue(row); f.many.mockImplementation(async ({ where }) => where.userId ? [row] : []);
    expect(await submitStudioGeneration("w", "u", input)).toMatchObject({ requestId: first.requestId }); expect(f.quota).toHaveBeenCalledTimes(1); expect(f.create).toHaveBeenCalledTimes(1);
  });
  it("rejects identity reuse for a different prompt and never allocates an extra generation", async () => {
    await submitStudioGeneration("w", "u", input); f.read.mockResolvedValue(row);
    await expect(submitStudioGeneration("w", "u", { ...input, prompt: "other" })).rejects.toMatchObject({ status: 409 }); expect(f.quota).toHaveBeenCalledTimes(1);
  });
  it("fails role/config/selection/quota gates before durable receipt or enqueue", async () => {
    f.gate.mockRejectedValueOnce({ status: 403 }); await expect(submitStudioGeneration("w", "u", input)).rejects.toMatchObject({ status: 403 });
    f.config.mockRejectedValueOnce({ status: 503 }); await expect(submitStudioGeneration("w", "u", input)).rejects.toMatchObject({ status: 503 });
    f.prepare.mockRejectedValueOnce({ status: 422 }); await expect(submitStudioGeneration("w", "u", input)).rejects.toMatchObject({ status: 422 });
    f.quota.mockRejectedValueOnce({ status: 402 }); await expect(submitStudioGeneration("w", "u", input)).rejects.toMatchObject({ status: 402 });
    expect(f.create).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
  });
  it("current-user history hides private jobData and a downgraded viewer cannot retry archive", async () => {
    await submitStudioGeneration("w", "u", input); f.results.mockResolvedValue({ resultState: "FAILED", results: [], archiveError: "retry", archiveExpiresAt: null, archiveProcessingExpiresAt: null, canRetryArchive: true });
    f.gate.mockResolvedValue({ role: "VIEWER" }); f.many.mockImplementation(async ({ where }) => where.userId ? [row] : []);
    const view = await readStudioGeneration("w", "u", { projectId: "p", requestId: row.id }); expect(view).toMatchObject({ canRetryArchive: false }); expect(JSON.stringify(view)).not.toContain("jobData");
    expect(f.many).toHaveBeenLastCalledWith(expect.objectContaining({ where: { workspaceId: "w", userId: "u", projectId: "p", id: row.id } }));
  });
  it("expiry atomically terminalizes unclaimed/claimed tasks and clears only outputs of the winner", async () => {
    f.many.mockResolvedValue([{ id: "r", generationId: "g", providerStartedAt: new Date() }]); f.update.mockResolvedValue({ count: 1 }); await expireStudioGenerations(); expect(f.gen).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) })); expect(f.clear).toHaveBeenCalled();
    f.clear.mockClear(); f.update.mockResolvedValue({ count: 0 }); await expireStudioGenerations(); expect(f.clear).not.toHaveBeenCalled();
  });
  it("outbox dispatch only selects unclaimed PENDING tasks under a bounded deadline", async () => {
    await dispatchStudioGenerations(); expect(f.many).toHaveBeenLastCalledWith({ where: { status: "PENDING", providerStartedAt: null, expiresAt: { gt: expect.any(Date) } }, take: 32, orderBy: { createdAt: "asc" } });
  });
});
