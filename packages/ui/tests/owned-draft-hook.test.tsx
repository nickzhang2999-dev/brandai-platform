import React, { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOwnedDraft } from "../../../apps/web/src/components/owned-canvas/use-owned-draft";
import { emptyOwnedDraft, type OwnedDraftValue } from "../../../apps/web/src/components/owned-canvas/owned-draft-api";

// Actual React hook lifecycle/IME tests; network responses are synthetic.
const receipt = (projectId: string, text: string, revision = 0) => ({ projectId, revision, inputForm: text ? { text } : null, updatedAt: revision ? 1 : null, referenceIssues: [] });
const reply = (value: unknown, status = 200) => ({ ok: status < 400, status, json: async () => value });
function Composer({ projectId = "p", frozen = false }: { projectId?: string; frozen?: boolean }) {
  const [value, setValue] = useState<OwnedDraftValue>(emptyOwnedDraft);
  const draft = useOwnedDraft({ projectId, workspaceId: "w", userId: "u", value, onRestore: setValue, frozen });
  return <div><textarea aria-label="test draft" disabled={!draft.ready || draft.blocked || frozen} value={value.prompt} onChange={event => setValue({ ...value, prompt: event.target.value })} onCompositionStart={draft.compositionStart} onCompositionEnd={draft.compositionEnd} /><span data-testid="draft-state">{draft.state}</span><button onClick={() => void draft.retry().catch(() => undefined)}>retry</button></div>;
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const settle = async () => { await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); }); };

describe("owned draft hook lifecycle", () => {
  it("waits for server restore and never autosaves initial empty React fields", async () => {
    vi.useFakeTimers(); let finish!: (value: unknown) => void;
    const fetcher = vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; })); vi.stubGlobal("fetch", fetcher);
    render(<Composer />); expect((screen.getByLabelText("test draft") as HTMLTextAreaElement).disabled).toBe(true);
    await act(async () => finish(reply(receipt("p", "已保存需求", 4)))); await settle();
    expect((screen.getByLabelText("test draft") as HTMLTextAreaElement).value).toBe("已保存需求");
    await act(async () => vi.advanceTimersByTimeAsync(1000)); expect(fetcher).toHaveBeenCalledTimes(1); expect(screen.getByTestId("draft-state").textContent).toBe("saved");
  });
  it("does not save partial IME text, then saves the committed Chinese input", async () => {
    vi.useFakeTimers(); const writes: Array<{ inputForm: { text: string } }> = [];
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => { if (init.method === "POST") { const input = JSON.parse(String(init.body)); writes.push(input); return reply({ ...receipt("p", input.inputForm.text, input.revision + 1), inputForm: input.inputForm }); } return reply(receipt("p", "")); }); vi.stubGlobal("fetch", fetcher);
    render(<Composer />); await settle(); const input = screen.getByLabelText("test draft");
    fireEvent.compositionStart(input); fireEvent.change(input, { target: { value: "zhong" } }); await act(async () => vi.advanceTimersByTimeAsync(800)); expect(writes).toHaveLength(0);
    fireEvent.change(input, { target: { value: "中文完成" } }); fireEvent.compositionEnd(input); await act(async () => vi.advanceTimersByTimeAsync(800)); await settle();
    expect(writes).toHaveLength(1); expect(writes[0]?.inputForm.text).toBe("中文完成"); expect(screen.getByTestId("draft-state").textContent).toBe("saved");
  });
  it("flushes settled edits on unmount with keepalive and no false clean-page write", async () => {
    vi.useFakeTimers(); const fetcher = vi.fn(async (_url: string, init: RequestInit) => { if (init.method === "POST") { const input = JSON.parse(String(init.body)); return reply({ ...receipt("p", input.inputForm.text, input.revision + 1), inputForm: input.inputForm }); } return reply(receipt("p", "")); }); vi.stubGlobal("fetch", fetcher);
    const mounted = render(<Composer />); await settle(); fireEvent.change(screen.getByLabelText("test draft"), { target: { value: "关闭前保留" } }); mounted.unmount(); await settle();
    const writes = fetcher.mock.calls.filter(call => call[1].method === "POST"); expect(writes).toHaveLength(1); expect(writes[0]![1].keepalive).toBe(true);
    expect(JSON.parse(String(writes[0]![1].body)).inputForm.text).toBe("关闭前保留");
  });
  it("ignores a delayed old-project read after moving to another project", async () => {
    let finish!: (value: unknown) => void;
    const fetcher = vi.fn(async (url: string) => url.includes("projectId=p1") ? new Promise(resolve => { finish = resolve; }) : reply(receipt("p2", "第二个项目", 3))); vi.stubGlobal("fetch", fetcher);
    const mounted = render(<Composer projectId="p1" />); mounted.rerender(<Composer projectId="p2" />); await settle();
    await act(async () => finish(reply(receipt("p1", "迟到的旧稿", 1)))); await settle();
    expect((screen.getByLabelText("test draft") as HTMLTextAreaElement).value).toBe("第二个项目"); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("failed restoration and pagehide never post an empty replacement", async () => {
    const fetcher = vi.fn().mockResolvedValue(reply({ error: "synthetic restore failure" }, 503)); vi.stubGlobal("fetch", fetcher);
    render(<Composer />); await settle(); expect(screen.getByTestId("draft-state").textContent).toBe("error");
    fireEvent(window, new Event("pagehide")); await settle(); expect(fetcher.mock.calls.every(call => call[1].method === "GET")).toBe(true);
  });
});
