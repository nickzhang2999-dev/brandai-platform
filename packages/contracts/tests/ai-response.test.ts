import { afterEach, describe, expect, it, vi } from "vitest";
import { readBoundedAiJson, withinAiDeadline } from "../../../apps/web/src/lib/ai-response";

afterEach(() => vi.restoreAllMocks());
describe("product generation response boundary", () => {
  it("reads chunked JSON bytes without relying on Content-Length", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream({ start(c) { c.enqueue(encoder.encode('{"versions":')); c.enqueue(encoder.encode('[]}')); c.close(); } });
    expect(await readBoundedAiJson(new Response(body), new AbortController().signal, 64)).toEqual({ versions: [] });
  });
  it("rejects declared oversized output before consuming it", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { headers: { "Content-Length": "100" } });
    await expect(readBoundedAiJson(response, new AbortController().signal, 10)).rejects.toThrow("超过限制");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("bounds actual bytes and cancels lying or chunked bodies", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(11)); }, cancel }), { headers: { "Content-Length": "1" } });
    await expect(readBoundedAiJson(response, new AbortController().signal, 10)).rejects.toThrow("超过限制");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("aborts a stalled body read even when the source ignores the signal", async () => {
    const controller = new AbortController(), cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    const result = readBoundedAiJson(response, controller.signal, 10);
    controller.abort(new Error("deadline"));
    await expect(result).rejects.toThrow("deadline");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("does not wait on a broken upstream cancellation", async () => {
    const controller = new AbortController();
    const response = new Response(new ReadableStream({ cancel: () => new Promise<void>(() => {}) }));
    const result = readBoundedAiJson(response, controller.signal, 10);
    controller.abort(new Error("deadline"));
    await expect(result).rejects.toThrow("deadline");
  });
  it("rejects oversized headers without waiting for broken cancellation", async () => {
    const response = new Response(new ReadableStream({ cancel: () => new Promise<void>(() => {}) }), { headers: { "Content-Length": "100" } });
    await expect(readBoundedAiJson(response, new AbortController().signal, 10)).rejects.toThrow("超过限制");
  });
  it("rejects an invalid limit without waiting for broken cancellation", async () => {
    const response = new Response(new ReadableStream({ cancel: () => new Promise<void>(() => {}) }));
    await expect(readBoundedAiJson(response, new AbortController().signal, NaN)).rejects.toThrow("Invalid AI response limit");
  });
  it("does not echo malformed response data", async () => {
    const response = new Response("fixture-private-value");
    await expect(readBoundedAiJson(response, new AbortController().signal, 100)).rejects.toThrow("格式无法识别");
  });
  it("stops awaiting preflight on the same deadline and consumes late rejection", async () => {
    const controller = new AbortController();
    let rejectSetup!: (reason: Error) => void;
    const setup = new Promise<void>((_resolve, reject) => { rejectSetup = reject; });
    const result = withinAiDeadline(setup, controller.signal);
    controller.abort(new Error("expired before dispatch"));
    await expect(result).rejects.toThrow("expired before dispatch");
    rejectSetup(new Error("late DB failure"));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  it("observes already-started work even if aborted before awaiting it", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already expired"));
    await expect(withinAiDeadline(Promise.reject(new Error("late DB failure")), controller.signal)).rejects.toThrow("already expired");
    await new Promise(resolve => setTimeout(resolve, 0));
  });
});
