import { describe, it, expect } from "vitest";
import { initialState, transition } from "../src/lib/deepflare-v2/domain";
import { isDeepFlareV2Enabled } from "../src/lib/deepflare-v2/feature";
import { disconnectedOmmi, disconnectedMemory, disconnectedEmployee } from "../src/lib/deepflare-v2/ports";

const brief = { text: "香氛上新", mode: "DIRECTION_FIRST", inspiration: [], deliverables: [
  { id: "main", channel: "主视觉", width: 1024, height: 1024 },
  { id: "vertical", channel: "竖版", width: 1024, height: 1536 },
] };
const direction = { summary: "侧光与留白", composition: "商品原图居中，标题位于独立留白区" };
function awaiting() {
  return transition(transition(initialState(brief), { type: "SET_DIRECTION", direction }), { type: "SUBMIT" });
}
describe("DeepFlare 2.0 approval boundary", () => {
  it("requires a direction before fine production can be submitted", () => {
    expect(() => transition(initialState(brief), { type: "SUBMIT" })).toThrow("准备创意方向");
  });
  it("holds work for review; confirmation freezes the exact plan version", () => {
    const state = awaiting();
    expect(state.status).toBe("AWAITING_DIRECTION");
    expect(state.approvedPlanVersion).toBeNull();
    const approved = transition(state, { type: "CONFIRM_DIRECTION", planVersion: state.planVersion });
    expect(approved.status).toBe("READY");
    expect(approved.approvedPlanVersion).toBe(state.planVersion);
    expect(state.status).toBe("AWAITING_DIRECTION");
  });
  it("rejects stale approvals after the direction changes", () => {
    const old = awaiting();
    const changed = transition(transition(old, { type: "SET_DIRECTION", direction: { ...direction, summary: "换新方向" } }), { type: "SUBMIT" });
    expect(() => transition(changed, { type: "CONFIRM_DIRECTION", planVersion: old.planVersion })).toThrow("已更新");
  });
  it("never sends a requested revision directly to execution", () => {
    const revised = transition(awaiting(), { type: "REQUEST_REVISION", reason: "标题压住瓶盖" });
    expect(() => transition(revised, { type: "SUBMIT" })).toThrow("新版");
    expect(() => transition(revised, { type: "CONFIRM_DIRECTION", planVersion: revised.planVersion })).toThrow("没有等待");
    const next = transition(transition(revised, { type: "SET_DIRECTION", direction }), { type: "SUBMIT" });
    expect(next.status).toBe("AWAITING_DIRECTION");
    expect(next.revisionReason).toBe("标题压住瓶盖");
  });
  it("invalidates the old direction when the brief changes", () => {
    const state = transition(awaiting(), { type: "REVISE_BRIEF", brief: { ...brief, text: "新的商品" } });
    expect(state.direction).toBeNull();
    expect(state.approvedPlanVersion).toBeNull();
    expect(() => transition(state, { type: "SUBMIT" })).toThrow();
  });
  it("direct mode enters READY with a frozen plan without a direction gate", () => {
    const state = transition(initialState({ ...brief, mode: "DIRECT" }), { type: "SUBMIT" });
    expect(state.status).toBe("READY");
    expect(state.approvedPlanVersion).toBe(1);
  });
  it("does not allow a new command to change an approved plan", () => {
    const state = transition(awaiting(), { type: "CONFIRM_DIRECTION", planVersion: 2 });
    for (const command of [{ type: "SET_DIRECTION", direction }, { type: "REVISE_BRIEF", brief }, { type: "SUBMIT" }, { type: "CANCEL" }]) {
      expect(() => transition(state, command)).toThrow();
    }
  });
  it("cancellation is terminal", () => {
    const state = transition(awaiting(), { type: "CANCEL" });
    expect(() => transition(state, { type: "SUBMIT" })).toThrow();
    expect(() => transition(state, { type: "SET_DIRECTION", direction })).toThrow();
  });
  it("describes parallel copy/visual work and downstream adaptations", () => {
    const { tasks } = initialState(brief);
    expect(tasks.find(t => t.id === "copy")!.dependsOn).toEqual(["inspiration"]);
    expect(tasks.find(t => t.id === "visual")!.dependsOn).toEqual(["inspiration"]);
    expect(tasks.find(t => t.id === "adapt_1")!.dependsOn).toEqual(["copy", "visual"]);
    expect(tasks.find(t => t.id === "qa")!.dependsOn).toContain("adapt_1");
    for (const task of tasks) for (const dep of task.dependsOn) {
      expect(tasks.findIndex(t => t.id === dep)).toBeLessThan(tasks.indexOf(task));
    }
  });
  it("never enables a workspace by default or wildcard", () => {
    expect(isDeepFlareV2Enabled("brand", {})).toBe(false);
    expect(isDeepFlareV2Enabled("brand", { DEEPFLARE_V2_ENABLED: "1", DEEPFLARE_V2_WORKSPACE_IDS: "*" })).toBe(false);
    expect(isDeepFlareV2Enabled("brand", { DEEPFLARE_V2_ENABLED: "1", DEEPFLARE_V2_WORKSPACE_IDS: "other, brand" })).toBe(true);
  });
  it("unconnected integrations fail explicitly and never return fake successes", async () => {
    const scope = { workspaceId: "brand", projectId: "project", userId: "user" }, signal = new AbortController().signal;
    await expect(disconnectedOmmi.resolve(scope, [{ source: "ommi", caseId: "case", sourceVersion: "v1", insightIds: ["light"], application: "侧光" }], signal)).rejects.toThrow("Ommi");
    await expect(disconnectedMemory.readConfirmed(scope, ["VISUAL"], signal)).rejects.toThrow("记忆");
    await expect(disconnectedEmployee.execute({ scope, workOrderId: "work", plan: awaiting(), task: awaiting().tasks[0], idempotencyKey: "test", deadlineAt: new Date().toISOString(), signal })).rejects.toThrow("执行器");
  });
});
