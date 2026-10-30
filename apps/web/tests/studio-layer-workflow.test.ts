import { describe, expect, it } from "vitest";
import { StudioLayerAssessment, StudioLayerPlanResponse, StudioDecompositionView } from "@brandai/contracts";
import { newStudioLayerPlanning, readStudioLayerPlanning, semanticDecompositionSourceCaption, studioLayerWorkflow } from "../src/lib/studio-decomposition-planning";
import { partitionOwnedLayerTasks } from "../src/components/owned-canvas/owned-layer-options";

const assessment = { occlusions: [{ target: "草地", kind: "CONTINUOUS_TEXTURE", action: "INFER_BACKGROUND", evidence: "周边草纹连续", reason: "可合理推断纹理" }],
  preserve: ["保留足球、未编辑的白线和草地"], shadowPolicy: "KEEP_WITH_SUBJECT", shadowEvidence: "左侧投影与足球接触" };
const r3 = { revision: "semantic-layer-plan-r3", plan: { layerCount: 2, summary: "足球和草地分开检查", sourceCaption: "草地上有足球和左侧投影。",
  groups: [{ name: "草地", description: "连续绿色草地" }, { name: "足球", description: "黑白足球" }], assessment },
  usage: { provider: "HttpVLMProvider", model: "fixture", latencyMs: 1 } };

describe("content-aware layer workflow", () => {
  it.each(["CONTINUOUS_TEXTURE", "REGULAR_STRUCTURE"])("permits conditional inference for %s, never a completed repair", kind => {
    const plan = StudioLayerPlanResponse.parse({ ...r3, plan: { ...r3.plan, assessment: { ...assessment, occlusions: [{ ...assessment.occlusions[0], kind }] } } });
    const planning = readStudioLayerPlanning({ ...newStudioLayerPlanning("AUTO"), status: "SUCCEEDED", startedAt: "2026-10-30T00:00:00Z", result: plan });
    expect(semanticDecompositionSourceCaption(planning)).toBe(r3.plan.sourceCaption);
    expect(studioLayerWorkflow({ status: "SUCCEEDED", providerStartedAt: new Date(), archiveToken: null }, planning)).toMatchObject({
      stage: "READY_FOR_REVIEW", backgroundCompletion: "NOT_PERFORMED", independentQuality: "NOT_REVIEWED" });
  });
  it.each(["TEXT_OR_LOGO", "IDENTITY_OR_PRODUCT", "ATTACHED_OBJECTS", "TRANSPARENCY_OR_REFLECTION"])("rejects unreferenced reconstruction of %s", kind => {
    const value = { ...assessment, occlusions: [{ ...assessment.occlusions[0], kind }] };
    expect(StudioLayerAssessment.safeParse(value).success).toBe(false);
    expect(StudioLayerAssessment.safeParse({ ...value, occlusions: [{ ...value.occlusions[0], action: "REFERENCE_REQUIRED" }] }).success).toBe(true);
  });
  it("does not backfill an r3 assessment or run a model for saved r1/r2 records", () => {
    const { assessment: _assessment, ...captionPlan } = r3.plan;
    const { sourceCaption: _caption, ...legacyPlan } = captionPlan;
    for (const [revision, plan] of [["semantic-layer-plan-r2", captionPlan], ["semantic-layer-plan-r1", legacyPlan]] as const) {
      const saved = { revision, mode: "AUTO", status: "SUCCEEDED", startedAt: "2026-10-29T00:00:00Z", result: { ...r3, revision, plan } };
      const parsed = readStudioLayerPlanning(saved); expect(parsed).toEqual(saved);
      expect(studioLayerWorkflow({ status: "SUCCEEDED", providerStartedAt: null, archiveToken: null }, parsed).assessment).toBeNull();
      expect(StudioLayerPlanResponse.safeParse({ ...r3, plan }).success).toBe(false);
    }
  });
  it("reports actual analysis, provider and archive claims, including terminal precedence", () => {
    const pending = newStudioLayerPlanning("AUTO"), running = { ...pending, status: "RUNNING" as const, startedAt: new Date().toISOString() };
    const row = { status: "PENDING", providerStartedAt: null, archiveToken: null };
    expect(studioLayerWorkflow(row, pending).stage).toBe("QUEUED");
    expect(studioLayerWorkflow({ ...row, status: "RUNNING" }, running).stage).toBe("ANALYZING");
    expect(studioLayerWorkflow({ ...row, providerStartedAt: new Date() }, pending).stage).toBe("DECOMPOSING");
    expect(studioLayerWorkflow({ ...row, archiveToken: "claim" }, pending).stage).toBe("CHECKING_AND_SAVING");
    expect(studioLayerWorkflow({ ...row, status: "FAILED", archiveToken: "claim" }, pending).stage).toBe("FAILED");
  });
  it("collapses only terminal history and retains all live tasks without changing their order in storage", () => {
    const task = (requestId: string, status: string, day: number) => StudioDecompositionView.parse({ requestId, mutationId: "831a0280-2cf1-41ba-ac94-621053c4a4c6", projectId: "p", sourceShapeId: "shape:s", assetId: "a", assetSha256: "a".repeat(64),
      documentRevision: 0, layerCount: 2, sourceWidth: 8, sourceHeight: 8, status, error: null, createdAt: `2026-10-${day}T00:00:00Z`, expiresAt: "2026-10-31T00:00:00Z", archiveExpiresAt: null, canRetryArchive: false, layers: [] });
    const tasks = [task("old403", "FAILED", 20), task("new", "PENDING", 30), task("running", "RUNNING", 29)];
    const grouped = partitionOwnedLayerTasks(tasks);
    expect(grouped.current.map(item => item.requestId)).toEqual(["new", "running"]);
    expect(grouped.history.map(item => item.requestId)).toEqual(["old403"]);
    expect(tasks[0]!.requestId).toBe("old403");
  });
});
