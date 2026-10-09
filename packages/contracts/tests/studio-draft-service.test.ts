import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkbenchDraftView } from "../src/workbench-shell";

// Isolated service regressions only; real HTTP/DB acceptance lives in
// apps/web/scripts/verify-studio-shell-backend.ts.
const f = vi.hoisted(() => ({ gate: vi.fn(), document: vi.fn(), lock: vi.fn(), read: vi.fn(), write: vi.fn(), transaction: vi.fn() }));
vi.mock("../../../apps/web/src/lib/workspace", () => ({ requireWorkspaceRole: f.gate }));
vi.mock("../../../apps/web/src/lib/editor-documents", () => ({ readEditorDocument: f.document }));
vi.mock("../../../apps/web/src/lib/api", () => ({ ApiException: class extends Error {
  constructor(public status: number, message: string) { super(message); }
} }));
vi.mock("../../db/src/index", () => ({
  prisma: { workbenchChatDraft: { findUnique: f.read }, $transaction: f.transaction },
  Prisma: { DbNull: "database-null" },
}));
import { saveStudioDraft, studioDraft, validateStudioDraft } from "../../../apps/web/src/lib/studio-state";

const savedAt = new Date("2026-10-08T00:00:00Z");
const inputForm = { text: "中文\n最后一次输入", paramList: [], mentionPreviewList: [],
  lexicalJSONState: { root: { children: [{ type: "paragraph", children: [{ type: "text", text: "中文" }] }] } },
  model: "preferred", ratio: "1:1" };
const payload = { projectId: "p", revision: 0, inputForm };

beforeEach(() => {
  vi.resetAllMocks();
  f.gate.mockResolvedValue({ role: "EDITOR" });
  f.document.mockResolvedValue({ projectId: "p" });
  f.lock.mockResolvedValue([{ id: "p", archivedAt: null }]);
  f.read.mockResolvedValue(null);
  f.transaction.mockImplementation(fn => fn({ $queryRaw: f.lock, workbenchChatDraft: { findUnique: f.read, upsert: f.write } }));
  f.write.mockImplementation(({ create }) => ({ ...create, inputForm: create.inputForm === "database-null" ? null : create.inputForm, updatedAt: savedAt }));
});

describe("studio draft receipts and reference validation", () => {
  it("returns an explicit clean-reference receipt before any draft exists", async () => {
    const view = await studioDraft("w", "owner", { projectId: "p" });
    expect(view).toEqual({ projectId: "p", revision: 0, inputForm: null, updatedAt: null, referenceIssues: [] });
    expect(WorkbenchDraftView.parse(view)).toEqual(view);
    expect(f.read).toHaveBeenCalledWith({ where: { userId_projectId: { userId: "owner", projectId: "p" } } });
  });

  it("checks project visibility before reading a user's private draft", async () => {
    f.document.mockRejectedValue(new Error("not found"));
    await expect(studioDraft("foreign", "owner", { projectId: "p" })).rejects.toThrow("not found");
    expect(f.document).toHaveBeenCalledWith("foreign", "p", "owner");
    expect(f.read).not.toHaveBeenCalled();
  });

  it("preserves the entire native form and returns the same checked receipt on save and read", async () => {
    const saved = await saveStudioDraft("w", "owner", payload);
    expect(saved).toEqual({ projectId: "p", revision: 1, inputForm, updatedAt: savedAt.getTime(), referenceIssues: [] });
    expect(f.gate).toHaveBeenCalledWith("w", "owner", "EDITOR");
    expect(f.write.mock.calls[0][0].create.inputForm).toEqual(inputForm);
    f.read.mockResolvedValue({ revision: 1, inputForm, updatedAt: savedAt });
    expect(await studioDraft("w", "owner", { projectId: "p" })).toEqual(saved);
  });

  it("returns explicit null after clearing, including the last writable revision", async () => {
    f.read.mockResolvedValue({ revision: 2147483646, inputForm, updatedAt: savedAt });
    const cleared = await saveStudioDraft("w", "owner", { ...payload, revision: 2147483646, inputForm: null });
    expect(cleared).toEqual({ projectId: "p", revision: 2147483647, inputForm: null, updatedAt: savedAt.getTime(), referenceIssues: [] });
  });

  it.each([{}, { prompt: "old prompt-only draft" }, { text: 7 }, [], { text: "", nested: { audioUrl: "https://media.invalid/audio" } }])(
    "does not mark unsupported stored data clean or mutate it: %j", async badForm => {
      f.read.mockResolvedValue({ revision: 3, inputForm: badForm, updatedAt: savedAt });
      await expect(studioDraft("w", "owner", { projectId: "p" })).rejects.toThrow();
      expect(f.transaction).not.toHaveBeenCalled(); expect(f.write).not.toHaveBeenCalled();
    },
  );

  it.each(["url", "src", "imageUrl", "originalUrl", "thumbnail", "videoUrl", "audioUrl", "fileUrl"])(
    "rejects nested %s references before writing, including persistent-looking URLs", async field => {
      for (const value of ["blob:temporary", "data:image/png;base64,abc", "/api/workspaces/w/assets/a/raw", "https://local-assets.invalid/" + "a".repeat(64), ["https://media.invalid/a"], 42, {}]) {
        const form = { text: "保留正文", lexicalJSONState: { root: { children: [{ data: { [field]: value } }] } } };
        await expect(saveStudioDraft("w", "owner", { ...payload, inputForm: form })).rejects.toMatchObject({ status: 422 });
      }
      expect(f.transaction).not.toHaveBeenCalled(); expect(f.write).not.toHaveBeenCalled();
    },
  );

  it("retains ordinary URL text and empty native media placeholders", () => {
    expect(() => validateStudioDraft({ text: "blob:example https://example.test data:image/png is text", url: "", data: { imageUrl: null, audioUrl: "" } })).not.toThrow();
  });

  it("bounds size, depth and non-finite numbers before serialization", async () => {
    let deep: Record<string, unknown> = { text: "deep" }; for (let i = 0; i < 10000; i++) deep = { next: deep };
    for (const [form, status] of [[{ text: "中".repeat(90000) }, 413], [{ text: "", deep }, 422], [{ text: "", value: Infinity }, 422]] as const) {
      await expect(saveStudioDraft("w", "owner", { ...payload, inputForm: form })).rejects.toMatchObject({ status });
    }
    expect(f.write).not.toHaveBeenCalled();
  });

  it("refuses stale, archived, foreign and read-only writes without discarding saved content", async () => {
    f.read.mockResolvedValue({ revision: 1, inputForm, updatedAt: savedAt });
    await expect(saveStudioDraft("w", "owner", payload)).rejects.toMatchObject({ status: 409 });
    f.lock.mockResolvedValue([{ id: "p", archivedAt: savedAt }]);
    await expect(saveStudioDraft("w", "owner", payload)).rejects.toMatchObject({ status: 409 });
    f.lock.mockResolvedValue([]);
    await expect(saveStudioDraft("w", "owner", payload)).rejects.toMatchObject({ status: 404 });
    f.gate.mockRejectedValue(new Error("forbidden"));
    await expect(saveStudioDraft("w", "viewer", payload)).rejects.toThrow("forbidden");
    expect(f.write).not.toHaveBeenCalled();
  });
});
