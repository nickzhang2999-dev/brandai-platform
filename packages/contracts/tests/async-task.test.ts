/** H-async — TaskState contract shape + null-vs-optional boundary. */
import { describe, expect, it } from "vitest";
import { TaskState, AsyncTaskKind } from "../src/async-task";

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

  it("AsyncTaskKind is one of RECOGNIZE/PARSE_MANUAL/EDIT", () => {
    expect(AsyncTaskKind.safeParse("PARSE_MANUAL").success).toBe(true);
    expect(AsyncTaskKind.safeParse("GENERATE").success).toBe(false);
  });
});
