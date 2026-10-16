import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ find: vi.fn(), updateMany: vi.fn(), update: vi.fn(), transaction: vi.fn(), latest: vi.fn(), versionUpdate: vi.fn(), versionGet: vi.fn(),
  validate: vi.fn(), dispatch: vi.fn(), compliance: vi.fn(), precheck: vi.fn(), serialize: vi.fn() }));
vi.mock("../../../packages/db/src/index", () => ({ Prisma: {}, prisma: { asyncTask: { findUnique: f.find, updateMany: f.updateMany, update: f.update, findFirst: f.latest },
  generationVersion: { updateMany: f.versionUpdate, findUniqueOrThrow: f.versionGet }, $transaction: f.transaction } }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/queue", () => ({ connection: {}, queuePrefix: "test" }));
vi.mock("../src/lib/workspace", () => ({ requireWorkspaceRole: vi.fn() }));
vi.mock("../src/lib/compliance-task-queue", () => ({ enqueueComplianceTask: vi.fn() }));
vi.mock("../src/lib/compliance-tasks", async () => ({
  ...await vi.importActual<any>("../src/lib/compliance-tasks"), validateComplianceTaskSource: f.validate, dispatchComplianceTasks: f.dispatch,
}));
vi.mock("../src/lib/precheck", () => ({ runPrecheck: f.precheck }));
vi.mock("../src/lib/compliance", () => ({ runComplianceCheck: f.compliance }));
vi.mock("../src/lib/generations", () => ({ serializeVersion: f.serialize }));
import { ApiException } from "../src/lib/api";
import { runComplianceTaskJob } from "../src/lib/workers/compliance-task.worker";
import { COMPLIANCE_TASK_ERROR, COMPLIANCE_TASK_EXPIRED } from "../src/lib/compliance-tasks";
import { parseAsyncTaskResult, TaskState } from "../../../packages/contracts/src/async-task";
let row: any, version: any;
const report = { overall: "PASS", textResults: [], visualResults: [], checkedAt: "2026-10-16T00:00:00.000Z" };
const output = { results: [], report };
const run = () => runComplianceTaskJob({ data: { taskId: "t", jobId: "j" } } as any);
beforeEach(() => {
  vi.resetAllMocks();
  f.validate.mockResolvedValue(undefined);
  row = { id: "t", workspaceId: "w", kind: "COMPLIANCE_PRECHECK", jobId: "j", status: "PENDING", progress: 0, resultJson: null, error: null,
    inputJson: { userId: "u", text: "Brief", projectId: "p", generationId: "g", versionId: "v", imageUrl: "https://test/image.png" },
    expiresAt: new Date(Date.now() + 6 * 60_000), createdAt: new Date(), updatedAt: new Date(), refCount: 0 };
  version = { id: "v", generationId: "g", imageUrl: "https://test/image.png", index: 0, width: 1024, height: 1024, params: {}, createdAt: "2026-10-16T00:00:00.000Z", complianceReport: null };
  f.find.mockImplementation(async () => structuredClone(row));
  f.updateMany.mockImplementation(async ({ where, data }) => {
    const matches = where.id === row.id && where.jobId === row.jobId
      && (typeof where.status === "string" ? where.status === row.status : where.status.in.includes(row.status))
      && (!where.expiresAt || row.expiresAt > where.expiresAt.gt);
    if (!matches) return { count: 0 }; Object.assign(row, data); return { count: 1 };
  });
  f.update.mockImplementation(async ({ data }) => { Object.assign(row, data); return structuredClone(row); });
  f.versionUpdate.mockImplementation(async ({ data }) => { Object.assign(version, data); return { count: 1 }; });
  f.versionGet.mockImplementation(async () => structuredClone(version)); f.serialize.mockImplementation(value => value);
  f.latest.mockResolvedValue({ id: "t" }); f.compliance.mockResolvedValue(output); f.precheck.mockResolvedValue({ ...output, ok: true, blocking: false, latencyMs: 1 });
  f.transaction.mockImplementation(async callback => {
    const savedRow = structuredClone(row), savedVersion = structuredClone(version);
    try { return await callback({ asyncTask: { updateMany: f.updateMany, update: f.update, findFirst: f.latest }, generationVersion: { updateMany: f.versionUpdate, findUniqueOrThrow: f.versionGet } }); }
    catch (error) { row = savedRow; version = savedVersion; throw error; }
  });
});
afterEach(() => vi.useRealTimers());
describe("durable compliance worker lifecycle", () => {
  it.each(["COMPLIANCE_PRECHECK", "GENERATION_PRECHECK"])("persists %s result for task GET independently of Redis", async kind => {
    row.kind = kind; await run();
    expect(row.status).toBe("SUCCEEDED"); expect(row.progress).toBe(100); expect(row.resultJson).toMatchObject(output);
    expect(f.validate).toHaveBeenCalledTimes(2); expect(f.versionUpdate).not.toHaveBeenCalled();
    const task = TaskState.parse({ ...row, result: parseAsyncTaskResult(row.kind, row.resultJson), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), error: undefined });
    expect(task.result).toMatchObject(output); expect(task).not.toHaveProperty("inputJson");
    if (kind === "GENERATION_PRECHECK") expect(task.result).toMatchObject({ ok: true, blocking: false });
  });
  it("persists the rechecked version and receipt result in the same transaction", async () => {
    row.kind = "COMPLIANCE_RECHECK"; await run();
    expect(row.status).toBe("SUCCEEDED"); expect(row.resultJson).toMatchObject({ id: "v", complianceReport: report });
    expect(version.complianceReport).toEqual(report); expect(row.refCount).toBe(1);
    expect(f.compliance).toHaveBeenCalledWith({ workspaceId: "w", text: "Brief", imageUrl: "https://test/image.png" }, { signal: expect.any(AbortSignal) });
    expect(f.versionUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "v", generationId: "g", imageUrl: "https://test/image.png" }) }));
  });
  it.each(["RUNNING", "SUCCEEDED", "FAILED"])("does not repeat the paid call when redelivered in %s", async status => {
    row.status = status; await run(); expect(f.compliance).not.toHaveBeenCalled(); expect(f.updateMany).not.toHaveBeenCalled();
  });
  it("rejects a stale delivery token", async () => {
    row.jobId = "other"; await run(); expect(f.compliance).not.toHaveBeenCalled(); expect(row.status).toBe("PENDING");
  });
  it("expires queued work before making a model call", async () => {
    row.expiresAt = new Date(0); await run(); expect(row.status).toBe("FAILED"); expect(row.error).toBe(COMPLIANCE_TASK_EXPIRED); expect(f.compliance).not.toHaveBeenCalled();
  });
  it("does not call the model after permission revocation", async () => {
    f.validate.mockRejectedValue(new ApiException(403, "revoked")); await run(); expect(row.status).toBe("FAILED"); expect(f.compliance).not.toHaveBeenCalled();
  });
  it("does not publish after permission/source change during the model call", async () => {
    f.validate.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new ApiException(409, "changed")); await run();
    expect(row.status).toBe("FAILED"); expect(row.resultJson).toBeNull(); expect(f.transaction).not.toHaveBeenCalled();
  });
  it("aborts a hung provider at five minutes and ignores its late successful result", async () => {
    vi.useFakeTimers(); let finish!: (value: unknown) => void;
    f.compliance.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = run(); await vi.advanceTimersByTimeAsync(5 * 60_000); await pending;
    expect(row.status).toBe("FAILED"); expect(row.error).toBe(COMPLIANCE_TASK_EXPIRED);
    expect(f.compliance.mock.calls[0][1].signal.aborted).toBe(true);
    finish(output); await vi.advanceTimersByTimeAsync(1); expect(row.resultJson).toBeNull(); expect(f.transaction).not.toHaveBeenCalled();
  });
  it("does not overwrite a task expired by the dispatcher during its provider call", async () => {
    f.compliance.mockImplementation(async () => { row.status = "FAILED"; row.error = COMPLIANCE_TASK_EXPIRED; return output; });
    await run(); expect(row.status).toBe("FAILED"); expect(row.error).toBe(COMPLIANCE_TASK_EXPIRED); expect(row.resultJson).toBeNull(); expect(f.versionUpdate).not.toHaveBeenCalled();
  });
  it("does not publish malformed results or provider internals", async () => {
    f.compliance.mockRejectedValue(new Error("private-provider-body")); await run();
    expect(row.status).toBe("FAILED"); expect(row.error).toBe(COMPLIANCE_TASK_ERROR); expect(row.resultJson).toBeNull();
  });
  it("rejects a schema-invalid provider success", async () => {
    f.compliance.mockResolvedValue({ report: { overall: "invented" } }); await run();
    expect(row.status).toBe("FAILED"); expect(row.resultJson).toBeNull();
  });
  it("does not let an older recheck overwrite a newer request", async () => {
    row.kind = "COMPLIANCE_RECHECK"; f.latest.mockResolvedValue({ id: "newer" }); await run();
    expect(row.status).toBe("FAILED"); expect(f.versionUpdate).not.toHaveBeenCalled(); expect(row.resultJson).toBeNull();
  });
  it("rolls back a version update if result validation fails", async () => {
    row.kind = "COMPLIANCE_RECHECK"; f.serialize.mockReturnValue({ id: "broken" }); await run();
    expect(f.versionUpdate).toHaveBeenCalledTimes(1); expect(version.complianceReport).toBeNull(); expect(row.status).toBe("FAILED"); expect(row.resultJson).toBeNull();
  });
});
