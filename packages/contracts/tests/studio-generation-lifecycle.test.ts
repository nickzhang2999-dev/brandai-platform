import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ tx: vi.fn(), query: vi.fn(), read: vi.fn(), update: vi.fn(), generation: vi.fn(), output: vi.fn(), clear: vi.fn(), gate: vi.fn(), config: vi.fn(), context: vi.fn() }));
vi.mock("../../db/src/index", () => ({ prisma: { $transaction: f.tx }, Prisma: { TransactionIsolationLevel: { Serializable: "Serializable" }, PrismaClientKnownRequestError: class extends Error {} } }));
vi.mock("../../../apps/web/src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("../../../apps/web/src/lib/studio-generation-policy", () => ({ requireStudioGenerationServices: f.config, studioGenerationContextHash: f.context, validateStudioOutputSource: () => "bytes" }));
vi.mock("../../../apps/web/src/lib/studio-generation-artifacts", () => ({ requireArtifactWrite: f.gate }));
import { claimStudioGeneration, assertStudioGenerationReady, stageStudioGenerationOutput, finishStudioGeneration } from "../../../apps/web/src/lib/studio-generation-lifecycle";
import { ApiException } from "../../../apps/web/src/lib/api";
let row: any, tx: any;
beforeEach(() => {
  vi.resetAllMocks(); row = { id: "sgr_1", workspaceId: "w", projectId: "p", userId: "u", generationId: "g", contextHash: "same", status: "PENDING", providerStartedAt: null, expiresAt: new Date(Date.now() + 60000), jobData: { generationId: "g", assetUsages: [] } };
  f.context.mockResolvedValue("same"); f.read.mockImplementation(async () => ({ ...row }));
  f.update.mockImplementation(async ({ where, data }) => {
    if (row.status !== where.status || ("providerStartedAt" in where && row.providerStartedAt?.getTime() !== where.providerStartedAt?.getTime()) || (where.expiresAt?.gt && row.expiresAt <= where.expiresAt.gt)) return { count: 0 };
    Object.assign(row, data); return { count: 1 };
  });
  tx = { $queryRaw: f.query, studioGenerationRequest: { findUnique: f.read, updateMany: f.update }, generation: { update: f.generation, updateMany: f.generation }, studioGenerationOutput: { create: f.output, updateMany: f.clear } };
  f.tx.mockImplementation(async fn => { const prior = { ...row }; try { return await fn(tx); } catch (error) { row = prior; throw error; } });
});
describe("product single execution and private output atomicity", () => {
  it("revalidates accepted context and the same live claim after source I/O without re-claiming", async () => {
    const claim = await claimStudioGeneration(row); f.update.mockClear(); f.context.mockClear(); f.gate.mockClear();
    await assertStudioGenerationReady(claim!);
    expect(f.query).toHaveBeenCalled();
    expect(f.gate).toHaveBeenCalledWith(tx, "w", "p", "u");
    expect(f.context).toHaveBeenCalledWith(tx, "w", "p", row.jobData);
    expect(f.update).not.toHaveBeenCalled(); expect(row.status).toBe("RUNNING");
    // EditorDocument/WorkbenchProjectState are deliberately absent from this
    // DB fixture: ordinary later document autosaves are not a cancellation.
    expect(await assertStudioGenerationReady(claim!)).toBeUndefined();
  });
  it("rejects rules changed during source preparation with a readable 409 before dispatch", async () => {
    const claim = await claimStudioGeneration(row); f.context.mockResolvedValue("new-brand-policy");
    await expect(assertStudioGenerationReady(claim!)).rejects.toMatchObject({ status: 409 });
    expect(f.output).not.toHaveBeenCalled();
  });
  it("turns a removed accepted source into a readable context conflict without masking DB failures", async () => {
    const claim = await claimStudioGeneration(row);
    f.context.mockRejectedValueOnce(new ApiException(422, "Accepted image sources are no longer available."));
    await expect(assertStudioGenerationReady(claim!)).rejects.toMatchObject({ status: 409 });
    f.context.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(assertStudioGenerationReady(claim!)).rejects.toThrow("database unavailable");
  });
  it.each(["FAILED", "SUCCEEDED", "PENDING"])("rejects a claim that became %s during preflight", async status => {
    const claim = await claimStudioGeneration(row); row.status = status; f.context.mockClear();
    await expect(assertStudioGenerationReady(claim!)).rejects.toMatchObject({ status: 409 });
    expect(f.context).not.toHaveBeenCalled();
  });
  it("rejects replaced provider identity, expired requests, revoked membership and late DB work", async () => {
    const claim = await claimStudioGeneration(row);
    row.providerStartedAt = new Date(claim!.providerStartedAt!.getTime() + 1);
    await expect(assertStudioGenerationReady(claim!)).rejects.toMatchObject({ status: 409 });
    row.providerStartedAt = claim!.providerStartedAt; row.expiresAt = new Date(Date.now() - 1);
    await expect(assertStudioGenerationReady(claim!)).rejects.toMatchObject({ status: 409 });
    row.expiresAt = new Date(Date.now() + 60000); f.gate.mockRejectedValueOnce(Object.assign(new Error("membership revoked"), { status: 403 }));
    await expect(assertStudioGenerationReady(claim!)).rejects.toMatchObject({ status: 403 });
    const c = new AbortController(); f.context.mockImplementationOnce(async () => { c.abort(new Error("deadline")); return "same"; });
    await expect(assertStudioGenerationReady(claim!, c.signal)).rejects.toThrow("deadline");
  });
  it("checks expiry again after a slow hash query and honors abort before DB work", async () => {
    const claim = await claimStudioGeneration(row);
    f.read.mockImplementation(async () => row);
    f.context.mockImplementationOnce(async () => { row.expiresAt = new Date(Date.now() - 1); return "same"; });
    await expect(assertStudioGenerationReady(claim!)).rejects.toMatchObject({ status: 409 });
    const c = new AbortController(); c.abort(new Error("already expired")); f.tx.mockClear();
    await expect(assertStudioGenerationReady(claim!, c.signal)).rejects.toThrow("already expired");
    expect(f.tx).not.toHaveBeenCalled();
  });
  it("claims once, restores stored input and makes a duplicate/restarted provider invocation a no-op", async () => {
    const first = await claimStudioGeneration(row); expect(first?.status).toBe("RUNNING");
    expect(await claimStudioGeneration(row)).toBeNull(); expect(f.generation).toHaveBeenCalledTimes(1);
    expect(f.update).toHaveBeenCalledWith({ where: expect.objectContaining({ status: "PENDING", providerStartedAt: null, expiresAt: { gt: expect.any(Date) } }), data: { status: "RUNNING", providerStartedAt: expect.any(Date) } });
    expect(f.context).toHaveBeenCalledWith(tx, "w", "p", row.jobData);
  });
  it("rejects changed permissions or accepted source identity before claiming", async () => {
    f.context.mockResolvedValue("changed"); expect(await claimStudioGeneration(row)).toBeNull();
    expect(row.status).toBe("FAILED"); expect(row.providerStartedAt).toBeNull();
    expect(f.output).not.toHaveBeenCalled();
  });
  it("does not revive expired or terminal requests", async () => {
    row.expiresAt = new Date(Date.now() - 1); expect(await claimStudioGeneration(row)).toBeNull();
    row.status = "FAILED"; expect(await claimStudioGeneration(row)).toBeNull(); expect(f.generation).not.toHaveBeenCalled();
  });
  it("commits private bytes with success in one transaction; no public Version exists in this boundary", async () => {
    const claim = await claimStudioGeneration(row);
    expect(await stageStudioGenerationOutput(claim!, { imageUrl: "data:image/png;base64,YWJjZA==", width: 20, height: 10, params: { studioPostprocess: {} } }, 0)).toBe("sgr_1-0");
    expect(row.status).toBe("SUCCEEDED"); expect(f.output).toHaveBeenCalledWith({ data: expect.objectContaining({ id: "sgr_1-0", requestId: "sgr_1", workspaceId: "w", projectId: "p", params: { studioPostprocess: {}, studioSourceRetention: "bytes" } }) });
    expect(await finishStudioGeneration(claim!, "FAILED", new Error("late watchdog"))).toBe(false);
    expect(await finishStudioGeneration(claim!, "SUCCEEDED")).toBe(true); expect(f.clear).not.toHaveBeenCalled();
  });
  it("rolls back success if staging fails and rejects expired late output before writing raw bytes", async () => {
    const claim = await claimStudioGeneration(row); f.output.mockRejectedValue(new Error("database full"));
    await expect(stageStudioGenerationOutput(claim!, { imageUrl: "data:image/png;base64,YWJjZA==", width: 20, height: 10, params: {} }, 0)).rejects.toThrow("database full");
    expect(row.status).toBe("RUNNING"); row.expiresAt = new Date(Date.now() - 1); f.output.mockClear();
    await expect(stageStudioGenerationOutput(claim!, { imageUrl: "data:image/png;base64,YWJjZA==", width: 20, height: 10, params: {} }, 0)).rejects.toThrow(); expect(f.output).not.toHaveBeenCalled();
  });
  it("terminal failure clears private output and never records provider secrets", async () => {
    const claim = await claimStudioGeneration(row); expect(await finishStudioGeneration(claim!, "FAILED", "Bearer private-secret")).toBe(true);
    expect(row.error).not.toContain("private-secret"); expect(f.clear).toHaveBeenCalledWith({ where: { requestId: "sgr_1" }, data: { imageUrl: null } });
    expect(await finishStudioGeneration(claim!, "SUCCEEDED")).toBe(false);
  });
});
