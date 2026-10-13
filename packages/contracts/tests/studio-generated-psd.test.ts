import { describe, expect, it } from "vitest";
import { StudioGenerationInput, StudioGenerationView } from "../src/studio-generation";
import { StudioGeneratedPsdView } from "../src/studio-generated-psd";
import { generatedPsdIntent, generatedPsdLayerCount, generatedPsdMutationId, generatedPsdSourceShapeId } from "../../../apps/web/src/lib/studio-generated-psd-state";

const input = { projectId: "p", mutationId: "831a0280-2cf1-41ba-ac94-621053c4a4c6", prompt: "tree", sizeSelection: { ratioKey: "1:1", resolutionTier: "1K" }, workflowRevision: 0, documentRevision: 0 };
const base = { projectId: "p", requestId: "r", requested: false, status: "NOT_REQUESTED", error: null, decomposition: null, downloadUrl: null };
describe("accepted automatic PSD choice and safe public receipt", () => {
  it("does not create any continuation when the user did not opt in", () => {
    expect(StudioGenerationInput.parse(input)).not.toHaveProperty("psdLayerCount");
    expect(generatedPsdIntent(undefined)).toEqual({});
    expect(generatedPsdLayerCount({})).toBeNull();
    expect(StudioGeneratedPsdView.parse(base)).toEqual(base);
  });
  it.each([null, 0, 1, 11, 2.5, "2", true])("rejects malformed or excessive PSD layer count %s", psdLayerCount => {
    expect(StudioGenerationInput.safeParse({ ...input, psdLayerCount }).success).toBe(false);
    expect(generatedPsdLayerCount({ studioPsdLayerCount: psdLayerCount })).toBeNull();
  });
  it.each([2, 4, 10])("freezes the explicit %i-layer selection and separate outbox", count => {
    expect(StudioGenerationInput.parse({ ...input, psdLayerCount: count }).psdLayerCount).toBe(count);
    expect(generatedPsdIntent(count)).toEqual({ studioPsdLayerCount: count, studioGeneratedPsd: { status: "PENDING", decompositionRequestId: null, error: null } });
    expect(generatedPsdLayerCount(generatedPsdIntent(count))).toBe(count);
  });
  it("uses a deterministic UUID and bounded shape identity independent of canvas state", () => {
    const first = generatedPsdMutationId("r", input.mutationId);
    expect(first).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(generatedPsdMutationId("r", input.mutationId)).toBe(first);
    expect(generatedPsdMutationId("other", input.mutationId)).not.toBe(first);
    expect(generatedPsdSourceShapeId("a".repeat(128))).toMatch(/^shape:generated-[a-f0-9]{40}$/);
  });
  it("never accepts READY/downloads without persisted layers or a private provider URL", () => {
    expect(StudioGeneratedPsdView.safeParse({ ...base, requested: true, status: "READY" }).success).toBe(false);
    expect(StudioGeneratedPsdView.safeParse({ ...base, requested: true, status: "RUNNING", downloadUrl: "/api/workspaces/w/studio/decomposition/d/export?projectId=p&format=psd" }).success).toBe(false);
    expect(StudioGeneratedPsdView.safeParse({ ...base, requested: true, status: "FAILED", error: "configuration missing" }).success).toBe(true);
    expect(StudioGeneratedPsdView.safeParse({ ...base, downloadUrl: "https://provider.invalid/private" }).success).toBe(false);
  });
  it("preserves old receipt compatibility while exposing the server-side selection", () => {
    const old = { requestId: "r", mutationId: input.mutationId, projectId: "p", generationId: "g", status: "PENDING", progress: null, expiresAt: "2026-10-13T00:06:00Z", archiveExpiresAt: null, archiveProcessingExpiresAt: null, displayText: "tree", resultState: "NOT_REQUESTED", results: [], error: null, archiveError: null, canRetryArchive: false };
    expect(StudioGenerationView.parse(old).psdLayerCount).toBeNull();
    expect(StudioGenerationView.parse({ ...old, psdLayerCount: 4 }).psdLayerCount).toBe(4);
  });
});
