import { beforeEach, describe, expect, it, vi } from "vitest";
import { StudioGenerationInput, StudioGenerationQuery, StudioGenerationRetryInput, StudioGenerationView } from "../src/studio-generation";
const f = vi.hoisted(() => ({ config: vi.fn(), storage: vi.fn() }));
vi.mock("../../../apps/web/src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("../../../apps/web/src/lib/settings", () => ({ getEffectiveAiSettings: f.config, getEffectiveStorage: f.storage }));
vi.mock("../../../apps/web/src/lib/generation-prepare", () => ({ prepareGeneration: vi.fn() }));
vi.mock("../../../apps/web/src/lib/rules", () => ({ getConfirmedRules: vi.fn() }));
vi.mock("../../../apps/web/src/lib/studio-generation-artifacts", () => ({ requireArtifactWrite: vi.fn() }));
vi.mock("../../../apps/web/src/lib/studio-project-materials", () => ({ listStudioProjectMaterials: vi.fn() }));
vi.mock("../../../apps/web/src/lib/studio-generation-edit", () => ({ resolveStudioEditSource: vi.fn(), inspectStudioEditSource: vi.fn(), assertStudioEditNotModelReference: vi.fn() }));
import { hashStudioPayload, assertStudioGenerationCapacity, validateStudioOutputSource, requireStudioGenerationServices } from "../../../apps/web/src/lib/studio-generation-policy";
const body = { projectId: "p", mutationId: "831a0280-2cf1-41ba-ac94-621053c4a4c6", prompt: " Draw a tree ", sizeSelection: { ratioKey: "1:1", resolutionTier: "1K" }, workflowRevision: 0, documentRevision: 0 };
beforeEach(() => { vi.resetAllMocks(); f.config.mockResolvedValue({ image: { provider: "openai", apiKey: "fixture" } }); f.storage.mockResolvedValue({ configured: true }); });
describe("product generation strict intent and boundaries", () => {
  it("accepts only a frame identity and never accepts client ownership, URLs, geometry or extra model settings", () => {
    expect(StudioGenerationInput.parse(body).prompt).toBe("Draw a tree");
    for (const extra of [{ userId: "foreign" }, { assetUsages: [] }, { studioExpectedAssetSha256: { asset: "a".repeat(64) } }, { imageUrl: "http://private" }, { provider: "mock" }]) expect(StudioGenerationInput.safeParse({ ...body, ...extra }).success).toBe(false);
    expect(StudioGenerationInput.safeParse({ ...body, sizeSelection: { ...body.sizeSelection, model: "changed" } }).success).toBe(false);
    expect(StudioGenerationInput.safeParse({ ...body, prompt: "   " }).success).toBe(false);
    expect(StudioGenerationInput.safeParse({ ...body, documentRevision: "0" }).success).toBe(false);
    expect(StudioGenerationInput.parse({ ...body, outputFrameId: "shape:frame" }).outputFrameId).toBe("shape:frame");
    for (const outputFrameId of [null, "frame", "shape:f\n", { x: 2 }]) expect(StudioGenerationInput.safeParse({ ...body, outputFrameId }).success).toBe(false);
    expect(StudioGenerationInput.safeParse({ ...body, studioExactLayout: {} }).success).toBe(false);
  });
  it("shares current-user query and explicit archive retry identities", () => {
    expect(StudioGenerationQuery.parse({ projectId: "p" })).toEqual({ projectId: "p" });
    expect(StudioGenerationQuery.safeParse({ projectId: "p", requestId: null }).success).toBe(false);
    expect(StudioGenerationRetryInput.safeParse({ projectId: "p" }).success).toBe(false);
    expect(StudioGenerationRetryInput.parse({ projectId: "p", requestId: "sgr_a" }).requestId).toBe("sgr_a");
  });
  it("has independent generation/archive deadlines and authenticated result URLs", () => {
    const view = { requestId: "r", mutationId: body.mutationId, projectId: "p", generationId: "g", status: "SUCCEEDED", progress: null, expiresAt: "2026-10-09T00:06:00Z", archiveExpiresAt: "2026-10-10T00:06:00Z", archiveProcessingExpiresAt: null, displayText: "tree", resultState: "FAILED", results: [], error: null, archiveError: "archive unavailable", canRetryArchive: true };
    expect(StudioGenerationView.safeParse(view).success).toBe(true);
    expect(StudioGenerationView.safeParse({ ...view, progress: 99 }).success).toBe(false);
    expect(StudioGenerationView.safeParse({ ...view, results: [{ versionId: "v", assetId: "a", assetSha256: "a".repeat(64), width: 1, height: 1, mimeType: "image/png", url: "blob:temporary" }] }).success).toBe(false);
  });
  it("canonical hashes survive Postgres JSON key ordering but reflect meaningful selection changes", () => {
    expect(hashStudioPayload({ a: 1, b: { x: 2, y: 3 } })).toBe(hashStudioPayload({ b: { y: 3, x: 2 }, a: 1 }));
    expect(hashStudioPayload(body)).not.toBe(hashStudioPayload({ ...body, prompt: "another" }));
    expect(hashStudioPayload({ ...body, outputFrameId: "shape:one" })).not.toBe(hashStudioPayload({ ...body, outputFrameId: "shape:two" }));
  });
  it("bounds all unfinished raw output reservations", () => {
    expect(() => assertStudioGenerationCapacity(3, 15)).not.toThrow();
    expect(() => assertStudioGenerationCapacity(4, 4)).toThrow();
    expect(() => assertStudioGenerationCapacity(1, 16)).toThrow();
  });
  it("distinguishes retained bytes from temporary upstream URLs, rejecting active or oversized formats", () => {
    expect(validateStudioOutputSource("data:image/png;base64,YWJjZA==")).toBe("bytes");
    expect(validateStudioOutputSource("https://images.example/a.png")).toBe("upstream-url");
    for (const source of ["data:image/svg+xml;base64,YWJjZA==", "data:image/png;base64,a", "javascript:alert(1)", "https://user:secret@host/x"]) expect(() => validateStudioOutputSource(source)).toThrow();
  });
  it("rejects mock, missing credentials and absent durable storage before reserving quota", async () => {
    await expect(requireStudioGenerationServices()).resolves.toBeUndefined();
    f.config.mockResolvedValue({ image: { provider: "mock", apiKey: "fixture" } }); await expect(requireStudioGenerationServices()).rejects.toMatchObject({ status: 503 });
    for (const provider of [" MOCK ", "mOcK", "", "   "]) {
      f.config.mockResolvedValue({ image: { provider, apiKey: "fixture" } }); await expect(requireStudioGenerationServices()).rejects.toMatchObject({ status: 503 });
    }
    f.config.mockResolvedValue({ image: { provider: "openai", apiKey: "" } }); await expect(requireStudioGenerationServices()).rejects.toMatchObject({ status: 503 });
    f.config.mockResolvedValue({ image: { provider: "openai", apiKey: "fixture" } }); f.storage.mockResolvedValue({ configured: false }); await expect(requireStudioGenerationServices()).rejects.toMatchObject({ status: 503 });
  });
});
