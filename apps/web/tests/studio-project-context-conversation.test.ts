import { describe, expect, it, vi } from "vitest";
import { StudioConversationInput, StudioProjectContextSnapshot } from "@brandai/contracts";
vi.mock("../src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
import { withStudioProjectContext, studioProjectContextPrompt, studioProjectContextForPlanner } from "../src/lib/studio-project-context-conversation";
const source = { assetId: "master", assetSha256: "a".repeat(64), name: "确认主稿", width: 96, height: 64, versionId: "v1" };
const snapshot = StudioProjectContextSnapshot.parse({ projectId: "p", revision: 1, facts: { goal: "产品推广", audience: "学生", approvedCopy: "夏日清爽", visualRequirements: "绿色" },
  materials: [{ ...source, role: "BRAND" }, { ...source, assetId: "text-only", name: "文字截图", role: "COPY" }], master: { ...source, shapeId: "shape:master" }, updatedAt: null });
const input = (extra = {}) => StudioConversationInput.parse({ mutationId: "831a0280-2cf1-41ba-ac94-621053c4a4c6", text: "生成一张海报，本轮背景蓝色", references: [],
  documentRevision: 1, workflowRevision: 0, sizeSelection: { ratioKey: "1:1", resolutionTier: "1K" }, projectContextRevision: 1, ...extra });
describe("project context expansion (pure fixtures, zero provider calls)", () => {
  it("keeps old requests unchanged, adds master once as a noneditable REFERENCE and excludes COPY images", () => {
    const old = input({ projectContextRevision: undefined }); expect(withStudioProjectContext(old)).toBe(old);
    const original = input(), result = withStudioProjectContext(original, snapshot);
    expect(original.references).toEqual([]); expect(result.references).toHaveLength(1);
    expect(result.references[0]).toMatchObject({ assetId: "master", purpose: "REFERENCE" }); expect(result.references[0]).not.toHaveProperty("shapeId");
    expect(studioProjectContextForPlanner(snapshot, result.references).materials[1]).toMatchObject({ role: "COPY", referenceId: null });
  });
  it("preserves an explicit target and selected purpose for the same master", () => {
    const target = { ...source, referenceId: "shape:explicit", shapeId: "shape:explicit", purpose: "ADAPTIVE" };
    const result = withStudioProjectContext(input({ references: [target], quickEditTargetId: target.referenceId, selectedReferenceIds: [target.referenceId] }), snapshot);
    expect(result.references).toHaveLength(1); expect(result.references[0]).toMatchObject(target); expect(result.quickEditTargetId).toBe(target.referenceId);
  });
  it("refuses overflow and frozen-version mismatch rather than dropping selected materials", () => {
    const refs = Array.from({ length: 8 }, (_, index) => ({ ...source, assetId: `explicit-${index}`, referenceId: `ref:${index}`, purpose: "REFERENCE" }));
    awaitless(() => withStudioProjectContext(input({ references: refs }), snapshot), 422);
    awaitless(() => withStudioProjectContext(input({ projectContextRevision: 2 }), snapshot), 409);
    awaitless(() => withStudioProjectContext(input()), 409);
  });
  it("passes confirmed copy and current instruction intact to the image prompt, never truncates long data", () => {
    const result = studioProjectContextPrompt(input().text, snapshot, "本轮背景蓝色，文字夏日清爽");
    expect(result).toContain("已确认文案：夏日清爽"); expect(result).toContain("本轮明确要求"); expect(result).toContain("本轮背景蓝色");
    expect(studioProjectContextPrompt(input().text, snapshot, "x".repeat(4000))).toContain(input().text);
    awaitless(() => studioProjectContextPrompt("x".repeat(4000), snapshot), 422);
  });
});
function awaitless(fn: () => unknown, status: number) { try { fn(); throw new Error("expected rejection"); } catch (error) { expect(error).toMatchObject({ status }); } }
