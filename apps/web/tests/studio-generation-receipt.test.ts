import { beforeEach, afterEach, expect, it, vi } from "vitest";
vi.mock("../src/auth", () => ({ auth: vi.fn() }));
const f = vi.hoisted(() => ({ save: vi.fn(), permission: vi.fn(), get: vi.fn(), stage: vi.fn(), archive: vi.fn(), usage: vi.fn() }));
vi.mock("@brandai/db", () => ({ prisma: { studioGenerationRequest: { updateMany: f.save }, $transaction: async (fn: Function) => fn({}) } }));
vi.mock("../src/lib/studio-generation-artifacts", () => ({ requireArtifactWrite: f.permission, ensureStudioGenerationArtifacts: f.archive }));
vi.mock("../src/lib/ai", () => ({ readSubmittedStudioImage: f.get }));
vi.mock("../src/lib/studio-generation-lifecycle", () => ({ stageStudioGenerationOutput: f.stage }));
vi.mock("../src/lib/usage", () => ({ recordUsage: f.usage, fromGenerateUsage: () => ({}) }));
import { saveStudioImageCheckpoint, recoverSubmittedGeneration } from "../src/lib/studio-generation-receipt";
import type { StudioRequest } from "../src/lib/studio-generation-lifecycle";
import { randomBytes } from "node:crypto";

function row(): StudioRequest {
  return { id: "request", generationId: "generation", workspaceId: "workspace", projectId: "project", userId: "user",
    providerStartedAt: new Date(), expiresAt: new Date(Date.now() + 60_000), status: "RUNNING", contextHash: "context",
    jobData: {}, receiptCheckpoint: null } as StudioRequest;
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("SETTINGS_ENC_KEY", randomBytes(32).toString("hex"));
});
afterEach(() => vi.unstubAllEnvs());
async function submitted() {
  const request = row();
  f.save.mockResolvedValueOnce({ count: 1 });
  await saveStudioImageCheckpoint(request, "http://original", "original-secret", { imageKind: "GENERATED" });
  request.receiptCheckpoint = f.save.mock.calls[0]![0].data.receiptCheckpoint;
  expect(request.receiptCheckpoint).not.toContain("original");
  return request;
}
it("binds the checkpoint to the accepted generation, tenant and provider attempt", async () => {
  const request = await submitted();
  for (const change of [{ workspaceId: "other" }, { projectId: "other" }, { userId: "other" }, { generationId: "other" },
    { id: "other" }, { contextHash: "other" }, { providerStartedAt: new Date(0) }]) {
    await expect(recoverSubmittedGeneration({ ...request, ...change })).rejects.toThrow("identity changed");
  }
  expect(f.get).not.toHaveBeenCalled();
});
it("checks active project write access before reading the original service", async () => {
  const request = await submitted();
  f.permission.mockRejectedValueOnce(new Error("access revoked"));
  await expect(recoverSubmittedGeneration(request)).rejects.toThrow("access revoked");
  expect(f.get).not.toHaveBeenCalled();
  expect(f.stage).not.toHaveBeenCalled();
});
it("never stages a missing, expired or multi-image recovery", async () => {
  const request = await submitted();
  await recoverSubmittedGeneration({ ...request, receiptCheckpoint: null });
  await recoverSubmittedGeneration({ ...request, expiresAt: new Date(0) });
  expect(f.get).not.toHaveBeenCalled();
  const image = { imageUrl: "data:image/png;base64,YQ==", width: 10, height: 10, params: {} };
  f.get.mockResolvedValueOnce({ versions: [image, image] });
  await expect(recoverSubmittedGeneration(request)).rejects.toThrow();
  expect(f.get).toHaveBeenCalledWith("http://original", request.id, "original-secret", expect.any(AbortSignal));
  expect(f.stage).not.toHaveBeenCalled();
});
