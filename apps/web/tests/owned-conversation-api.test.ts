import { afterEach, describe, expect, it, vi } from "vitest";
import { createOwnedConversationApi } from "../src/components/owned-canvas/owned-conversation-api";

const draft = { revision: 2, text: "最后一段中文", references: [], quickEditTargetId: null, sizeSelection: { ratioKey: "1:1" as const, resolutionTier: "1K" as const } };
afterEach(() => vi.unstubAllGlobals());
describe("conversation close-time draft transport", () => {
  it("keeps a revision-checked draft PUT alive across component cancellation", async () => {
    const controller = new AbortController(); let init: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url, options) => { init = options; controller.abort(); return Response.json({ ...draft, revision: 3 }); }));
    const result = await createOwnedConversationApi("workspace", "project", "user", controller.signal).saveDraft(draft, true);
    expect(result.revision).toBe(3); expect(init?.method).toBe("PUT"); expect(init?.keepalive).toBe(true);
    expect(init?.signal?.aborted).toBe(false); expect(JSON.parse(init!.body as string)).toEqual(draft);
  });
  it("normal requests still honor project cancellation and never become keepalive POSTs", async () => {
    const controller = new AbortController(); let init: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url, options) => { init = options; controller.abort(); return Response.json({ ...draft, revision: 3 }); }));
    await createOwnedConversationApi("workspace", "project", "user", controller.signal).saveDraft(draft);
    expect(init?.keepalive).toBe(false); expect(init?.signal?.aborted).toBe(true);
  });
  it("retains conflict failure instead of overwriting a newer server draft", async () => {
    const fetch = vi.fn(async () => Response.json({ error: "草稿版本冲突" }, { status: 409 })); vi.stubGlobal("fetch", fetch);
    await expect(createOwnedConversationApi("workspace", "project", "user").saveDraft(draft, true)).rejects.toMatchObject({ status: 409, uncertain: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
