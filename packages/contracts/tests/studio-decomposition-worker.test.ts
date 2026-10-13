import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ construct: vi.fn(), dispatch: vi.fn(), run: vi.fn(), workers: [] as Array<{ emit: (name: string) => unknown }> }));
// Contracts does not depend on BullMQ. Mock the web package's actual module
// location so an isolated fixture cannot accidentally connect to Redis.
vi.mock("../../../apps/web/node_modules/bullmq", async () => {
  const { EventEmitter } = await import("node:events");
  return { Worker: class extends EventEmitter {
    constructor(...args: unknown[]) { super(); f.construct(...args); f.workers.push(this); }
  } };
});
vi.mock("@/lib/queue", () => ({ connection: {}, queuePrefix: "fixture-prefix" }));
vi.mock("@/lib/studio-decomposition", () => ({ dispatchStudioDecompositions: f.dispatch, runStudioDecomposition: f.run }));
import { createStudioDecompositionWorker, runStudioDecompositionJob } from "../../../apps/web/src/lib/workers/studio-decomposition.worker";

beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); f.dispatch.mockResolvedValue(undefined); f.run.mockResolvedValue(undefined); });
afterEach(() => { f.workers.splice(0).forEach(worker => worker.emit("closed")); vi.useRealTimers(); vi.restoreAllMocks(); });
describe("Studio decomposition worker registration/recovery (isolated fixture; no provider/DB)", () => {
  it("runs the durable request and retains service failures for the receipt processor", async () => {
    await runStudioDecompositionJob({ data: { requestId: "request" } });
    expect(f.run).toHaveBeenCalledWith("request");
    f.run.mockRejectedValue(new Error("fixture failure"));
    await expect(runStudioDecompositionJob({ data: { requestId: "request" } })).rejects.toThrow("fixture failure");
  });
  it("starts with the existing queue prefix, one worker and a 15-second recovery sweep", async () => {
    const worker = createStudioDecompositionWorker();
    expect(f.construct).toHaveBeenCalledWith("studio-decomposition", runStudioDecompositionJob, { connection: {}, prefix: "fixture-prefix", concurrency: 1 });
    expect(f.dispatch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(15000);
    expect(f.dispatch).toHaveBeenCalledTimes(2);
    worker.emit("closed");
    await vi.advanceTimersByTimeAsync(30000);
    expect(f.dispatch).toHaveBeenCalledTimes(2);
  });
  it("never overlaps a pending recovery and resumes only after the previous sweep settles", async () => {
    let resolve!: () => void;
    f.dispatch.mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
    const worker = createStudioDecompositionWorker();
    await vi.advanceTimersByTimeAsync(45000);
    expect(f.dispatch).toHaveBeenCalledOnce();
    resolve(); await vi.advanceTimersByTimeAsync(15000);
    expect(f.dispatch).toHaveBeenCalledTimes(2);
    worker.emit("closed");
  });
  it("reports only controlled generic logs and recovers after a failed sweep", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    f.dispatch.mockRejectedValueOnce(new Error("https://provider.invalid/signed?secret=fixture"));
    const worker = createStudioDecompositionWorker();
    await vi.advanceTimersByTimeAsync(0);
    worker.emit("failed", {}, new Error("https://provider.invalid/secret"));
    worker.emit("error", new Error("https://provider.invalid/secret"));
    expect(warn.mock.calls.flat().join(" ")).not.toContain("provider.invalid");
    expect(warn).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(15000);
    expect(f.dispatch).toHaveBeenCalledTimes(2);
    worker.emit("closed");
  });
});
