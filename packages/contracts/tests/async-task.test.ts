/** H-async — TaskState contract shape + null-vs-optional boundary. */
import { describe, expect, it } from "vitest";
import {
  TaskState,
  AsyncTaskKind,
  isTaskWatchExpired,
} from "../src/async-task";

describe("H-async TaskState", () => {
  it("accepts a running task with omitted optional refId/error", () => {
    const r = TaskState.safeParse({
      id: "t1", workspaceId: "w1", kind: "RECOGNIZE", status: "RUNNING",
      progress: 60, jobId: "j1", refCount: 0,
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    });
    expect(r.success).toBe(true);
  });

  it("rejects explicit null on optional fields (null-vs-optional lock)", () => {
    const r = TaskState.safeParse({
      id: "t1", workspaceId: "w1", kind: "EDIT", status: "SUCCEEDED",
      progress: 100, refId: null, refCount: 1,
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    });
    expect(r.success).toBe(false);
  });

  it("AsyncTaskKind includes RECOGNIZE/PARSE_MANUAL/EDIT/DESCRIBE/INGEST", () => {
    expect(AsyncTaskKind.safeParse("PARSE_MANUAL").success).toBe(true);
    expect(AsyncTaskKind.safeParse("DESCRIBE").success).toBe(true);
    // K3 — website ingest is now an async-task kind.
    expect(AsyncTaskKind.safeParse("INGEST").success).toBe(true);
    expect(AsyncTaskKind.safeParse("GENERATE").success).toBe(false);
  });
});

describe("中间态上界的起算点（§2.4）", () => {
  const CAP = 6 * 60 * 1000;
  const t = (min: number) => min * 60 * 1000;

  it("排队不吃工作预算:躺在 PENDING 里再久,一开跑就重新起算", () => {
    // 提交后排了 5 分钟才轮到它跑,现在它已经跑了 2 分钟——离提交已 7 分钟,
    // 但工作预算才用掉 2 分钟。从提交计时的老写法在这里会判它超时。
    expect(
      isTaskWatchExpired({
        submittedAt: 1_000,
        runningAt: t(5),
        now: t(7),
        capMs: CAP,
      }),
    ).toBe(false);
    // 开跑之后确实跑了太久,才算超。
    expect(
      isTaskWatchExpired({
        submittedAt: 1_000,
        runningAt: t(5),
        now: t(11) + 1,
        capMs: CAP,
      }),
    ).toBe(true);
  });

  it("排队本身仍然有界:worker 没起来时不会无限转圈", () => {
    expect(
      isTaskWatchExpired({ submittedAt: 1, runningAt: 0, now: t(6) + 2, capMs: CAP }),
    ).toBe(true);
    expect(
      isTaskWatchExpired({ submittedAt: 1, runningAt: 0, now: t(5), capMs: CAP }),
    ).toBe(false);
  });

  it("还没提交(两个时刻都是 0)不算超时", () => {
    expect(
      isTaskWatchExpired({ submittedAt: 0, runningAt: 0, now: t(99), capMs: CAP }),
    ).toBe(false);
  });
});
