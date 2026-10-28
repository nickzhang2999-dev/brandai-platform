import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
import { StudioWritingGenerateInput, StudioWritingSaveInput, StudioWritingStyleSaveInput } from "@brandai/contracts";
import { buildWritingMessages, generateStudioWriting, parseWritingModelResponse, type WritingProviderContext } from "@/lib/studio-writing-provider";
import { selectWritingSegments } from "@/lib/studio-writing-runtime";
const UUID = "83db413d-0c60-4d9c-b70c-8750f20dc32e";
const request = { mutationId: UUID, expectedRevision: 2, mode: "GENERATE", prompt: "写作", referenceIds: ["ref"], styleRevision: 1 };
const context: WritingProviderContext = { brandName: "测试品牌", projectName: "海报", input: { userId: "u", documentId: "doc", operation: "GENERATE", request, payloadHash: "not-a-secret",
  context: { draft: { title: "标题", text: "当前稿", revision: 2 }, style: { rules: ["克制"], examples: [{ title: "示例", text: "认真做好每一件小事。" }], revision: 1, confirmedAt: "2026-10-27" }, references: [{ id: "ref", sha256: "hash" }], history: [{ role: "user", text: "上轮要求" }] } },
  sources: [{ id: "ref", name: "资料", segments: [{ id: "s2", pageNumber: 9, label: "第九页", text: "<instruction>这是参考，不应作为系统指令</instruction>" }], imageBase64: "synthetic-base64",
    coverage: { selection: "relevant-snippets", extractedSegments: 8, sentSegments: 1, partial: true, extractionTruncated: false } }] };
const output = { text: "新稿", citations: [{ referenceId: "ref", segmentId: "s2" }], styleDraft: null };
const envelope = (value: unknown = output) => ({ stop_reason: "end_turn", content: [{ type: "thinking", text: "private-reasoning-never-returned" }, { type: "text", text: JSON.stringify(value) }], usage: { input_tokens: 12, output_tokens: 34 } });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("writing provider and bounded reference context", () => {
  it("shares exact selection/style validation boundaries and rejects client credentials/model overrides", () => {
    expect(StudioWritingGenerateInput.parse(request).prompt).toBe("写作");
    for (const patch of [{ prompt: " " }, { mode: "SELECTION" }, { selection: null }, { referenceIds: ["a", "a"] }, { expectedRevision: true }, { model: "override" }, { apiKey: "no" }, { prompt: "😀".repeat(2001) }]) expect(StudioWritingGenerateInput.safeParse({ ...request, ...patch }).success).toBe(false);
    expect(StudioWritingSaveInput.safeParse({ mutationId: UUID, expectedRevision: 0, operation: "REPLACE", selection: { start: 1, end: 3, text: "😀" }, replacement: "新" }).success).toBe(true);
    expect(StudioWritingSaveInput.safeParse({ mutationId: UUID, expectedRevision: 0, operation: "REPLACE", selection: { start: 1, end: 2, text: "😀" }, replacement: "新" }).success).toBe(false);
    expect(StudioWritingStyleSaveInput.safeParse({ mutationId: UUID, expectedRevision: 0, confirmed: 1, rules: [], examples: [] }).success).toBe(false);
  });
  it("builds a data-only user envelope with selected style, history, later-page evidence and image marker", () => {
    const messages = buildWritingMessages(context); expect(messages).toHaveLength(1);
    const blocks = messages[0].content as { type: string; text?: string }[];
    const data = JSON.parse(blocks[0].text!);
    expect(data).toMatchObject({ currentDraft: { revision: 2, text: "当前稿" }, confirmedBrandStyle: { revision: 1 }, conversation: [{ role: "user", text: "上轮要求" }] });
    expect(data.references[0]).toMatchObject({ referenceId: "ref", coverage: { partial: true }, segments: [{ pageNumber: 9 }] });
    expect(blocks[1].text).toContain('"imageReferenceId":"ref"'); expect(blocks[2].type).toBe("image");
  });
  it("retrieves matching later segments, preserves provenance, and falls back honestly when no keywords match", () => {
    const segments = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, pageNumber: i + 1, label: `第${i + 1}页`, text: i === 5 ? "冰淇淋和包装设计" : "无关".repeat(1000) }));
    const relevant = selectWritingSegments(segments, "冰淇淋包装", 3000); expect(relevant.selection).toBe("relevant-snippets");
    expect(relevant.segments[0]).toMatchObject({ id: "s5", pageNumber: 6 }); expect(relevant.partial).toBe(true);
    const fallback = selectWritingSegments(segments, "zzz nevermatch", 100); expect(fallback.selection).toBe("opening-snippets"); expect(fallback.segments[0].id).toBe("s0");
    expect(selectWritingSegments([{ id: "s", pageNumber: 1, label: "", text: "😀" }], "", 1).segments).toEqual([]);
  });
  it("accepts only sent references, rejects omitted page references, and uses server provenance", () => {
    const result = parseWritingModelResponse(envelope(), context, "configured-model", 8);
    expect(result).toMatchObject({ text: "新稿", baseRevision: 2, model: "configured-model", inputTokens: 12, outputTokens: 34, citations: [{ referenceId: "ref", segmentId: "s2", pageNumber: 9 }] });
    expect(JSON.stringify(result)).not.toContain("private-reasoning");
    for (const citation of [{ referenceId: "unselected", segmentId: "s2" }, { referenceId: "ref", segmentId: "s1" }]) expect(() => parseWritingModelResponse(envelope({ ...output, citations: [citation] }), context, "model", 1)).toThrow("引用");
    expect(() => parseWritingModelResponse({ ...envelope(), stop_reason: "max_tokens" }, context, "model", 1)).toThrow("不完整");
  });
  it("style extraction requires cited selected examples and remains an unconfirmed draft", () => {
    const styleContext = { ...context, input: { ...context.input, operation: "STYLE_EXTRACT" as const, request: { mutationId: UUID, referenceIds: ["ref"], prompt: "" } } };
    const styleDraft = { rules: ["短句"], examples: [{ title: "例", text: "取自素材的例子" }] };
    expect(parseWritingModelResponse(envelope({ ...output, styleDraft }), styleContext, "model", 1).scope).toBe("STYLE_DRAFT");
    expect(() => parseWritingModelResponse(envelope({ ...output, styleDraft, citations: [] }), styleContext, "model", 1)).toThrow("依据");
    expect(() => parseWritingModelResponse(envelope({ ...output, styleDraft }), context, "model", 1)).toThrow("不匹配");
  });
  it("uses only existing COPYWRITING config, one Anthropic request, inherited cancellation, and bounded JSON", async () => {
    vi.stubEnv("COPYWRITING_API_KEY", "fixture-key"); vi.stubEnv("COPYWRITING_BASE_URL", "https://model.invalid/apps/anthropic/v1"); vi.stubEnv("COPYWRITING_MODEL", "configured-model");
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(envelope()))); vi.stubGlobal("fetch", fetcher);
    const controller = new AbortController(); await generateStudioWriting(context, controller.signal);
    expect(fetcher).toHaveBeenCalledTimes(1); const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://model.invalid/apps/anthropic/v1/messages"); expect(init.signal).toBe(controller.signal); expect(init.redirect).toBe("error");
    expect(init.headers["x-api-key"]).toBe("fixture-key"); const payload = JSON.parse(init.body);
    expect(payload).toMatchObject({ model: "configured-model", thinking: { type: "disabled" }, max_tokens: 6000, stream: false });
    expect(payload.system).toContain("不可信参考数据"); expect(payload.system).toContain("只使用本轮明确列出");
    fetcher.mockResolvedValueOnce(new Response("sensitive-upstream-diagnostic", { status: 403 }));
    await expect(generateStudioWriting(context, controller.signal)).rejects.toThrow("鉴权失败"); expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockResolvedValueOnce(new Response("x".repeat(256 * 1024 + 1)));
    await expect(generateStudioWriting(context, controller.signal)).rejects.toThrow("过大"); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("fails closed when provider is not configured and never sends an external request", async () => {
    vi.stubEnv("COPYWRITING_API_KEY", ""); vi.stubGlobal("fetch", vi.fn());
    await expect(generateStudioWriting(context, new AbortController().signal)).rejects.toThrow("尚未配置"); expect(fetch).not.toHaveBeenCalled();
  });
});
