import { afterEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ run: vi.fn(), factory: vi.fn() }));
vi.mock("../src/lib/studio-bounded-queue", () => ({ createStudioBoundedQueue: (name: string) => { f.factory(name); return { run: f.run }; } }));
import { enqueueStudioDecomposition } from "../src/lib/studio-decomposition-queue";

afterEach(() => f.run.mockReset());
function harness(state?: string) {
  const old = state ? { getState: vi.fn().mockResolvedValue(state), remove: vi.fn().mockResolvedValue(undefined) } : null;
  const queue = { getJob: vi.fn().mockResolvedValue(old), add: vi.fn().mockResolvedValue({}) }, guard = vi.fn();
  f.run.mockImplementation(async operation => { await operation(queue, guard); return true; });
  return { queue, old, guard };
}
describe("Studio decomposition bounded outbox delivery (isolated fixture; no Redis/provider/DB)", () => {
  it("registers the dedicated queue and returns unavailable without changing acceptance", async () => {
    expect(f.factory).toHaveBeenCalledWith("studio-decomposition");
    f.run.mockResolvedValue(false);
    expect(await enqueueStudioDecomposition("request")).toBe(false);
  });
  it.each([undefined, "active", "waiting", "delayed", "completed", "failed"])("keeps one attempt and the original request identity for old job %s", async state => {
    const { queue, old } = harness(state);
    expect(await enqueueStudioDecomposition("request")).toBe(true);
    expect(queue.getJob).toHaveBeenCalledWith("request");
    expect(queue.add).toHaveBeenCalledWith("decompose", { requestId: "request" }, expect.objectContaining({ jobId: "request", attempts: 1 }));
    if (old) expect(old.remove).toHaveBeenCalledTimes(["completed", "failed"].includes(state!) ? 1 : 0);
  });
  it.each([0, 1, 2])("fences every asynchronous lookup/removal before sending another queue command (%s)", async fence => {
    const { queue, old, guard } = harness("completed");
    for (let n = 0; n < fence; n++) guard.mockImplementationOnce(() => undefined);
    guard.mockImplementationOnce(() => { throw new Error("producer deadline"); });
    await expect(enqueueStudioDecomposition("request")).rejects.toThrow("producer deadline");
    expect(queue.add).not.toHaveBeenCalled();
    expect(old!.remove).toHaveBeenCalledTimes(fence === 2 ? 1 : 0);
  });
});
