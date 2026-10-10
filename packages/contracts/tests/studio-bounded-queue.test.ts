import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStudioBoundedQueue } from "../../../apps/web/src/lib/studio-bounded-queue";

const requireWeb = createRequire(new URL("../../../apps/web/next.config.mjs", import.meta.url));
// Run the installed library's real initialization logic, not a mocked Queue
// constructor that would conceal its permanently rejected client Promise.
const { RedisConnection } = requireWeb("bullmq");
class DelayedRedis extends EventEmitter {
  status = "connecting";
  options = { maxRetriesPerRequest: 1, enableOfflineQueue: false };
  infoCalls = 0;
  connect() { return Promise.resolve(); }
  duplicate() { return this; }
  defineCommand() {}
  hmset = vi.fn().mockResolvedValue("OK");
  disconnect = vi.fn(() => { this.status = "end"; this.emit("end"); this.emit("close"); });
  async info() {
    this.infoCalls++;
    if (this.status !== "ready") throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
    return "redis_version:7.0.8\r\nmaxmemory_policy:noeviction\r\n";
  }
  ready() { this.status = "ready"; this.emit("ready"); }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(close => close()); vi.useRealTimers(); });
function harness(overrides: { firstReady?: Promise<unknown>; firstConstructThrows?: boolean } = {}) {
  const connections: DelayedRedis[] = [], queues: any[] = [];
  const createConnection = vi.fn(() => { const value = new DelayedRedis(); value.ready(); connections.push(value); return value as any; });
  const createQueue = vi.fn(() => {
    if (overrides.firstConstructThrows && createQueue.mock.calls.length === 1) throw new Error("constructor failed");
    const queue = { on: vi.fn(), waitUntilReady: vi.fn(() => queues.length === 1 && overrides.firstReady ? overrides.firstReady : Promise.resolve()), close: vi.fn().mockResolvedValue(undefined), add: vi.fn().mockResolvedValue({ id: "same-id" }) };
    queues.push(queue); return queue as any;
  });
  const producer = createStudioBoundedQueue("test-durable", { createConnection, createQueue, timeoutMs: 20 });
  cleanups.push(producer.close);
  return { producer, connections, queues, createConnection, createQueue };
}

describe("bounded durable queue cold start and recovery (no network)", () => {
  it("reproduces the installed BullMQ skip-ready poison after Redis later becomes ready", async () => {
    const raw = new DelayedRedis();
    const connection = new RedisConnection(raw, { shared: true, blocking: false, skipWaitingForReady: true });
    connection.on("error", () => undefined);
    await expect(connection.client).rejects.toThrow("Stream isn't writeable");
    raw.ready();
    await expect(connection.client).rejects.toThrow("Stream isn't writeable");
    expect(raw.infoCalls).toBe(1);
    await connection.close(true);
  });
  it("uses the real installed Queue only after ready and survives an initially connecting producer", async () => {
    const raw = new DelayedRedis(), operation = vi.fn().mockResolvedValue(undefined);
    const producer = createStudioBoundedQueue("test-real-initialization", { createConnection: () => raw as any, timeoutMs: 100 });
    cleanups.push(producer.close);
    expect(await producer.run(operation)).toBe(false); expect(raw.infoCalls).toBe(0); expect(operation).not.toHaveBeenCalled();
    raw.ready();
    expect(await producer.run(operation)).toBe(true); expect(raw.infoCalls).toBe(1); expect(operation).toHaveBeenCalledOnce();
    expect(operation.mock.calls[0]![0].name).toBe("test-real-initialization");
    expect(await producer.run(operation)).toBe(true); expect(raw.infoCalls).toBe(1);
  });
  it("reuses a healthy queue without allocating a new connection per enqueue", async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) expect(await h.producer.run(queue => queue.add("upload", { taskId: "same-id" }, { jobId: "same-id" }))).toBe(true);
    expect(h.createConnection).toHaveBeenCalledOnce(); expect(h.createQueue).toHaveBeenCalledOnce(); expect(h.queues[0].add).toHaveBeenCalledTimes(3);
  });
  it("retires failed initialization and builds a fresh connection on the next sweep", async () => {
    const h = harness({ firstReady: Promise.reject(new Error("INFO failed")) }), operation = vi.fn().mockResolvedValue(undefined);
    expect(await h.producer.run(operation)).toBe(false); expect(operation).not.toHaveBeenCalled(); expect(h.connections[0]!.disconnect).toHaveBeenCalledOnce();
    expect(await h.producer.run(operation)).toBe(true); expect(h.createQueue).toHaveBeenCalledTimes(2); expect(operation).toHaveBeenCalledOnce();
  });
  it("recovers when queue construction itself fails", async () => {
    const h = harness({ firstConstructThrows: true });
    expect(await h.producer.run(async () => undefined)).toBe(false);
    expect(await h.producer.run(async () => undefined)).toBe(true); expect(h.connections[0]!.disconnect).toHaveBeenCalledOnce();
  });
  it("bounds an initialization that never resolves and fences a late ready result", async () => {
    vi.useFakeTimers(); const ready = deferred<unknown>(), h = harness({ firstReady: ready.promise }), operation = vi.fn().mockResolvedValue(undefined);
    const result = h.producer.run(operation); await vi.advanceTimersByTimeAsync(21); expect(await result).toBe(false);
    expect(h.connections[0]!.disconnect).toHaveBeenCalledOnce(); ready.resolve(undefined); await Promise.resolve(); await Promise.resolve();
    expect(operation).not.toHaveBeenCalled(); expect(await h.producer.run(operation)).toBe(true);
  });
  it("bounds an in-flight add, disconnects its producer, and preserves the original job identity for a retry", async () => {
    vi.useFakeTimers(); const h = harness(), sent = deferred<unknown>();
    const operation = async (queue: any) => { queue.add.mockImplementationOnce(() => sent.promise); await queue.add("upload", { taskId: "durable-id" }, { jobId: "durable-id" }); };
    const result = h.producer.run(operation); await vi.advanceTimersByTimeAsync(21); expect(await result).toBe(false);
    expect(h.connections[0]!.disconnect).toHaveBeenCalledOnce();
    expect(await h.producer.run(queue => queue.add("upload", { taskId: "durable-id" }, { jobId: "durable-id" }))).toBe(true);
    expect(h.queues[0].add.mock.calls[0]).toEqual(h.queues[1].add.mock.calls[0]);
    sent.resolve({ id: "durable-id" }); await Promise.resolve(); expect(h.connections[1]!.disconnect).not.toHaveBeenCalled();
  });
  it("does not issue a later add after a pre-add asynchronous step times out", async () => {
    vi.useFakeTimers(); const h = harness(), lookup = deferred<unknown>();
    const result = h.producer.run(async (queue, assertCurrent) => { await lookup.promise; assertCurrent(); await queue.add("studio-generate", {}, { jobId: "original" }); });
    await vi.advanceTimersByTimeAsync(21); expect(await result).toBe(false); lookup.resolve(undefined); await Promise.resolve(); await Promise.resolve();
    expect(h.queues[0].add).not.toHaveBeenCalled();
  });
  it("skips disconnected delivery and recovers the same initialized queue after reconnect", async () => {
    const h = harness(), operation = vi.fn().mockResolvedValue(undefined);
    expect(await h.producer.run(operation)).toBe(true); h.connections[0]!.status = "reconnecting";
    expect(await h.producer.run(operation)).toBe(false); expect(operation).toHaveBeenCalledOnce();
    h.connections[0]!.ready(); expect(await h.producer.run(operation)).toBe(true); expect(h.createQueue).toHaveBeenCalledOnce();
  });
  it("fences concurrent old operations without letting their completion retire a new producer", async () => {
    const h = harness(), pending = deferred<unknown>();
    const first = h.producer.run(async (queue, assertCurrent) => { await pending.promise; assertCurrent(); await queue.add("upload", {}); });
    await Promise.resolve();
    expect(await h.producer.run(async () => { throw new Error("connection failed"); })).toBe(false);
    expect(await h.producer.run(async () => undefined)).toBe(true); pending.resolve(undefined);
    expect(await first).toBe(false); expect(h.queues[0].add).not.toHaveBeenCalled(); expect(h.connections[1]!.disconnect).not.toHaveBeenCalled();
  });
  it("does not keep an initialization timer after successful delivery and never reopens after close", async () => {
    vi.useFakeTimers(); const h = harness(); expect(await h.producer.run(async () => undefined)).toBe(true);
    await vi.advanceTimersByTimeAsync(100); expect(h.connections[0]!.disconnect).not.toHaveBeenCalled();
    h.producer.close(); expect(await h.producer.run(async () => undefined)).toBe(false); expect(h.createConnection).toHaveBeenCalledOnce();
  });
});
