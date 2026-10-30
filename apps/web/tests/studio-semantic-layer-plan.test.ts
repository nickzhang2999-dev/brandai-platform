import { describe, expect, it } from "vitest";
import { StudioDecompositionInput, StudioDecompositionView, StudioLayerPlanResponse } from "../../../packages/contracts/src/studio-decomposition";
import { StudioGenerationInput } from "../../../packages/contracts/src/studio-generation";
import { newStudioLayerPlanning, readStudioLayerPlanning, semanticDecompositionIntent, semanticDecompositionSourceCaption, studioLayerMaxCount } from "../src/lib/studio-decomposition-planning";
import { generatedPsdIntent, generatedPsdLayerCount, generatedPsdLayerMode } from "../src/lib/studio-generated-psd-state";

const input = { projectId: "p", mutationId: "831a0280-2cf1-41ba-ac94-621053c4a4c6", sourceShapeId: "shape:source", assetId: "a", assetSha256: "a".repeat(64), documentRevision: 0 };
const generation = { projectId: "p", mutationId: input.mutationId, prompt: "tree", sizeSelection: { ratioKey: "1:1", resolutionTier: "1K" }, workflowRevision: 0, documentRevision: 0 };
const result = (count = 3) => ({ revision: "semantic-layer-plan-r2", plan: { layerCount: count, summary: "主体、背景与文字分别编辑。", sourceCaption: "红衣人物站在蓝色背景前，左上角有文字。",
  groups: Array.from({ length: count }, (_, index) => ({ name: `组${index + 1}`, description: "图中实际可见内容" })) },
  usage: { provider: "HttpVLMProvider", model: "test-model", latencyMs: 5 } });

describe("semantic layer wire and fail-closed persistence", () => {
  it("lets AUTO omit a count and preserves legacy manual jobs", () => {
    expect(StudioDecompositionInput.parse({ ...input, layerMode: "AUTO" })).not.toHaveProperty("layerCount");
    expect(StudioDecompositionInput.parse({ ...input, layerCount: 4 }).layerCount).toBe(4);
    expect(StudioGenerationInput.parse({ ...generation, psdLayerMode: "AUTO" })).not.toHaveProperty("psdLayerCount");
    expect(generatedPsdLayerMode(generatedPsdIntent(undefined, "AUTO"))).toBe("AUTO");
    expect(generatedPsdLayerCount(generatedPsdIntent(undefined, "AUTO"))).toBeNull();
    expect(generatedPsdLayerMode(generatedPsdIntent(4))).toBe("MANUAL");
    expect(generatedPsdLayerMode({})).toBeNull();
  });
  it.each([{}, { layerMode: "MANUAL" }, { layerMode: "AUTO", layerCount: 4 }, { layerMode: null }, { layerMode: "AUTO", layerCount: null }])("rejects ambiguous mode/count input %j", fields => {
    expect(StudioDecompositionInput.safeParse({ ...input, ...fields }).success).toBe(false);
  });
  it.each([{ psdLayerMode: "AUTO", psdLayerCount: 4 }, { psdLayerMode: "MANUAL" }, { psdLayerMode: null }])("rejects inconsistent generation option %j", fields => {
    expect(StudioGenerationInput.safeParse({ ...generation, ...fields }).success).toBe(false);
  });
  it("uses actual dimensions to bound semantic groups without assuming PSD layers are all full-frame buffers", () => {
    expect(studioLayerMaxCount(2048, 2048, 40_000_000)).toBe(9);
    expect(studioLayerMaxCount(1024, 1024, 40_000_000)).toBe(10);
  });
  it("does not convert malformed AUTO journal records into manual fallback or a placeholder-count claim", () => {
    expect(readStudioLayerPlanning(null).mode).toBe("MANUAL");
    expect(() => readStudioLayerPlanning({ ...newStudioLayerPlanning("AUTO"), status: "SUCCEEDED" })).toThrow();
    expect(() => readStudioLayerPlanning({ ...newStudioLayerPlanning("MANUAL"), status: "RUNNING" })).toThrow();
    expect(() => readStudioLayerPlanning({ mode: "AUTO" })).toThrow();
  });
  it("validates the semantic result count, names and real provider execution evidence", () => {
    expect(StudioLayerPlanResponse.safeParse(result()).success).toBe(true);
    const mismatch = result(); mismatch.plan.layerCount = 4; expect(StudioLayerPlanResponse.safeParse(mismatch).success).toBe(false);
    const duplicates = result(); duplicates.plan.groups[1]!.name = duplicates.plan.groups[0]!.name; expect(StudioLayerPlanResponse.safeParse(duplicates).success).toBe(false);
    expect(StudioLayerPlanResponse.safeParse({ ...result(), usage: { provider: "MockVLMProvider", model: "mock", latencyMs: 1 } }).success).toBe(false);
  });
  it("cannot expose AUTO ready layers without successful genuine analysis metadata", () => {
    const layers = [0, 1].map(order => ({ assetId: `layer${order}`, assetSha256: "b".repeat(64), mimeType: "image/png", width: 8, height: 8, order, sizeBytes: 30,
      url: `/api/workspaces/w/assets/layer${order}/raw`, alphaBounds: { left: 0, top: 0, width: 8, height: 8 }, inkCoverage: .5 }));
    const view = { ...input, requestId: "r", layerCount: 2, sourceWidth: 8, sourceHeight: 8, status: "SUCCEEDED", error: null,
      createdAt: new Date().toISOString(), expiresAt: new Date().toISOString(), archiveExpiresAt: null, canRetryArchive: false, layers };
    expect(StudioDecompositionView.safeParse(view).success).toBe(true);
    expect(StudioDecompositionView.safeParse({ ...view, layerMode: "AUTO" }).success).toBe(false);
    expect(StudioDecompositionView.safeParse({ ...view, layerMode: "AUTO", analysisStatus: "PENDING" }).success).toBe(false);
    expect(StudioDecompositionView.safeParse({ ...view, layerMode: "AUTO", analysisStatus: "SUCCEEDED", analysisSummary: "主体与背景分别编辑" }).success).toBe(true);
  });
  it("preserves original editing intent separately from the whole-image caption", () => {
    const planning = readStudioLayerPlanning({ ...newStudioLayerPlanning("AUTO"), status: "SUCCEEDED", startedAt: new Date().toISOString(), result: result(10) });
    const userIntent = "用户输入".repeat(125);
    expect(semanticDecompositionIntent(userIntent, planning)).toBe(userIntent);
    expect(semanticDecompositionSourceCaption(planning)).toBe(result().plan.sourceCaption);
    expect(semanticDecompositionSourceCaption(planning)).not.toContain("组1");
  });
  it("reads old r1 journals unchanged without inventing a caption or reopening paid analysis", () => {
    const { sourceCaption: _caption, ...plan } = result().plan;
    const legacy = { revision: "semantic-layer-plan-r1", mode: "AUTO", status: "SUCCEEDED", startedAt: new Date().toISOString(),
      result: { ...result(), revision: "semantic-layer-plan-r1", plan } };
    const planning = readStudioLayerPlanning(legacy);
    expect(planning).toEqual(legacy);
    expect(semanticDecompositionSourceCaption(planning)).toBeUndefined();
    expect(semanticDecompositionIntent("把文字单独放一层", planning)).toBe("把文字单独放一层");
    // Pending r1 tasks can finish once on the current r2 service without rewriting their journal.
    expect(readStudioLayerPlanning({ ...planning, result: result() }).result?.revision).toBe("semantic-layer-plan-r2");
  });
  it("manual tasks omit captions even when editing intent is provided", () => {
    const manual = newStudioLayerPlanning("MANUAL");
    expect(manual.revision).toBe("semantic-layer-plan-r3");
    expect(semanticDecompositionSourceCaption(manual)).toBeUndefined();
    expect(semanticDecompositionIntent("拆成两层", manual)).toBe("拆成两层");
  });
  it.each([undefined, null, "", " \t\ufeff", 123, "x".repeat(2001), "😀".repeat(1001)])("r2 never fabricates a missing or invalid caption: %j", sourceCaption => {
    expect(StudioLayerPlanResponse.safeParse({ ...result(), plan: { ...result().plan, sourceCaption } }).success).toBe(false);
  });
});
