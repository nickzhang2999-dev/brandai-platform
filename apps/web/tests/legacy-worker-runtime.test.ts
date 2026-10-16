import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ update: vi.fn(), tx: vi.fn(), asset: vi.fn(), describe: vi.fn(), progress: vi.fn(), find: vi.fn(), sweep: vi.fn() }));
vi.mock("../../../packages/db/src/index", () => ({ prisma: { asyncTask: { updateMany: f.update, findUnique: f.find }, $transaction: f.tx, generation: { updateMany: f.sweep } } }));
vi.mock("@/lib/queue", () => ({ connection: {}, queuePrefix: "synthetic-worker" }));
vi.mock("@/lib/ai", () => ({ ai: { describe: f.describe } }));
vi.mock("@/lib/usage", () => ({ recordUsage: vi.fn() }));
vi.mock("@/lib/async-tasks", () => ({ setProgress: f.progress }));
import { runLegacyTask, sweepStaleLegacyTasks, LEGACY_TASK_KINDS } from "../src/lib/legacy-task-runtime";
import { createWorkerDeadline, LEGACY_TASK_RUN_MS, LEGACY_TASK_QUEUE_MS, generationRunBudgetMs, MAX_GENERATION_RUN_MS } from "../src/lib/worker-deadline";
import { runDescribeJob } from "../src/lib/workers/describe.worker";
import { sweepStaleGenerations } from "../src/lib/generations";
// Workers above see the mocked "@/lib/async-tasks"; these tests need the real
// module, which the web "@" alias would otherwise resolve to the same mock.
const { getTask, setProgress } = await vi.importActual<typeof import("../src/lib/async-tasks")>("../src/lib/async-tasks");

let rows: any[], assets: unknown[];
function matches(row: any, where: any): boolean {
  if (where.OR && !where.OR.some((clause: any) => matches(row, clause))) return false;
  if (where.AND && !where.AND.every((clause: any) => matches(row, clause))) return false;
  return Object.entries(where).every(([key, expected]) => {
    if (key === "OR" || key === "AND") return true;
    const actual = row[key];
    if (expected instanceof Date) return actual instanceof Date && actual.getTime() === expected.getTime();
    if (expected && typeof expected === "object") {
      const condition = expected as any;
      if ("in" in condition) return condition.in.includes(actual);
      if (actual == null) return false;
      return Object.entries(condition).every(([op, value]) => op === "lt" ? actual < value! : op === "lte" ? actual <= value! : op === "gt" ? actual > value! : op === "gte" ? actual >= value! : false);
    }
    return actual === expected;
  });
}
const input = { taskId: "task", workspaceId: "workspace", kind: "DESCRIBE" as const };
const job = () => ({ id: "job", data: { taskId: "task", workspaceId: "workspace", assetId: "image", url: "https://synthetic.invalid/image.png" }, updateProgress: vi.fn() } as any);
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-16T08:00:00Z")); vi.resetAllMocks();
  rows = [{ id: "task", workspaceId: "workspace", kind: "DESCRIBE", status: "PENDING", progress: 0, expiresAt: null, createdAt: new Date(), updatedAt: new Date(), refCount: 0 }]; assets = [];
  f.find.mockImplementation(async ({ where }) => rows.find(row => row.id === where.id) ?? null);
  f.update.mockImplementation(async ({ where, data }) => {
    const selected = rows.filter(row => matches(row, where)); selected.forEach(row => Object.assign(row, data)); return { count: selected.length };
  });
  f.tx.mockImplementation(async work => {
    const saved = structuredClone(rows), savedAssets = [...assets];
    try { return await work({ asyncTask: { updateMany: f.update }, asset: { updateMany: f.asset } }); }
    catch (error) { rows = saved; assets = savedAssets; throw error; }
  });
  f.asset.mockImplementation(async args => { assets.push(args); return { count: 1 }; });
  f.describe.mockResolvedValue({ aiTags: ["synthetic"], aiDescription: "fixture description" });
  f.sweep.mockResolvedValue({ count: 2 });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("legacy worker durable claim, deadline and late persistence", () => {
  it("completes the actual describe worker through its scoped transaction and signal", async () => {
    expect(await runDescribeJob(job())).toEqual({ assetId: "image", tagCount: 1 });
    expect(f.describe.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(rows[0]).toMatchObject({ status: "SUCCEEDED", progress: 100, refId: "image", refCount: 1 });
    expect(assets).toEqual([{ where: { id: "image", workspaceId: "workspace" }, data: { aiTags: ["synthetic"], aiDescription: "fixture description" } }]);
  });
  it("never pays twice when the same worker receipt is redelivered", async () => {
    await runDescribeJob(job());
    await expect(runDescribeJob(job())).rejects.toThrow("不会重复调用模型");
    expect(f.describe).toHaveBeenCalledOnce(); expect(assets).toHaveLength(1); expect(rows[0].status).toBe("SUCCEEDED");
  });
  it.each(["wrong-workspace", "missing-task"])("rejects a foreign or missing receipt before any provider call (%s)", reason => {
    const value = job(); if (reason === "wrong-workspace") value.data.workspaceId = "foreign"; else delete value.data.taskId;
    return expect(runDescribeJob(value)).rejects.toThrow().then(() => { expect(f.describe).not.toHaveBeenCalled(); expect(assets).toHaveLength(0); });
  });
  it("aborts a stuck actual worker and discards an uncooperative late provider result", async () => {
    let resolve!: (value: unknown) => void;
    f.describe.mockImplementation(() => new Promise(done => { resolve = done; }));
    const outcome = runDescribeJob(job()).then(() => "unexpected success", error => String(error));
    await vi.advanceTimersByTimeAsync(1);
    const signal = f.describe.mock.calls[0][1].signal as AbortSignal;
    await vi.advanceTimersByTimeAsync(LEGACY_TASK_RUN_MS);
    expect(await outcome).toContain("超时"); expect(signal.aborted).toBe(true); expect(rows[0].status).toBe("FAILED");
    resolve({ aiTags: ["late"], aiDescription: "late" }); await vi.advanceTimersByTimeAsync(0);
    expect(rows[0].status).toBe("FAILED"); expect(assets).toHaveLength(0); expect(f.describe).toHaveBeenCalledOnce();
  });
  it("rolls back writes whose deadline expires inside the persistence transaction", async () => {
    await expect(runLegacyTask(input, async ctx => {
      await ctx.write(async tx => {
        await tx.asset.updateMany({ where: { id: "image" }, data: { aiDescription: "late" } });
        vi.setSystemTime(Date.now() + LEGACY_TASK_RUN_MS + 1);
      });
    })).rejects.toThrow("超时");
    expect(assets).toHaveLength(0); expect(rows[0].status).toBe("FAILED");
  });
  it("rejects a late writer after authoritative cleanup without resurrecting a terminal row", async () => {
    await expect(runLegacyTask(input, async ctx => {
      rows[0].status = "FAILED";
      await ctx.write(tx => tx.asset.updateMany({ where: { id: "image" }, data: { aiDescription: "late" } }));
    })).rejects.toThrow("失效");
    expect(assets).toHaveLength(0); expect(rows[0].status).toBe("FAILED");
  });
  it("does not clear an already successful terminal status when a later best-effort step throws", async () => {
    await expect(runLegacyTask(input, async ctx => { await ctx.succeed({ refId: "result" }); throw new Error("after completion"); })).rejects.toThrow("after completion");
    expect(rows[0]).toMatchObject({ status: "SUCCEEDED", refId: "result" });
  });
  it("bounds a hung database claim, and closes a late claim without calling the provider", async () => {
    let late!: (value: unknown) => void;
    f.update.mockImplementationOnce(() => new Promise(resolve => { late = resolve; }));
    const outcome = runDescribeJob(job()).catch(error => String(error));
    await vi.advanceTimersByTimeAsync(LEGACY_TASK_RUN_MS + 1);
    expect(await outcome).toContain("超时"); expect(f.describe).not.toHaveBeenCalled();
    Object.assign(rows[0], { status: "RUNNING", expiresAt: f.update.mock.calls[0][0].data.expiresAt });
    late({ count: 1 }); await vi.advanceTimersByTimeAsync(0);
    expect(rows[0].status).toBe("FAILED"); expect(f.describe).not.toHaveBeenCalled();
  });
  it("returns the original failure when even failure persistence never settles", async () => {
    f.describe.mockRejectedValue(new Error("provider unavailable"));
    f.update.mockImplementationOnce(async ({ data }) => { Object.assign(rows[0], data); return { count: 1 }; })
      .mockImplementationOnce(() => new Promise(() => {}));
    const outcome = runDescribeJob(job()).catch(error => String(error));
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await outcome).toContain("provider unavailable"); expect(f.describe).toHaveBeenCalledOnce();
  });
  it("cannot extend an expired queue receipt by publishing progress", async () => {
    rows[0].createdAt = new Date(Date.now() - LEGACY_TASK_QUEUE_MS - 1);
    await setProgress("task", 2);
    await expect(runDescribeJob(job())).rejects.toThrow("排队过期");
    expect(f.describe).not.toHaveBeenCalled();
    expect(await sweepStaleLegacyTasks()).toBe(1); expect(rows[0].status).toBe("FAILED");
  });
  it.each(["SUCCEEDED", "FAILED", "expired"])("does not change terminal or expired task progress (%s)", async status => {
    Object.assign(rows[0], { status: status === "expired" ? "RUNNING" : status, progress: 77 });
    if (status === "expired") rows[0].expiresAt = new Date(Date.now() - 1);
    const before = structuredClone(rows[0]); await setProgress("task", 30);
    expect(rows[0]).toEqual(before);
  });
});

describe("kind-scoped stale task cleanup and separate generation budgets", () => {
  it("expires only overdue owned legacy tasks; active and Studio/decomposition/terminal states survive", async () => {
    const now = Date.now(), row = (id: string, patch: any) => ({ ...rows[0], id, ...patch });
    rows = [
      row("queued-old", { createdAt: new Date(now - LEGACY_TASK_QUEUE_MS - 1), updatedAt: new Date(now) }),
      row("running-old", { status: "RUNNING", expiresAt: new Date(now - 1) }),
      row("pre-deadline-old", { status: "RUNNING", updatedAt: new Date(now - LEGACY_TASK_RUN_MS - 60_001) }),
      row("active", { status: "RUNNING", expiresAt: new Date(now + 1) }),
      row("queued-new", {}), row("finished", { status: "SUCCEEDED", expiresAt: new Date(now - 1) }),
      row("studio", { kind: "STUDIO_CONVERSATION", status: "RUNNING", expiresAt: new Date(now - 1) }),
      row("layers", { kind: "DECOMPOSE", status: "RUNNING", expiresAt: new Date(now - 1) }),
      row("compliance", { kind: "COMPLIANCE_PRECHECK", status: "RUNNING", expiresAt: new Date(now - 1) }),
    ];
    expect(await sweepStaleLegacyTasks(new Date(now))).toBe(3);
    expect(rows.filter(row => row.status === "FAILED").map(row => row.id)).toEqual(["queued-old", "running-old", "pre-deadline-old"]);
    expect(f.update).toHaveBeenCalledTimes(LEGACY_TASK_KINDS.length);
    expect(await sweepStaleLegacyTasks(new Date(now))).toBe(0);
  });
  it("allocates three minutes per target plus one minute without a five-minute batch ceiling", () => {
    expect(generationRunBudgetMs()).toBe(300_000);
    expect(generationRunBudgetMs(1)).toBe(240_000); expect(generationRunBudgetMs(2)).toBe(420_000);
    expect(generationRunBudgetMs(12)).toBe(2_220_000); expect(generationRunBudgetMs(30)).toBe(MAX_GENERATION_RUN_MS);
  });
  it("does not apply the legacy ten-minute createdAt sweep to running batches or Studio", async () => {
    expect(await sweepStaleGenerations()).toBe(2);
    const where = f.sweep.mock.calls[0][0].where;
    expect(where.studioRequest).toEqual({ is: null });
    expect(where.OR).toEqual([
      { status: "PENDING", createdAt: { lt: new Date(Date.now() - 600_000) } },
      { status: "RUNNING", startedAt: { lt: new Date(Date.now() - MAX_GENERATION_RUN_MS - 60_000) } },
      { status: "RUNNING", startedAt: null, createdAt: { lt: new Date(Date.now() - MAX_GENERATION_RUN_MS - 60_000) } },
    ]);
  });
  it("aborts the underlying signal and rejects once the bounded timer wins", async () => {
    const deadline = createWorkerDeadline(50, "test");
    const outcome = deadline.run(new Promise(() => {})).catch(error => String(error));
    await vi.advanceTimersByTimeAsync(51);
    expect(await outcome).toContain("超时"); expect(deadline.signal.aborted).toBe(true); expect(() => deadline.check()).toThrow();
    deadline.dispose();
  });
});

describe("durable task reads", () => {
  const output = { results: [], report: { overall: "PASS", textResults: [], visualResults: [], checkedAt: "2026-10-16T00:00:00.000Z" } };
  it("publishes validated successful results and strips private inputs and extra result fields", async () => {
    Object.assign(rows[0], { kind: "COMPLIANCE_PRECHECK", status: "SUCCEEDED", resultJson: { ...output, secretInternal: "synthetic" }, inputJson: { privateBrief: "synthetic" } });
    const task = await getTask("workspace", "task");
    expect(task?.result).toEqual(output); expect(task).not.toHaveProperty("inputJson");
    expect(task?.result).not.toHaveProperty("secretInternal");
  });
  it.each(["FAILED", "RUNNING"])("does not expose stored results in %s", async status => {
    Object.assign(rows[0], { kind: "COMPLIANCE_PRECHECK", status, resultJson: output });
    expect(await getTask("workspace", "task")).not.toHaveProperty("result");
  });
  it("returns null across workspace and omits malformed success output", async () => {
    Object.assign(rows[0], { kind: "COMPLIANCE_PRECHECK", status: "SUCCEEDED", resultJson: { results: [], report: { overall: "invented" } } });
    expect(await getTask("foreign", "task")).toBeNull();
    expect(await getTask("workspace", "task")).not.toHaveProperty("result");
  });
});
