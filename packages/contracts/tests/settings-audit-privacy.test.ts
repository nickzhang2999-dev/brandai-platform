import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ findUnique: vi.fn(), upsert: vi.fn() }));
vi.mock("../../db/src/index", () => ({ prisma: { appSetting: f } }));
import { setRegistrationOpen, updateAiSettings } from "../../../apps/web/src/lib/settings";
import { decryptSecret } from "../../../apps/web/src/lib/crypto";

const actor = { id: "authorized-admin", email: "audit-canary@example.invalid" };
let logs: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.stubEnv("SETTINGS_ENC_KEY", "disposable-audit-encryption-test-only");
  f.findUnique.mockReset().mockResolvedValue(null); f.upsert.mockReset().mockResolvedValue({});
  logs = vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const output = () => logs.mock.calls.map(call => call.join(" ")).join("\n");

describe("administrator settings audit contains changes without configuration contents", () => {
  it("encrypts saved keys while excluding URLs, identities and instructions from the audit", async () => {
    const secret = "provider-secret-canary", endpoint = "https://private-gateway.invalid/v1?token=endpoint-secret-canary", prompt = "private system instruction canary";
    await updateAiSettings({ image: { provider: "openai", model: "private-model-canary", baseUrl: endpoint, apiKey: secret },
      storage: { endpoint, bucket: "private-bucket-canary", accessKey: "access-key-canary", secretKey: secret }, imageSystemPrompt: prompt }, actor);
    const write = f.upsert.mock.calls[0]![0];
    expect(decryptSecret(write.update.imageApiKey)).toBe(secret); expect(decryptSecret(write.update.storageSecretKey)).toBe(secret);
    expect(write.update.updatedById).toBe(actor.id); expect(write.update.imageBaseUrl).toBe(endpoint);
    expect(output()).toContain("imageApiKey=set"); expect(output()).toContain("imageBaseUrl=set"); expect(output()).toContain("storageAccessKey=set");
    for (const privateValue of [secret, endpoint, prompt, actor.email, "private-model-canary", "private-bucket-canary", "access-key-canary"]) expect(output()).not.toContain(privateValue);
  });
  it("reports clearing fields without copying their previous stored contents", async () => {
    f.findUnique.mockResolvedValue({ imageBaseUrl: "https://previous-private.invalid/v1", imageApiKey: "previous-encrypted-secret", imageModel: "prior-private-model" });
    await updateAiSettings({ image: { apiKey: "", baseUrl: "", model: "" } }, actor);
    expect(output()).toContain("imageApiKey=cleared"); expect(output()).toContain("imageBaseUrl=cleared");
    for (const hidden of ["previous-private", "previous-encrypted", "prior-private", actor.email]) expect(output()).not.toContain(hidden);
    expect(f.upsert.mock.calls[0]![0].update).toMatchObject({ imageApiKey: null, imageBaseUrl: null, imageModel: null });
  });
  it("does not claim a field changed when its persisted value is identical", async () => {
    f.findUnique.mockResolvedValue({ imageProvider: "openai" });
    await updateAiSettings({ image: { provider: "openai" } }, actor);
    expect(output()).toContain("no field changes"); expect(output()).not.toContain("imageProvider=set");
  });
  it("does not emit a success audit after a rejected database write", async () => {
    f.upsert.mockRejectedValue(new Error("unavailable"));
    await expect(updateAiSettings({ image: { model: "test-model" } }, actor)).rejects.toThrow("unavailable");
    expect(logs).not.toHaveBeenCalled();
  });
  it("keeps the registration actor ID without repeating the account email", async () => {
    await setRegistrationOpen(false, actor);
    expect(f.upsert.mock.calls[0]![0].update).toEqual({ updatedById: actor.id, registrationOpen: false });
    expect(output()).toContain("CLOSED"); expect(output()).toContain(actor.id); expect(output()).not.toContain(actor.email);
  });
});
