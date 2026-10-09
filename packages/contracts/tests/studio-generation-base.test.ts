import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ upload: vi.fn(), get: vi.fn() }));
vi.mock("../../../apps/web/src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("../../../apps/web/src/lib/s3", () => ({ uploadBuffer: f.upload, getObjectStream: f.get }));
vi.mock("../../../apps/web/src/lib/ssrf", () => ({ safeFetch: vi.fn() }));
vi.mock("../../../apps/web/src/lib/watermark", () => ({ applyWatermarksToImage: vi.fn() }));
import { decryptStudioBase, encryptStudioBase, readStudioCleanBase, requireStudioBaseEncryption, storeStudioCleanBase, type StudioCleanBase } from "../../../apps/web/src/lib/studio-generation-base";
import { STUDIO_ARTIFACT_MAX_BYTES } from "../../../apps/web/src/lib/studio-generation-artifacts-image";

const owner = { workspaceId: "workspace", projectId: "project", outputId: "output-0" };
const deadline = () => AbortSignal.timeout(5_000);
const image = () => sharp({ create: { width: 3, height: 2, channels: 4, background: "#874edd" } }).png().toBuffer();
const sha = (body: Buffer) => createHash("sha256").update(body).digest("hex");
let objects: Map<string, Buffer>;
beforeEach(() => {
  vi.resetAllMocks(); objects = new Map();
  // Synthetic test material only. Never read a real environment key.
  vi.stubEnv("SETTINGS_ENC_KEY", "unit-test-clean-base-key-v1");
  vi.stubEnv("AUTH_SECRET", "unit-test-auth-fallback-v1");
  f.upload.mockImplementation(async (body: Buffer, _type: string, _prefix: string, _signal: AbortSignal, key: string) => {
    objects.set(key, Buffer.from(body)); return { key, url: `https://public-fixture.invalid/${key}` };
  });
  f.get.mockImplementation(async (key: string) => {
    const bytes = objects.get(key); if (!bytes) throw new Error("fixture object absent");
    return { body: Readable.from(bytes), contentLength: bytes.length, contentType: "application/octet-stream" };
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("private generated clean-base storage (real AES-GCM and local image bytes)", () => {
  it("round-trips real ciphertext with randomized IV and authenticated owner", async () => {
    const raw = await image(), a = encryptStudioBase(raw, owner), b = encryptStudioBase(raw, owner);
    expect(a.subarray(0, 4).toString()).toBe("NSB1");
    expect(a.length).toBe(raw.length + 32);
    expect(a).not.toEqual(b); expect(a.includes(raw)).toBe(false);
    expect(decryptStudioBase(a, owner)).toEqual(raw);
    expect(decryptStudioBase(b, owner)).toEqual(raw);
  });

  it("rejects changed ciphertext, IV, tag and format", async () => {
    const encrypted = encryptStudioBase(await image(), owner);
    for (const position of [0, 4, 16, 32, encrypted.length - 1]) {
      const altered = Buffer.from(encrypted); altered[position] = altered[position]! ^ 1;
      expect(() => decryptStudioBase(altered, owner)).toThrow();
    }
    expect(() => decryptStudioBase(encrypted.subarray(0, 32), owner)).toThrow();
  });

  it("rejects a different workspace, project or output through GCM AAD", async () => {
    const encrypted = encryptStudioBase(await image(), owner);
    for (const changed of [{ ...owner, workspaceId: "another" }, { ...owner, projectId: "another" }, { ...owner, outputId: "another" }]) {
      expect(() => decryptStudioBase(encrypted, changed)).toThrow();
    }
    expect(() => encryptStudioBase(Buffer.from("source"), { ...owner, projectId: "../other" })).toThrow();
  });

  it("requires server key material and supports the explicit auth-secret fallback", async () => {
    const raw = await image();
    vi.stubEnv("SETTINGS_ENC_KEY", ""); vi.stubEnv("AUTH_SECRET", "");
    expect(() => requireStudioBaseEncryption()).toThrow();
    await expect(storeStudioCleanBase(raw, owner, deadline())).rejects.toMatchObject({ status: 503 });
    expect(f.upload).not.toHaveBeenCalled();
    vi.stubEnv("AUTH_SECRET", "unit-test-auth-fallback-v1");
    expect(() => requireStudioBaseEncryption()).not.toThrow();
    const encrypted = encryptStudioBase(raw, owner);
    expect(decryptStudioBase(encrypted, owner)).toEqual(raw);
  });

  it("fails closed after key rotation and decrypts again with the original key", async () => {
    const raw = await image(), encrypted = encryptStudioBase(raw, owner);
    vi.stubEnv("AUTH_SECRET", "rotated-auth-secret-does-not-override-dedicated-key");
    expect(decryptStudioBase(encrypted, owner)).toEqual(raw);
    vi.stubEnv("SETTINGS_ENC_KEY", "unit-test-clean-base-key-v2");
    expect(() => decryptStudioBase(encrypted, owner)).toThrow();
    vi.stubEnv("SETTINGS_ENC_KEY", "unit-test-clean-base-key-v1");
    expect(decryptStudioBase(encrypted, owner)).toEqual(raw);
  });

  it("stores only encrypted bytes and independently validates the plaintext on read", async () => {
    const raw = await image(), metadata = await storeStudioCleanBase(raw, owner, deadline());
    expect(metadata.keyRevision).toMatch(/^[a-f0-9]{24}$/);
    expect(metadata).toEqual({ schemaVersion: 1, encoding: "aes-256-gcm-v1", keyRevision: metadata.keyRevision, objectKey: `workspace/studio-generation-bases/project/output-0/${sha(raw)}/${metadata.keyRevision}`,
      sha256: sha(raw), mimeType: "image/png", width: 3, height: 2, sizeBytes: raw.length });
    const stored = objects.get(metadata.objectKey)!;
    expect(stored).not.toEqual(raw); expect(stored.includes(raw)).toBe(false);
    expect(f.upload).toHaveBeenCalledWith(stored, "application/octet-stream", "workspace/studio-generation-bases/project", expect.any(AbortSignal), metadata.objectKey);
    expect(await readStudioCleanBase(metadata, owner, deadline())).toEqual(raw);
    expect(f.get).toHaveBeenCalledWith(metadata.objectKey, expect.any(AbortSignal));
    expect(metadata).not.toHaveProperty("url");
  });

  it("can read either complete randomized envelope after a same-key late rewrite", async () => {
    const raw = await image(), first = await storeStudioCleanBase(raw, owner, deadline());
    const oldEnvelope = Buffer.from(objects.get(first.objectKey)!);
    const second = await storeStudioCleanBase(raw, owner, deadline());
    expect(second).toEqual(first); expect(objects.get(first.objectKey)).not.toEqual(oldEnvelope);
    expect(await readStudioCleanBase(first, owner, deadline())).toEqual(raw);
    objects.set(first.objectKey, oldEnvelope);
    expect(await readStudioCleanBase(second, owner, deadline())).toEqual(raw);
  });

  it("uses distinct object keys across key revisions and isolates a late old-key write", async () => {
    const raw = await image(), oldMetadata = await storeStudioCleanBase(raw, owner, deadline());
    const oldEnvelope = Buffer.from(objects.get(oldMetadata.objectKey)!);
    vi.stubEnv("SETTINGS_ENC_KEY", "unit-test-clean-base-key-v2");
    const newMetadata = await storeStudioCleanBase(raw, owner, deadline());
    const newEnvelope = Buffer.from(objects.get(newMetadata.objectKey)!);
    expect(newMetadata.sha256).toBe(oldMetadata.sha256);
    expect(newMetadata.keyRevision).not.toBe(oldMetadata.keyRevision);
    expect(newMetadata.objectKey).not.toBe(oldMetadata.objectKey);
    expect(objects.size).toBe(2);
    expect(objects.get(oldMetadata.objectKey)).toEqual(oldEnvelope);
    expect(await readStudioCleanBase(newMetadata, owner, deadline())).toEqual(raw);
    f.get.mockClear();
    await expect(readStudioCleanBase(oldMetadata, owner, deadline())).rejects.toMatchObject({ status: 503 });
    expect(f.get).not.toHaveBeenCalled();
    // Simulate a previous deployment finishing its upload after the new writer.
    vi.stubEnv("SETTINGS_ENC_KEY", "unit-test-clean-base-key-v1");
    const lateMetadata = await storeStudioCleanBase(raw, owner, deadline());
    expect(lateMetadata).toEqual(oldMetadata);
    expect(objects.get(newMetadata.objectKey)).toEqual(newEnvelope);
    expect(await readStudioCleanBase(oldMetadata, owner, deadline())).toEqual(raw);
    vi.stubEnv("SETTINGS_ENC_KEY", "unit-test-clean-base-key-v2");
    expect(await readStudioCleanBase(newMetadata, owner, deadline())).toEqual(raw);
  });

  it("rejects another owner's key or invalid encoding before issuing an object read", async () => {
    const metadata = await storeStudioCleanBase(await image(), owner, deadline());
    for (const bad of [{ ...metadata, objectKey: "another/key" }, { ...metadata, schemaVersion: 2 }, { ...metadata, encoding: "plain" }, { ...metadata, sha256: "guess" }, { ...metadata, keyRevision: "invalid" }]) {
      await expect(readStudioCleanBase(bad as StudioCleanBase, owner, deadline())).rejects.toMatchObject({ status: 422 });
    }
    await expect(readStudioCleanBase(metadata, { ...owner, workspaceId: "another" }, deadline())).rejects.toMatchObject({ status: 422 });
    expect(f.get).not.toHaveBeenCalled();
  });

  it("rejects valid ciphertext with stale SHA, dimensions, MIME or byte length metadata", async () => {
    const metadata = await storeStudioCleanBase(await image(), owner, deadline());
    for (const bad of [{ ...metadata, width: 4 }, { ...metadata, height: 3 }, { ...metadata, mimeType: "image/jpeg" }, { ...metadata, sizeBytes: metadata.sizeBytes + 1 }]) {
      await expect(readStudioCleanBase(bad, owner, deadline())).rejects.toMatchObject({ status: 422 });
    }
    const changedSha = "a".repeat(64), wrongKey = metadata.objectKey.replace(metadata.sha256, changedSha);
    objects.set(wrongKey, objects.get(metadata.objectKey)!);
    await expect(readStudioCleanBase({ ...metadata, sha256: changedSha, objectKey: wrongKey }, owner, deadline())).rejects.toMatchObject({ status: 422 });
  });

  it("rejects corrupted object bytes and a rotated storage key through the read helper", async () => {
    const metadata = await storeStudioCleanBase(await image(), owner, deadline());
    const encrypted = objects.get(metadata.objectKey)!;
    encrypted[encrypted.length - 1] = encrypted[encrypted.length - 1]! ^ 1;
    await expect(readStudioCleanBase(metadata, owner, deadline())).rejects.toMatchObject({ status: 422 });
    await storeStudioCleanBase(await image(), owner, deadline());
    vi.stubEnv("SETTINGS_ENC_KEY", "unit-test-clean-base-key-v2");
    f.get.mockClear();
    await expect(readStudioCleanBase(metadata, owner, deadline())).rejects.toMatchObject({ status: 503 });
    expect(f.get).not.toHaveBeenCalled();
  });

  it("destroys an object with oversized declared length without consuming it", async () => {
    const metadata = await storeStudioCleanBase(await image(), owner, deadline());
    const body = new Readable({ read() {} });
    f.get.mockResolvedValueOnce({ body, contentLength: STUDIO_ARTIFACT_MAX_BYTES + 33 });
    await expect(readStudioCleanBase(metadata, owner, deadline())).rejects.toMatchObject({ status: 422 });
    expect(body.destroyed).toBe(true);
  });

  it("bounds an object stream even when content length is absent", async () => {
    const metadata = await storeStudioCleanBase(await image(), owner, deadline());
    const chunk = Buffer.alloc(1024 * 1024), body = Readable.from(Array.from({ length: 33 }, () => chunk));
    f.get.mockResolvedValueOnce({ body });
    await expect(readStudioCleanBase(metadata, owner, deadline())).rejects.toThrow();
    expect(body.destroyed).toBe(true);
  });

  it("honors cancellation before storage and bounds a stalled source adapter", async () => {
    const raw = await image(), controller = new AbortController(); controller.abort(new Error("cancelled"));
    await expect(storeStudioCleanBase(raw, owner, controller.signal)).rejects.toThrow("cancelled");
    expect(f.upload).not.toHaveBeenCalled();
    const metadata = await storeStudioCleanBase(raw, owner, deadline());
    const running = new AbortController();
    f.get.mockImplementationOnce(() => { setTimeout(() => running.abort(new Error("deadline")), 5); return new Promise(() => {}); });
    await expect(readStudioCleanBase(metadata, owner, running.signal)).rejects.toThrow("deadline");
  });
});
