import { describe, expect, it } from "vitest";
import type { StudioConversationMessage } from "../src/studio-conversation";
import { ownedConversationActive, ownedConversationDeadline, ownedConversationGeneration } from "../../../apps/web/src/components/owned-canvas/owned-conversation-state";

type Message = StudioConversationMessage;
type Generation = NonNullable<Message["generation"]>;
const task = (extra: Partial<Generation> = {}): Generation => ({ requestId: "request", mutationId: "831a0280-2cf1-41ba-ac94-621053c4a4c6", projectId: "p", generationId: "generation",
  mode: "generate", status: "SUCCEEDED", resultState: "READY", progress: null, results: [], displayText: "Local state test", expiresAt: "2099-01-01T00:00:00.000Z", archiveExpiresAt: null,
  archiveProcessingExpiresAt: null, error: null, archiveError: null, canRetryArchive: false, psdLayerCount: null, psdLayerMode: null, ...extra });
const message = (extra: Partial<Message> = {}): Message => ({ messageId: "message", mutationId: "831a0280-2cf1-41ba-ac94-621053c4a4c6", projectId: "p", text: "Original request", references: [],
  status: "SUCCEEDED", generation: task(), intent: null, error: null, clarification: null, createdAt: "2026-10-14T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z", ...extra });

describe("conversation activity and same-task card receipts", () => {
  it.each(["NOT_REQUESTED", "PENDING", "RUNNING", "READY", "FAILED"] as const)("never polls a failed generation with archive %s", resultState => {
    expect(ownedConversationActive(message({ status: "RUNNING", generation: task({ status: "FAILED", resultState, error: "Provider refused" }) }))).toBe(false);
  });
  it.each(["NOT_REQUESTED", "PENDING", "RUNNING"] as const)("failed message takes precedence over archive %s", resultState => {
    expect(ownedConversationActive(message({ status: "FAILED", generation: task({ resultState }) }))).toBe(false);
  });
  it.each(["PENDING", "RUNNING"] as const)("keeps accepted/creating messages active: %s", status => {
    expect(ownedConversationActive(message({ status, generation: null }))).toBe(true);
    expect(ownedConversationActive(message({ status: "SUCCEEDED", generation: task({ status, resultState: "NOT_REQUESTED" }) }))).toBe(true);
  });
  it.each(["PENDING", "RUNNING"] as const)("keeps successful generation active while archive is %s", resultState => {
    expect(ownedConversationActive(message({ generation: task({ resultState }) }))).toBe(true);
  });
  it.each(["PENDING", "RUNNING", "SUCCEEDED"] as const)("READY stops polling despite message status %s", status => {
    expect(ownedConversationActive(message({ status }))).toBe(false);
  });
  it("does not treat an unrequested archive as active by itself or poll a clarification", () => {
    expect(ownedConversationActive(message({ generation: task({ resultState: "NOT_REQUESTED" }) }))).toBe(false);
    expect(ownedConversationActive(message({ status: "CLARIFICATION", generation: task({ status: "RUNNING", resultState: "NOT_REQUESTED" }) }))).toBe(false);
    expect(ownedConversationActive(message({ status: "RUNNING", generation: task({ resultState: "FAILED" }) }))).toBe(false);
  });
  it("explicit archive retry clears the earlier failure and restores pending activity", () => {
    const current = message({ status: "FAILED", error: "Old archive failure", generation: task({ resultState: "FAILED", archiveError: "Old archive failure", canRetryArchive: true }) });
    const updated = ownedConversationGeneration(current, task({ resultState: "PENDING" }));
    expect(updated.status).toBe("RUNNING"); expect(updated.error).toBeNull(); expect(ownedConversationActive(updated)).toBe(true);
    expect(current.status).toBe("FAILED"); expect(current.error).toBe("Old archive failure");
  });
  it("merges into the latest message metadata and finalizes error-free READY", () => {
    const current = message({ status: "RUNNING", text: "Newest server text", clarification: "Latest server detail", error: "Stale failure", generation: task({ resultState: "PENDING" }) });
    const updated = ownedConversationGeneration(current, task());
    expect(updated.text).toBe(current.text); expect(updated.clarification).toBe(current.clarification); expect(updated.status).toBe("SUCCEEDED"); expect(updated.error).toBeNull();
    expect(ownedConversationActive(updated)).toBe(false);
  });
  it("keeps provider and archive failures terminal with their own reason", () => {
    const current = message({ status: "RUNNING", generation: task({ status: "RUNNING", resultState: "NOT_REQUESTED" }) });
    const failed = ownedConversationGeneration(current, task({ status: "FAILED", resultState: "NOT_REQUESTED", error: "Provider refused" }));
    expect(failed.status).toBe("FAILED"); expect(failed.error).toBe("Provider refused"); expect(ownedConversationActive(failed)).toBe(false);
    const archiveFailed = ownedConversationGeneration(current, task({ resultState: "FAILED", archiveError: "Storage failed" }));
    expect(archiveFailed.status).toBe("FAILED"); expect(archiveFailed.error).toBe("Storage failed"); expect(ownedConversationActive(archiveFailed)).toBe(false);
  });
  it.each([{ requestId: "different" }, { mutationId: "wrong" }, { projectId: "foreign" }, { generationId: "foreign" }])("rejects another task's callback %j", extra => {
    expect(() => ownedConversationGeneration(message(), task(extra))).toThrow("不一致");
  });
  it("a late retry response cannot regress an already saved result", () => {
    const current = message(); expect(ownedConversationGeneration(current, task({ resultState: "PENDING" }))).toBe(current);
  });
  it("uses the current generation lease after the conversation intake expires", () => {
    const past = "2026-10-14T00:00:00.000Z", next = "2026-10-14T00:06:00.000Z";
    expect(ownedConversationDeadline(message({ expiresAt: past, generation: null }))).toBe(Date.parse(past));
    expect(ownedConversationDeadline(message({ expiresAt: past, generation: task({ status: "RUNNING", resultState: "NOT_REQUESTED", expiresAt: next }) }))).toBe(Date.parse(next));
  });
  it("uses the current archive processing lease, including an explicit storage retry", () => {
    const past = "2026-10-14T00:00:00.000Z", next = "2026-10-14T00:06:00.000Z", retention = "2026-10-15T00:00:00.000Z";
    expect(ownedConversationDeadline(message({ expiresAt: past, generation: task({ resultState: "PENDING", expiresAt: past, archiveProcessingExpiresAt: next, archiveExpiresAt: retention }) }))).toBe(Date.parse(next));
    expect(ownedConversationDeadline(message({ expiresAt: past, generation: task({ resultState: "RUNNING", expiresAt: past, archiveProcessingExpiresAt: next }) }))).toBe(Date.parse(next));
    expect(ownedConversationDeadline(message({ expiresAt: past, generation: task({ resultState: "PENDING", expiresAt: past, archiveProcessingExpiresAt: null, archiveExpiresAt: retention }) }))).toBe(Date.parse(past));
  });
});
