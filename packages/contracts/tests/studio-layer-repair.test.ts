import { describe, expect, it } from "vitest";
import { StudioImageToolInput, StudioImageToolSpec, StudioLayerRepairContext } from "../src/studio-image-tools";
const input = { projectId: "p", mutationId: "831a0280-2cf1-41ba-ac94-621053c4a4c6", documentRevision: 1, workflowRevision: 0,
  target: { shapeId: "shape:source", assetSha256: "a".repeat(64) }, operation: "inpaint", mask: "data:image/png;base64,AAAA" };
describe("layer repair intake contract", () => {
  it("retains older inpaint requests and accepts an explicit decomposition continuation", () => {
    expect(StudioImageToolInput.parse(input)).toEqual(input);
    expect(StudioImageToolInput.parse({ ...input, decompositionRequestId: "parent" }).decompositionRequestId).toBe("parent");
  });
  it("does not send parent provenance to the model tool spec", () => {
    expect(StudioImageToolSpec.safeParse({ operation: "inpaint", mask: input.mask, decompositionRequestId: "parent" }).success).toBe(false);
  });
  it("rejects null, malformed lineage and cutout linkage", () => {
    for (const id of [null, "", "foreign/parent", " parent "]) expect(StudioImageToolInput.safeParse({ ...input, decompositionRequestId: id }).success).toBe(false);
    expect(StudioImageToolInput.safeParse({ ...input, operation: "remove-background", mask: undefined, decompositionRequestId: "parent" }).success).toBe(false);
  });
  it("cannot claim exact recovery or reviewed quality in persisted context", () => {
    const context = { decompositionRequestId: "parent", sourceShapeId: "shape:source", assetId: "source", assetSha256: "a".repeat(64),
      width: 96, height: 64, mode: "inferred-completion", independentQuality: "NOT_REVIEWED" };
    expect(StudioLayerRepairContext.parse(context)).toEqual(context);
    expect(StudioLayerRepairContext.safeParse({ ...context, independentQuality: "APPROVED" }).success).toBe(false);
    expect(StudioLayerRepairContext.safeParse({ ...context, mode: "original-recovery" }).success).toBe(false);
  });
});
