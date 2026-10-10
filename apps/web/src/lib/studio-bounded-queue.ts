import { Queue } from "bullmq";
import IORedis from "ioredis";
import { queuePrefix } from "./queue-prefix";

type QueueOperation = (queue: Queue, assertCurrent: () => void) => Promise<unknown>;
type Dependencies = {
  createConnection?: () => IORedis;
  createQueue?: (name: string, connection: IORedis) => Queue;
  timeoutMs?: number;
};

/** Postgres owns the durable intent. Redis is only a bounded delivery attempt.
 * BullMQ caches its initialization Promise: skipping its ready handshake while
 * offline commands are disabled can poison a Queue forever on its first INFO.
 * Construct only after Redis is ready, and retire BOTH objects after a failed
 * initialization/command so the next outbox sweep gets a fresh handshake. */
export function createStudioBoundedQueue(name: string, dependencies: Dependencies = {}) {
  const createConnection = dependencies.createConnection ?? (() => new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 1000, commandTimeout: 1000,
  }));
  const createQueue = dependencies.createQueue ?? ((queueName: string, connection: IORedis) => new Queue(queueName, { connection, prefix: queuePrefix }));
  const timeoutMs = Math.max(1, Math.min(2000, dependencies.timeoutMs ?? 1500));
  type State = { connection: IORedis; queue?: Queue; retired: boolean };
  let state: State | undefined;
  let closed = false;

  function retire(current: State) {
    if (current.retired) return;
    current.retired = true;
    if (state === current) state = undefined;
    // Each producer owns this connection. Stop unsent commands and never let
    // an old timeout close the replacement producer or a Worker's connection.
    try { current.connection.disconnect(false); } catch { /* Already closed. */ }
    try { void current.queue?.close().catch(() => undefined); } catch { /* Failed constructor. */ }
  }
  function connectedState() {
    if (!state) {
      const connection = createConnection();
      connection.on("error", () => undefined);
      state = { connection, retired: false };
    }
    return state;
  }

  return {
    async run(operation: QueueOperation): Promise<boolean> {
      if (closed) return false;
      let current: State;
      try { current = connectedState(); } catch { return false; }
      if (current.connection.status !== "ready") {
        if (current.connection.status === "end") retire(current);
        return false;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      let active = true;
      const assertCurrent = () => {
        if (!active || closed || current.retired || state !== current || current.connection.status !== "ready") throw new Error("Studio queue attempt is no longer current");
      };
      try {
        if (!current.queue) {
          current.queue = createQueue(name, current.connection);
          current.queue.on("error", () => undefined);
        }
        const queue = current.queue;
        const work = (async () => {
          await queue.waitUntilReady();
          assertCurrent();
          await operation(queue, assertCurrent);
          assertCurrent();
          return true;
        })();
        const timeout = new Promise<false>(resolve => {
          timer = setTimeout(() => { active = false; retire(current); resolve(false); }, timeoutMs);
        });
        return await Promise.race([work, timeout]);
      } catch { retire(current); return false; }
      finally { active = false; if (timer) clearTimeout(timer); }
    },
    close() { closed = true; if (state) retire(state); },
  };
}
