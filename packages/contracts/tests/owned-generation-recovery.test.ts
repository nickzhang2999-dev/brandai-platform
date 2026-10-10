import { describe, expect, it, vi } from "vitest";
import { createOwnedGenerationRecovery, OwnedGenerationRecoveryError, type OwnedGenerationIntent, type OwnedGenerationStorage } from "../../../apps/web/src/components/owned-canvas/owned-generation-recovery";

const identity = { workspaceId: "workspace-a", projectId: "project-a", userId: "user-a" };
const initial = (): OwnedGenerationIntent => ({ mode: "generate", input: { projectId: "project-a", mutationId: "4b106a7f-d393-49c2-a396-511d8f010101", prompt: "A synthetic product illustration", sizeSelection: { ratioKey: "1:1", resolutionTier: "1K" }, workflowRevision: 3, documentRevision: 7, outputFrameId: "shape:frame-a" } });
function storage() {
  const records = new Map<string, string>();
  return { records, getItem: vi.fn((key: string) => records.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { records.set(key, value); }), removeItem: vi.fn((key: string) => { records.delete(key); }) };
}

describe("owned generation same-tab input recovery (no network or task authority)", () => {
  it("writes and verifies a complete immutable intent before returning it for POST", () => {
    const target = storage(), journal = createOwnedGenerationRecovery(identity, target), input = initial();
    const returned = journal.store(input); expect(returned).toEqual(input); expect(target.setItem).toHaveBeenCalledOnce(); expect(target.getItem).toHaveBeenCalledTimes(2);
    input.input.prompt = "different new request"; expect(journal.load()!.input.prompt).toBe("A synthetic product illustration");
  });
  it("restores the exact mutation, mode, revisions and frame after a new client instance", () => {
    const target = storage(); createOwnedGenerationRecovery(identity, target).store(initial());
    const resumed = createOwnedGenerationRecovery(identity, target); expect(resumed.load()).toEqual(initial()); expect(target.setItem).toHaveBeenCalledOnce(); expect(target.removeItem).not.toHaveBeenCalled();
  });
  it("does not expire an unconfirmed mutation or remove it merely because time passes", () => {
    vi.useFakeTimers(); try { const target = storage(), journal = createOwnedGenerationRecovery(identity, target); journal.store(initial()); vi.setSystemTime(new Date("2099-01-01")); expect(journal.load()).toEqual(initial()); expect(target.removeItem).not.toHaveBeenCalled(); } finally { vi.useRealTimers(); }
  });
  it("allows exact replay but refuses changing any paid input while a request is unresolved", () => {
    const target = storage(), journal = createOwnedGenerationRecovery(identity, target); journal.store(initial()); expect(journal.store(initial())).toEqual(initial());
    for (const changed of [
      { ...initial(), input: { ...initial().input, mutationId: "4b106a7f-d393-49c2-a396-511d8f010102" } },
      { ...initial(), input: { ...initial().input, prompt: "changed prompt" } },
      { ...initial(), input: { ...initial().input, documentRevision: 8 } },
      { ...initial(), input: { ...initial().input, workflowRevision: 4 } },
      { ...initial(), input: { ...initial().input, outputFrameId: "shape:frame-b" } },
    ]) expect(() => journal.store(changed)).toThrow(OwnedGenerationRecoveryError);
    expect(journal.load()).toEqual(initial());
  });
  it("separates brands, projects and accounts without reading another identity's record", () => {
    const target = storage(); createOwnedGenerationRecovery(identity, target).store(initial());
    for (const other of [{ ...identity, userId: "user-b" }, { ...identity, workspaceId: "workspace-b" }, { ...identity, projectId: "project-b" }]) expect(createOwnedGenerationRecovery(other, target).load()).toBeNull();
    expect(target.records.size).toBe(1);
  });
  it("protects an unexpected identity placed under the current scope instead of discarding it", () => {
    const target = storage(), journal = createOwnedGenerationRecovery(identity, target); journal.store(initial()); const key = [...target.records.keys()][0]!;
    const foreign = JSON.parse(target.records.get(key)!); foreign.userId = "other-user"; const raw = JSON.stringify(foreign); target.records.set(key, raw);
    expect(() => journal.load()).toThrow(OwnedGenerationRecoveryError); expect(() => journal.store(initial())).toThrow(OwnedGenerationRecoveryError); expect(() => journal.clear(initial())).toThrow(OwnedGenerationRecoveryError);
    expect(target.records.get(key)).toBe(raw);
  });
  it("protects malformed, oversized and unsupported records without echoing their content", () => {
    const target = storage(), journal = createOwnedGenerationRecovery(identity, target); journal.store(initial()); const key = [...target.records.keys()][0]!;
    for (const raw of ["PRIVATE_FIXTURE_PAYLOAD", " ".repeat(32 * 1024 + 1), JSON.stringify({ ...identity, version: 2, intent: initial() }), JSON.stringify({ ...identity, version: 1, intent: { ...initial(), mode: "invalid" } })]) {
      target.records.set(key, raw); let caught: unknown; try { journal.load(); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(OwnedGenerationRecoveryError); expect(String(caught)).not.toContain("PRIVATE_FIXTURE_PAYLOAD"); expect(target.records.get(key)).toBe(raw);
    }
  });
  it("validates full input shape, mode and project before writing", () => {
    const target = storage(), journal = createOwnedGenerationRecovery(identity, target);
    for (const bad of [
      { ...initial(), mode: "modify" }, // Modify never accepts an output frame.
      { ...initial(), input: { ...initial().input, projectId: "project-b" } },
      { ...initial(), input: { ...initial().input, mutationId: "not-a-uuid" } },
      { ...initial(), input: { ...initial().input, documentRevision: -1 } },
      { ...initial(), input: { ...initial().input, prompt: "" } },
      { ...initial(), input: { ...initial().input, secretExtra: "PRIVATE_FIXTURE_PAYLOAD" } },
    ]) expect(() => journal.store(bad as OwnedGenerationIntent)).toThrow(OwnedGenerationRecoveryError);
    expect(target.setItem).not.toHaveBeenCalled();
  });
  it("retains whole-image modify intent and never adds a mode field to the API payload", () => {
    const target = storage(), journal = createOwnedGenerationRecovery(identity, target), value = initial(); value.mode = "modify"; delete value.input.outputFrameId;
    expect(journal.store(value)).toEqual(value); expect(journal.load()!.input).not.toHaveProperty("mode");
  });
  it("fails closed when storage cannot be read or written, or drops the write", () => {
    const target = storage(); target.getItem.mockImplementationOnce(() => { throw new Error("PRIVATE_FIXTURE_PAYLOAD"); }); const journal = createOwnedGenerationRecovery(identity, target);
    expect(() => journal.store(initial())).toThrow(OwnedGenerationRecoveryError); expect(target.setItem).not.toHaveBeenCalled();
    target.setItem.mockImplementationOnce(() => { throw new Error("quota"); }); expect(() => journal.store(initial())).toThrow("未能保存");
    target.setItem.mockImplementationOnce(() => {}); expect(() => journal.store(initial())).toThrow("未能核对");
  });
  it("clears only the complete confirmed intent and verifies actual removal", () => {
    const target = storage(), journal = createOwnedGenerationRecovery(identity, target); journal.store(initial());
    expect(() => journal.clear({ ...initial(), input: { ...initial().input, prompt: "wrong intent" } })).toThrow(OwnedGenerationRecoveryError); expect(target.removeItem).not.toHaveBeenCalled();
    journal.clear(initial()); expect(journal.load()).toBeNull(); journal.clear(initial()); expect(target.removeItem).toHaveBeenCalledOnce();
  });
  it("does not report successful cleanup when removal is blocked or ignored", () => {
    const target = storage(), journal = createOwnedGenerationRecovery(identity, target); journal.store(initial()); target.removeItem.mockImplementationOnce(() => {});
    expect(() => journal.clear(initial())).toThrow("暂未清理成功"); expect(journal.load()).toEqual(initial());
    target.removeItem.mockImplementationOnce(() => { throw new Error("PRIVATE_FIXTURE_PAYLOAD"); }); expect(() => journal.clear(initial())).toThrow(OwnedGenerationRecoveryError); expect(journal.load()).toEqual(initial());
  });
  it("blocks invalid identity and unavailable browser storage without leaking raw errors", () => {
    expect(() => createOwnedGenerationRecovery({ ...identity, projectId: "../bad" }, storage())).toThrow(OwnedGenerationRecoveryError);
    const inaccessible = { getItem() { throw new Error("PRIVATE_FIXTURE_PAYLOAD"); } } as unknown as OwnedGenerationStorage;
    expect(() => createOwnedGenerationRecovery(identity, inaccessible).load()).toThrow(OwnedGenerationRecoveryError);
  });
});
