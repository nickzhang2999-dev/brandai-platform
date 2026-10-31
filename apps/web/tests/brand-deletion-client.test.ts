import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearBrandDeletionRecovery, readBrandDeletion, readBrandDeletionRecovery, saveBrandDeletionRecovery, submitBrandDeletion } from "../src/lib/brand-deletion-client";

const input = { confirmationName: "合成品牌", confirmationToken: "a".repeat(64), mutationId: "87020486-7806-4f87-b626-e70dbb704af7" };
const preview = { workspaceId: "brand-a", name: input.confirmationName, counts: { projects: 2, assets: 4, rules: 1, terms: 0, prohibitions: 0, inspirationCases: 0, members: 1 }, activeTasks: 0, canDelete: true, blockedReason: null, confirmationToken: input.confirmationToken };
const receipt = { ok: true, deletedWorkspaceId: "brand-a", nextWorkspaceId: "brand-b", redirectTo: "/studio?workspaceId=brand-b#/home" };
const fetchMock = vi.fn();
beforeEach(() => { vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); });
afterEach(() => vi.unstubAllGlobals());

describe("brand deletion client boundaries", () => {
  it("validates impact ownership and readiness before offering a delete", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(preview));
    expect(await readBrandDeletion("brand-a")).toEqual(preview);
    fetchMock.mockResolvedValueOnce(Response.json({ ...preview, workspaceId: "other" }));
    await expect(readBrandDeletion("brand-a")).rejects.toThrow("尚未读取完整");
    fetchMock.mockResolvedValueOnce(Response.json({ ...preview, activeTasks: 1 }));
    await expect(readBrandDeletion("brand-a")).rejects.toThrow("尚未读取完整");
  });
  it("preserves the exact confirmation and operation identity across uncertain retries", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("connection lost"));
    await expect(submitBrandDeletion("brand-a", input)).rejects.toMatchObject({ uncertain: true });
    fetchMock.mockResolvedValueOnce(Response.json(receipt));
    expect(await submitBrandDeletion("brand-a", input)).toEqual(receipt);
    expect(fetchMock.mock.calls.map(call => JSON.parse(call[1].body))).toEqual([input, input]);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "DELETE", credentials: "same-origin", cache: "no-store" });
  });
  it("treats 5xx and malformed success receipts as unknown, never a safe fresh delete", async () => {
    for (const response of [Response.json({ error: "busy" }, { status: 503 }), new Response("bad json"), Response.json({ ok: true })]) {
      fetchMock.mockResolvedValueOnce(response);
      await expect(submitBrandDeletion("brand-a", input)).rejects.toMatchObject({ uncertain: true });
    }
  });
  it("requires new impact confirmation after definite rejection and never treats 404 as deletion success", async () => {
    for (const status of [403, 404, 409]) {
      fetchMock.mockResolvedValueOnce(Response.json({ error: "请重新核对" }, { status }));
      await expect(submitBrandDeletion("brand-a", input)).rejects.toMatchObject({ uncertain: false, status });
    }
  });
  it("rejects cross-brand or untrusted destinations and permits only the confirmed empty Studio", async () => {
    for (const result of [{ ...receipt, deletedWorkspaceId: "other" }, { ...receipt, redirectTo: "https://example.invalid" }, { ...receipt, nextWorkspaceId: "brand-a", redirectTo: "/studio?workspaceId=brand-a#/home" }]) {
      fetchMock.mockResolvedValueOnce(Response.json(result));
      await expect(submitBrandDeletion("brand-a", input)).rejects.toMatchObject({ uncertain: true });
    }
    fetchMock.mockResolvedValueOnce(Response.json({ ...receipt, nextWorkspaceId: null, redirectTo: "/studio" }));
    expect((await submitBrandDeletion("brand-a", input)).redirectTo).toBe("/studio");
  });
  it("keeps recovery isolated by actor and brand and clears only the confirmed operation", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("sessionStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
    saveBrandDeletionRecovery("actor-a", "brand-a", input);
    expect(readBrandDeletionRecovery("actor-a", "brand-a")).toEqual(input);
    expect(readBrandDeletionRecovery("actor-b", "brand-a")).toBeNull();
    expect(readBrandDeletionRecovery("actor-a", "brand-b")).toBeNull();
    clearBrandDeletionRecovery("actor-b", "brand-a");
    expect(readBrandDeletionRecovery("actor-a", "brand-a")).toEqual(input);
    clearBrandDeletionRecovery("actor-a", "brand-a");
    expect(readBrandDeletionRecovery("actor-a", "brand-a")).toBeNull();
  });
  it("blocks a new destructive submission if its recovery record cannot be saved", () => {
    vi.stubGlobal("sessionStorage", { setItem: () => { throw new Error("quota"); } });
    expect(() => saveBrandDeletionRecovery("actor-a", "brand-a", input)).toThrow("无法保存删除进度");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
