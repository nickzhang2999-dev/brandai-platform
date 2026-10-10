import { afterEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ run: vi.fn(), factories: vi.fn() }));
vi.mock("../../../apps/web/src/lib/studio-bounded-queue", () => ({ createStudioBoundedQueue: (name: string) => { f.factories(name); return { run: (operation: unknown) => f.run(name, operation) }; } }));
import { enqueueStudioMaterial } from "../../../apps/web/src/lib/studio-materials-queue";
import { enqueueStudioGeneration } from "../../../apps/web/src/lib/studio-generation-queue";
import { enqueueStudioArtifact } from "../../../apps/web/src/lib/studio-generation-artifacts-queue";
import { enqueueStudioCompliance } from "../../../apps/web/src/lib/studio-generation-compliance-queue";

afterEach(() => f.run.mockReset());
function queueHarness(state?: "active" | "completed" | "failed") {
  const old = state ? { getState: vi.fn().mockResolvedValue(state), remove: vi.fn().mockResolvedValue(undefined) } : null;
  const queue = { getJob: vi.fn().mockResolvedValue(old), add: vi.fn().mockResolvedValue({}) }, guard = vi.fn();
  f.run.mockImplementation(async (_name, operation) => { await operation(queue, guard); return true; });
  return { queue, old, guard };
}
describe("all durable producers use bounded delivery and original job identities", () => {
  it("registers only the four existing queue names", () => {
    expect(f.factories.mock.calls.map(call => call[0]).sort()).toEqual(["generate", "studio-generation-artifact", "studio-generation-compliance", "studio-material-upload"]);
  });
  it("keeps upload task ID, attempts and backoff", async () => {
    const { queue } = queueHarness(); expect(await enqueueStudioMaterial("smu_same")).toBe(true);
    expect(f.run).toHaveBeenCalledWith("studio-material-upload", expect.any(Function));
    expect(queue.add).toHaveBeenCalledWith("upload", { taskId: "smu_same" }, expect.objectContaining({ jobId: "smu_same", attempts: 3, backoff: { type: "exponential", delay: 2000 } }));
  });
  it.each([undefined, "active", "completed", "failed"] as const)("retains the generation request ID and one provider attempt for existing job %s", async state => {
    const { queue, old, guard } = queueHarness(state), data = { generationId: "g", studioRequestId: "request" } as any;
    expect(await enqueueStudioGeneration("request", data)).toBe(true);
    expect(queue.getJob).toHaveBeenCalledWith("request");
    expect(queue.add).toHaveBeenCalledWith("studio-generate", data, expect.objectContaining({ jobId: "request", attempts: 1 }));
    if (old) expect(old.remove).toHaveBeenCalledTimes(state === "active" ? 0 : 1);
    expect(guard).toHaveBeenCalled();
  });
  it("fences generation after each asynchronous lookup/removal before another Redis command", async () => {
    const { queue, old, guard } = queueHarness("completed"); guard.mockImplementationOnce(() => undefined).mockImplementationOnce(() => { throw new Error("deadline"); });
    await expect(enqueueStudioGeneration("request", {} as any)).rejects.toThrow("deadline");
    expect(old!.remove).not.toHaveBeenCalled(); expect(queue.add).not.toHaveBeenCalled();
  });
  it("retains explicit archive epoch and compliance job ID", async () => {
    const { queue } = queueHarness(), expiry = new Date("2026-10-10T00:00:00.000Z");
    expect(await enqueueStudioArtifact("out", expiry)).toBe(true);
    expect(queue.add).toHaveBeenCalledWith("archive", { outputId: "out", epoch: expiry.getTime() }, expect.objectContaining({ jobId: `out-${expiry.getTime()}`, attempts: 3 }));
    expect(await enqueueStudioCompliance("task", "existing-job")).toBe(true);
    expect(queue.add).toHaveBeenCalledWith("check", { taskId: "task", jobId: "existing-job" }, { jobId: "existing-job", attempts: 1, removeOnComplete: true, removeOnFail: true });
  });
  it("returns unavailable without manufacturing acceptance or changing task identity", async () => {
    f.run.mockResolvedValue(false);
    expect(await enqueueStudioMaterial("task")).toBe(false);
    expect(await enqueueStudioGeneration("request", {} as any)).toBe(false);
    expect(await enqueueStudioArtifact("out", new Date())).toBe(false);
    expect(await enqueueStudioCompliance("task", "job")).toBe(false);
  });
});
