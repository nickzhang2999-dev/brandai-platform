import { describe, expect, it, vi } from "vitest";
import { createDocumentSession, createNovartApiClient, NovartApiError } from "../../../apps/web/src/lib/novart-api-client";

const empty = { projectId: "p", workspaceId: "w", format: "novart-native-v1" as const, canvas: "", revision: 0, checksum: null, updatedAt: null, readOnly: false };
const canvas = "SHAKKERDATA://AAAA";
const saved = { ...empty, canvas, revision: 1, checksum: "a".repeat(64), updatedAt: "2026-10-08T00:00:00.000Z" };
const setup = () => {
  const api = { ...createNovartApiClient(), readDocument: vi.fn().mockResolvedValue(empty), saveDocument: vi.fn().mockResolvedValue(saved) };
  return { api, session: createDocumentSession(api, "w", "p") };
};

describe("product document client", () => {
  it("does not overlap restores or save while a reload is still pending", async () => {
    const { api, session } = setup(); await session.load();
    let finish!: (value: typeof empty) => void;
    api.readDocument.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const loading = session.load();
    await expect(session.load()).rejects.toThrow();
    await expect(session.save(canvas)).rejects.toThrow();
    expect(api.saveDocument).not.toHaveBeenCalled();
    finish(empty); await loading;
    await session.save(canvas);
  });
  it("does not save before restore or silently replace read-only state", async () => {
    const { api, session } = setup();
    await expect(session.save(canvas)).rejects.toThrow();
    api.readDocument.mockResolvedValueOnce({ ...empty, readOnly: true });
    await session.load();
    await expect(session.save(canvas)).rejects.toThrow();
    expect(api.saveDocument).not.toHaveBeenCalled();
  });
  it("retries an uncertain write with the original revision and mutation id", async () => {
    const { api, session } = setup(); await session.load();
    api.saveDocument.mockRejectedValueOnce(new NovartApiError("lost", null, undefined, true));
    await expect(session.save(canvas)).rejects.toThrow("lost");
    expect(session.pending).toBe(true);
    await expect(session.load()).rejects.toThrow();
    await expect(session.save(canvas + "different")).rejects.toThrow();
    await session.save(canvas);
    expect(api.saveDocument.mock.calls[1][2]).toEqual(api.saveDocument.mock.calls[0][2]);
    expect(session.pending).toBe(false);
  });
  it("does not retry a conflict with a newer revision behind the user's back", async () => {
    const { api, session } = setup(); await session.load();
    api.saveDocument.mockRejectedValueOnce(new NovartApiError("conflict", 409, "DOCUMENT_CONFLICT"));
    await expect(session.save(canvas)).rejects.toThrow("conflict");
    await expect(session.save(canvas)).rejects.toThrow();
    expect(api.saveDocument).toHaveBeenCalledTimes(1);
  });
  it("a failed restore disables saving instead of using the previous loaded revision", async () => {
    const { api, session } = setup(); await session.load();
    api.readDocument.mockRejectedValueOnce(new Error("restore failed"));
    await expect(session.load()).rejects.toThrow();
    await expect(session.save(canvas)).rejects.toThrow();
    expect(api.saveDocument).not.toHaveBeenCalled();
  });
  it("carries a successfully acknowledged revision into the next save", async () => {
    const { api, session } = setup(); await session.load(); await session.save(canvas); await session.save(canvas + "BBBB");
    expect(api.saveDocument.mock.calls[1][2].revision).toBe(1);
    expect(api.saveDocument.mock.calls[1][2].mutationId).not.toBe(api.saveDocument.mock.calls[0][2].mutationId);
  });
  it("uses same-origin cookie authentication without a preview token", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(empty), { status: 200 }));
    const api = createNovartApiClient(fetcher); await api.readDocument("w", "p");
    expect(fetcher.mock.calls[0][0]).toBe("/api/workspaces/w/projects/p/editor-document");
    expect(fetcher.mock.calls[0][1].credentials).toBe("same-origin");
    expect(fetcher.mock.calls[0][1].headers).toBeUndefined();
  });
  it("surfaces an expired login instead of treating HTML as an empty document", async () => {
    const api = createNovartApiClient(vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })));
    await expect(api.readDocument("w", "p")).rejects.toMatchObject({ status: 401 });
  });
});
