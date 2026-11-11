import { describe, it, expect, vi } from "vitest";
import { IMAGE26_MODEL, runImage26Upgrade } from "../src/lib/image-model-upgrade";
function fixture() {
  const proof = { id: "synthetic-receipt", requestedModel: IMAGE26_MODEL, returnedModel: null, requestId: "synthetic-upstream-id", imageKey: "fixture.png", sha256: "fixture-hash", totalTokens: 123 };
  return { previousModel: "gpt-image-2", configured: true, alreadyApplied: false, probe: vi.fn(async () => true), generate: vi.fn(async () => proof), persist: vi.fn(async () => {}) };
}
describe("one-time production image model upgrade", () => {
  it("verifies the actual request before persisting the model", async () => {
    const d = fixture(); const result = await runImage26Upgrade(d);
    expect(result).toMatchObject({ status: "applied", configuredModel: IMAGE26_MODEL, requestId: "synthetic-upstream-id" });
    expect(d.persist).toHaveBeenCalledWith(IMAGE26_MODEL, expect.objectContaining({ requestedModel: IMAGE26_MODEL }));
    expect(d.generate.mock.invocationCallOrder[0]).toBeLessThan(d.persist.mock.invocationCallOrder[0]);
  });
  it("preserves later admin overrides and does not repeat a paid request", async () => {
    const d = { ...fixture(), previousModel: "explicit-later-model", alreadyApplied: true };
    expect(await runImage26Upgrade(d)).toEqual({ status: "already-applied", configuredModel: "explicit-later-model" });
    expect(d.generate).not.toHaveBeenCalled(); expect(d.persist).not.toHaveBeenCalled();
  });
  it("does not call a provider without existing configuration", async () => {
    const d = { ...fixture(), configured: false }; await expect(runImage26Upgrade(d)).rejects.toThrow();
    expect(d.probe).not.toHaveBeenCalled();
  });
  it("does not spend or change configuration for an unavailable target", async () => {
    const d = fixture(); d.probe.mockResolvedValue(false); await expect(runImage26Upgrade(d)).rejects.toThrow("unavailable");
    expect(d.generate).not.toHaveBeenCalled(); expect(d.persist).not.toHaveBeenCalled();
  });
  it("preserves configuration if generation fails or reports a different model", async () => {
    const d = fixture(); d.generate.mockRejectedValueOnce(new Error("upstream failure"));
    await expect(runImage26Upgrade(d)).rejects.toThrow("upstream failure"); expect(d.persist).not.toHaveBeenCalled();
    d.generate.mockResolvedValueOnce({ ...await fixture().generate(), returnedModel: "gpt-image-2" } as never);
    await expect(runImage26Upgrade(d)).rejects.toThrow("mismatch"); expect(d.persist).not.toHaveBeenCalled();
  });
});
