import { describe, expect, it } from "vitest";
import { StudioProjectContextSaveInput, StudioProjectContextSnapshot } from "../src/studio-project-context";
import { StudioConversationInput } from "../src/studio-conversation";
import { StudioConversationModelRequest } from "../src/studio-conversation-model";
const source = { assetId: "asset", assetSha256: "a".repeat(64) };
const facts = { goal: "推广", audience: "用户", approvedCopy: "标题", visualRequirements: "绿色" };
const save = { mutationId: "831a0280-2cf1-41ba-ac94-621053c4a4c6", expectedRevision: 0, facts, materials: [{ ...source, role: "PRODUCT" }], master: null };
describe("project context wire (no database or providers)", () => {
  it("keeps responsibilities distinct from reuse strength and forbids URLs or permission flags", () => {
    expect(StudioProjectContextSaveInput.parse(save)).toEqual(save);
    for (const role of ["PRODUCT", "BRAND", "COPY", "STYLE"]) expect(StudioProjectContextSaveInput.safeParse({ ...save, materials: [{ ...source, role }] }).success).toBe(true);
    for (const extra of [{ role: "EXACT" }, { role: "STYLE", availableForGeneration: true }, { role: "STYLE", url: "https://unit.invalid" }])
      expect(StudioProjectContextSaveInput.safeParse({ ...save, materials: [{ ...source, ...extra }] }).success).toBe(false);
  });
  it("bounds role count, unique assets, master identity and revision", () => {
    for (const patch of [{ expectedRevision: -1 }, { expectedRevision: 1.5 }, { materials: [save.materials[0], save.materials[0]] },
      { master: { ...source, shapeId: "shape:master" } }, { master: { ...source, url: "data:image/png;base64,AAAA" } }])
      expect(StudioProjectContextSaveInput.safeParse({ ...save, ...patch }).success).toBe(false);
    expect(StudioProjectContextSaveInput.safeParse({ ...save, master: { ...source, shapeId: "shape:master" }, documentRevision: 1 }).success).toBe(true);
  });
  it("makes project reuse explicitly opt-in and never accepts a browser-supplied snapshot", () => {
    const input = { mutationId: save.mutationId, text: "做海报", references: [], documentRevision: 0, workflowRevision: 0, sizeSelection: { ratioKey: "1:1", resolutionTier: "1K" } };
    expect(StudioConversationInput.parse(input)).not.toHaveProperty("projectContextRevision");
    expect(StudioConversationInput.parse({ ...input, projectContextRevision: 0 }).projectContextRevision).toBe(0);
    expect(StudioConversationInput.safeParse({ ...input, projectContextRevision: null }).success).toBe(false);
    expect(StudioConversationInput.safeParse({ ...input, projectContext: { facts } }).success).toBe(false);
  });
  it("rejects invalid snapshot timestamps and invented planner source identities", () => {
    expect(StudioProjectContextSnapshot.safeParse({ projectId: "p", revision: 0, facts, materials: [], master: null, updatedAt: "invalid" }).success).toBe(false);
    const model = { schemaVersion: 2, text: "海报", references: [], quickEditTargetId: null, previousResultReferenceId: null, history: [], selectedReferenceIds: [],
      projectContext: { revision: 1, facts, materials: [], masterReferenceId: null } };
    expect(StudioConversationModelRequest.safeParse(model).success).toBe(true);
    expect(StudioConversationModelRequest.safeParse({ ...model, projectContext: { ...model.projectContext, masterReferenceId: "forged" } }).success).toBe(false);
  });
});
