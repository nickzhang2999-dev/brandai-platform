import { describe, expect, it } from "vitest";
import { StudioConversationInput, type StudioConversationMessage, type StudioConversationReference } from "@brandai/contracts";
import { emptyOwnedDocument, type OwnedCanvasDocument } from "../src/lib/owned-canvas-model";
import { ownedConversationChoices, ownedConversationDecisionInput, ownedConversationSelectedIds, ownedConversationAcknowledges } from "../src/components/owned-canvas/owned-conversation-decisions";

const refs: StudioConversationReference[] = ["a", "b"].map(id => ({ referenceId: `ref-${id}`, shapeId: `shape:${id}`, name: `图片${id}`, assetId: id, assetSha256: id.repeat(64), width: 800, height: 1200, purpose: "REFERENCE" }));
const original = StudioConversationInput.parse({ mutationId: "831a0280-2cf1-41ba-ac94-621053c4a4c6", text: "把它做成春日海报", references: refs, quickEditTargetId: null,
  sizeSelection: { ratioKey: "3:4", resolutionTier: "2K" }, requestedSize: { width: 1200, height: 1600 }, documentRevision: 3, workflowRevision: 2, homeStart: true, psdLayerMode: "MANUAL", psdLayerCount: 4 });
const option = { id: "modify-a", label: "修改第一张图", action: "modify" as const, targetReferenceId: "ref-a", referenceIds: ["ref-b"], imagePrompt: "以第二张为参考，修改第一张为春日海报" };
const source = (): StudioConversationMessage => ({ messageId: "message-original", mutationId: original.mutationId, projectId: "project", text: original.text, references: refs, originalInput: original,
  status: "CLARIFICATION", intent: { action: "clarify", targetReferenceId: null, referenceIds: [], prompt: original.text, clarification: "要修改哪张图片？", requestedSize: null, sizeSource: "control", sizeSelection: original.sizeSelection, parser: "structured-model-v2", modelStatus: "SUCCEEDED", options: [option] },
  generation: null, error: null, clarification: "要修改哪张图片？", createdAt: "2026-10-19T00:00:00.000Z", expiresAt: "2026-10-19T00:06:00.000Z" });
const mutationId = "794b61f6-6f87-4fe7-8063-9225b46b34cc";

describe("explicit conversation decisions", () => {
  it("replays original text, reference order, size and PSD with a fresh mutation and new save revisions", () => {
    const message = source(), result = ownedConversationDecisionInput(message, option.id, "clarification", { documentRevision: 8, workflowRevision: 5 }, mutationId, ["ref-b"]);
    expect(result).toMatchObject({ text: original.text, references: refs, sizeSelection: original.sizeSelection, requestedSize: original.requestedSize, psdLayerMode: "MANUAL", psdLayerCount: 4, mutationId, documentRevision: 8, workflowRevision: 5, selectedReferenceIds: ["ref-b"], decision: { sourceMessageId: message.messageId, optionId: option.id, kind: "clarification" } });
    expect(result.homeStart).toBeUndefined(); result.references[0]!.name = "changed"; expect(message.references[0]!.name).toBe("图片a");
  });
  it.each(["UNKNOWN", "UNAVAILABLE"] as const)("never guesses available choices when model state is %s and options absent", modelStatus => {
    const message = source(); message.intent = { ...message.intent!, modelStatus, options: undefined };
    expect(ownedConversationChoices(message, "clarification")).toEqual([]);
  });
  it("UNKNOWN still disables provided options and never creates a decision request", () => {
    const message = source(); message.intent!.modelStatus = "UNKNOWN";
    expect(() => ownedConversationDecisionInput(message, option.id, "clarification", { documentRevision: 8, workflowRevision: 5 }, mutationId, [])).toThrow(/暂不可用/);
  });
  it("old messages without original input cannot borrow current composer settings", () => {
    const message = source(); delete message.originalInput; expect(ownedConversationChoices(message, "clarification")).toEqual([]);
  });
  it("rejects foreign options, stale targets and selected references outside the original request", () => {
    const message = source(); expect(() => ownedConversationDecisionInput(message, "unknown", "clarification", { documentRevision: 8, workflowRevision: 5 }, mutationId, [])).toThrow();
    expect(() => ownedConversationDecisionInput(message, option.id, "clarification", { documentRevision: 8, workflowRevision: 5 }, mutationId, ["foreign"])).toThrow();
    message.intent!.options = [{ ...option, targetReferenceId: "foreign" }]; expect(ownedConversationChoices(message, "clarification")).toEqual([]);
  });
  it("running, failed and unarchived results cannot offer paid correction options", () => {
    const message = source(); message.intent!.correctionOptions = [option];
    for (const status of ["PENDING", "RUNNING", "FAILED"] as const) expect(ownedConversationChoices({ ...message, status }, "correction")).toEqual([]);
    expect(ownedConversationChoices({ ...message, status: "SUCCEEDED" }, "correction")).toEqual([]);
  });
  it("acknowledges an existing child only for the same decision and unchanged original text/references", () => {
    const input = ownedConversationDecisionInput(source(), option.id, "clarification", { documentRevision: 8, workflowRevision: 5 }, mutationId, []);
    const prior = { ...source(), originalInput: { ...input, mutationId: original.mutationId } };
    expect(ownedConversationAcknowledges(input, prior)).toBe(true);
    expect(ownedConversationAcknowledges(input, { ...prior, originalInput: { ...prior.originalInput, decision: { ...input.decision!, optionId: "other" } } })).toBe(false);
    expect(ownedConversationAcknowledges(input, { ...prior, text: "another request" })).toBe(false);
    expect(ownedConversationAcknowledges(input, { ...prior, intent: { ...prior.intent!, modelStatus: "UNKNOWN" } })).toBe(false);
  });
  it("uses actual selected persisted images only and excludes hidden, replaced or unselected references", () => {
    const doc: OwnedCanvasDocument = { ...emptyOwnedDocument(), items: refs.map(ref => ({ id: ref.shapeId!, kind: "image", x: 0, y: 0, w: 100, h: 150, rotation: 0, opacity: 1, url: "/image.png", assetId: ref.assetId, assetSha256: ref.assetSha256 })) };
    expect(ownedConversationSelectedIds(doc, ["shape:b"], refs)).toEqual(["ref-b"]);
    expect(ownedConversationSelectedIds(doc, [], refs)).toEqual([]);
    expect(ownedConversationSelectedIds({ ...doc, items: [{ ...doc.items[0]!, hidden: true }, { ...doc.items[1]!, assetSha256: "c".repeat(64) }] }, ["shape:a", "shape:b"], refs)).toEqual([]);
  });
  it("keeps the original confirmed project revision through decisions and rejects a mismatched receipt", () => {
    const message = source(); message.originalInput = { ...original, projectContextRevision: 7 };
    const input = ownedConversationDecisionInput(message, option.id, "clarification", { documentRevision: 8, workflowRevision: 5 }, mutationId, []);
    expect(input.projectContextRevision).toBe(7);
    expect(ownedConversationAcknowledges(input, { ...message, mutationId, originalInput: input })).toBe(true);
    expect(ownedConversationAcknowledges(input, { ...message, mutationId, originalInput: { ...input, projectContextRevision: 8 } })).toBe(false);
    expect(ownedConversationAcknowledges(input, { ...message, mutationId, originalInput: undefined })).toBe(false);
  });
});
