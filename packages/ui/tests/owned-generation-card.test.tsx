import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OwnedGenerationCard } from "../../../apps/web/src/components/owned-canvas/OwnedGenerationCard";
import { createOwnedEditorApi, type GenerationTask, type GenerationCompliance } from "../../../apps/web/src/components/owned-canvas/owned-editor-api";

// Actual React card and product API adapter; only HTTP receipts are synthetic.
// These tests do not exercise any real provider, storage, account or database.
const image = { versionId: "fixture-version", assetId: "fixture-asset", assetSha256: "a".repeat(64), width: 16, height: 16, mimeType: "image/png" as const, url: "/api/workspaces/fixture-workspace/assets/fixture-asset/raw" };
const task = (override: Partial<GenerationTask> = {}): GenerationTask => ({ mode: "generate", requestId: "fixture-request", mutationId: "94f32517-d416-46ea-b8a0-401fe8d4ed65", projectId: "fixture-project", generationId: "fixture-generation", status: "SUCCEEDED", progress: null,
  expiresAt: "2099-01-01T00:00:00.000Z", archiveExpiresAt: "2099-01-02T00:00:00.000Z", archiveProcessingExpiresAt: null, displayText: "合成结果卡片交互", resultState: "READY", results: [image], error: null, archiveError: null, canRetryArchive: false, ...override });
const check = (override: Partial<GenerationCompliance> = {}): GenerationCompliance => ({ taskId: "fixture-check", versionId: image.versionId, status: "SUCCEEDED", progress: 100, expiresAt: "2099-01-01T00:00:00.000Z", checkedImageSha256: image.assetSha256,
  report: { overall: "PASS", textResults: [{ level: "PASS", reason: "合成文字检查理由" }], visualResults: [{ level: "PASS", reason: "合成视觉检查理由", replacement: "合成建议" }], checkedAt: "2026-10-10T00:00:00.000Z" }, error: null, canRetry: false, ...override });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const settle = async () => { await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); }); };
function fixture(initial: GenerationTask = task(), canEdit = true, respond: (url: URL, init: RequestInit) => Response | Promise<Response> = () => response(check())) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => respond(new URL(String(input), "https://novart.test"), init));
  const api = createOwnedEditorApi("fixture-workspace", "fixture-project", "fixture-user", { origin: "https://novart.test", fetcher });
  const submit = vi.spyOn(api, "submitGeneration"), archive = vi.spyOn(api, "retryArchive"), inspect = vi.spyOn(api, "readCompliance");
  const onTask = vi.fn(), onNotice = vi.fn(), onInsert = vi.fn(async () => undefined);
  const props = { task: initial, canEdit, api, onTask, onNotice, onInsert };
  const rendered = render(<OwnedGenerationCard {...props} />);
  return { ...rendered, fetcher, api, submit, archive, inspect, onTask, onNotice, onInsert, props };
}
// This package's test compiler uses classic JSX while the app uses automatic
// JSX. Supply the runtime binding only; the actual component is not mocked.
beforeEach(() => {
  vi.stubGlobal("React", React);
  // jsdom 25 does not implement AbortSignal.any; emulate signal composition
  // for the real API wrapper without changing or bypassing its HTTP checks.
  if (typeof AbortSignal.any !== "function") {
    const NativeSignal = AbortSignal, NativeController = AbortController;
    vi.stubGlobal("AbortSignal", class extends NativeSignal {
      static any(signals: AbortSignal[]) { const controller = new NativeController(); for (const signal of signals) { if (signal.aborted) controller.abort(signal.reason); else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true }); } return controller.signal; }
    });
  }
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("owned generation card explicit actions", () => {
  it("does not automatically generate, inspect, archive or insert on mount/rerender", async () => {
    const f = fixture(task({ canRetryArchive: true })); await settle(); f.rerender(<OwnedGenerationCard {...f.props} task={{ ...f.props.task }} />); await settle();
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled(); expect(f.archive).not.toHaveBeenCalled(); expect(f.inspect).not.toHaveBeenCalled(); expect(f.onInsert).not.toHaveBeenCalled();
  });
  it("archive retry is available only with the explicit capability and calls archive without resubmitting generation", async () => {
    const updated = task({ resultState: "PENDING", results: [], canRetryArchive: false });
    const f = fixture(task({ resultState: "FAILED", results: [], archiveError: "合成归档失败", canRetryArchive: true }), true, () => response(updated));
    fireEvent.click(screen.getByRole("button", { name: "重试保存结果" })); await settle();
    expect(f.archive).toHaveBeenCalledWith("fixture-request"); expect(f.submit).not.toHaveBeenCalled(); expect(f.inspect).not.toHaveBeenCalled();
    expect(f.fetcher).toHaveBeenCalledTimes(1); const [url, init] = f.fetcher.mock.calls[0]!;
    expect(String(url)).toContain("/studio/generation/retry-archive?"); expect(init?.method).toBe("POST"); expect(JSON.parse(String(init?.body))).toEqual({ projectId: "fixture-project", requestId: "fixture-request" });
    expect(f.onTask).toHaveBeenCalledWith(updated); expect(f.onNotice).toHaveBeenCalledWith(expect.stringContaining("不会再次生成"));
    f.rerender(<OwnedGenerationCard {...f.props} task={updated} />); expect(screen.queryByRole("button", { name: "重试保存结果" })).toBeNull();
  });
  it("does not accept another mutation's archive receipt as the original task", async () => {
    const f = fixture(task({ resultState: "FAILED", results: [], canRetryArchive: true }), true, () => response(task({ mutationId: "8178f807-9234-4f0b-a7ab-11918576872b" })));
    fireEvent.click(screen.getByRole("button", { name: "重试保存结果" })); await settle(); expect(f.onTask).not.toHaveBeenCalled(); expect(f.onNotice).toHaveBeenCalledWith(expect.stringContaining("不一致")); expect(f.submit).not.toHaveBeenCalled();
  });
  it("reads a matching version and image digest only after clicking and renders actual report reasons", async () => {
    const f = fixture(); fireEvent.click(screen.getByRole("button", { name: "读取品牌检查" })); await settle();
    expect(f.inspect).toHaveBeenCalledWith(image.versionId, false); expect(f.fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = f.fetcher.mock.calls[0]!; expect(new URL(String(url), "https://novart.test").searchParams.get("versionId")).toBe(image.versionId); expect(init?.method).not.toBe("POST");
    expect(screen.getByTestId("owned-compliance-status").textContent).toBe("品牌检查：通过"); expect(screen.getByText("合成文字检查理由")).toBeTruthy(); expect(screen.getByText("合成视觉检查理由 · 建议：合成建议")).toBeTruthy();
    expect(f.submit).not.toHaveBeenCalled(); expect(f.archive).not.toHaveBeenCalled(); expect(f.onInsert).not.toHaveBeenCalled();
  });
  it("renders RISK from the actual contract as a review recommendation", async () => {
    fixture(task(), true, () => response(check({ report: { overall: "RISK", textResults: [], visualResults: [{ level: "RISK", reason: "颜色建议复核" }], checkedAt: "2026-10-10T00:00:00.000Z" } })));
    fireEvent.click(screen.getByRole("button", { name: "读取品牌检查" })); await settle(); expect(screen.getByTestId("owned-compliance-status").textContent).toBe("品牌检查：建议复核");
  });
  it("does not display PASS from a valid-looking receipt for a different SHA", async () => {
    const f = fixture(task(), true, () => response(check({ checkedImageSha256: "b".repeat(64) })));
    fireEvent.click(screen.getByRole("button", { name: "读取品牌检查" })); await settle(); expect(f.onNotice).toHaveBeenCalledWith(expect.stringContaining("不一致")); expect(screen.queryByText("品牌检查：通过")).toBeNull(); expect(screen.getByTestId("owned-compliance-status").textContent).toBe("尚未读取品牌检查");
  });
  it("rejects a foreign version through the real API adapter before showing a report", async () => {
    const f = fixture(task(), true, () => response(check({ versionId: "another-version" })));
    fireEvent.click(screen.getByRole("button", { name: "读取品牌检查" })); await settle(); expect(f.onNotice).toHaveBeenCalledWith(expect.stringContaining("不一致")); expect(screen.queryByText("品牌检查：通过")).toBeNull();
  });
  it("does not keep displaying an old PASS when the current result digest changes", async () => {
    const f = fixture(); fireEvent.click(screen.getByRole("button", { name: "读取品牌检查" })); await settle(); expect(screen.getByText("品牌检查：通过")).toBeTruthy();
    f.rerender(<OwnedGenerationCard {...f.props} task={task({ results: [{ ...image, assetSha256: "b".repeat(64) }] })} />); await settle(); expect(screen.queryByText("品牌检查：通过")).toBeNull(); expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects a late check for an image that changed while the read was in flight", async () => {
    let finish!: (response: Response) => void; const f = fixture(task(), true, () => new Promise(resolve => { finish = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "读取品牌检查" })); f.rerender(<OwnedGenerationCard {...f.props} task={task({ results: [{ ...image, assetSha256: "b".repeat(64) }] })} />);
    await act(async () => finish(response(check()))); await settle(); expect(screen.queryByText("品牌检查：通过")).toBeNull(); expect(f.onNotice).toHaveBeenCalledWith(expect.stringContaining("不一致")); expect(f.submit).not.toHaveBeenCalled();
  });
  it("shows missing-VLM request errors without claiming successful checking", async () => {
    const f = fixture(task(), true, () => response({ error: "真实 VLM 服务尚未配置" }, 503));
    fireEvent.click(screen.getByRole("button", { name: "读取品牌检查" })); await settle(); expect(f.onNotice).toHaveBeenCalledWith("真实 VLM 服务尚未配置"); expect(screen.queryByText("品牌检查：通过")).toBeNull(); expect(f.submit).not.toHaveBeenCalled();
  });
  it("displays a FAILED check's own reason and retries only after a second explicit click", async () => {
    let calls = 0; const f = fixture(task(), true, () => response(++calls === 1 ? check({ status: "FAILED", report: null, checkedImageSha256: null, error: "VLM 检查超时，图片仍保留", canRetry: true, progress: 0 }) : check({ status: "PENDING", report: null, checkedImageSha256: null, error: null, canRetry: false, progress: 0 })));
    fireEvent.click(screen.getByRole("button", { name: "读取品牌检查" })); await settle(); expect(screen.getByTestId("owned-compliance-status").textContent).toBe("VLM 检查超时，图片仍保留"); expect(f.fetcher).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "重试品牌检查" })); await settle(); expect(f.inspect).toHaveBeenLastCalledWith(image.versionId, true); expect(f.fetcher).toHaveBeenCalledTimes(2); expect(f.fetcher.mock.calls[1]?.[1]?.method).toBe("POST"); expect(f.submit).not.toHaveBeenCalled(); expect(f.archive).not.toHaveBeenCalled();
    expect(screen.getByTestId("owned-compliance-status").textContent).toContain("处理中");
  });
  it("read-only users can read receipts but cannot insert, retry archive or start a new check", async () => {
    const f = fixture(task({ canRetryArchive: true }), false, () => response(check({ taskId: null, expiresAt: null, status: "NOT_REQUESTED", progress: 0, report: null, checkedImageSha256: null, canRetry: true })));
    expect((screen.getByRole("button", { name: "加入画布" }) as HTMLButtonElement).disabled).toBe(true); expect((screen.getByRole("button", { name: "重试保存结果" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "读取品牌检查" })); await settle(); expect(screen.getByTestId("owned-compliance-status").textContent).toBe("图片尚未检查"); expect((screen.getByRole("button", { name: "开始品牌检查" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "加入画布" })); fireEvent.click(screen.getByRole("button", { name: "重试保存结果" })); fireEvent.click(screen.getByRole("button", { name: "开始品牌检查" })); await settle(); expect(f.fetcher).toHaveBeenCalledTimes(1); expect(f.onInsert).not.toHaveBeenCalled(); expect(f.archive).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
  });
  it("does not emit late errors or archive task changes after unmount", async () => {
    let finish!: (response: Response) => void; const f = fixture(task({ resultState: "FAILED", results: [], canRetryArchive: true }), true, () => new Promise(resolve => { finish = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "重试保存结果" })); f.unmount(); await act(async () => finish(response(task()))); await settle(); expect(f.onTask).not.toHaveBeenCalled(); expect(f.onNotice).not.toHaveBeenCalled();
    let reject!: (error: Error) => void; const g = fixture(task(), true, () => new Promise((_resolve, fail) => { reject = fail; })); fireEvent.click(screen.getByRole("button", { name: "读取品牌检查" })); g.unmount(); await act(async () => reject(new Error("synthetic late failure"))); await settle(); expect(g.onNotice).not.toHaveBeenCalled();
  });
});
