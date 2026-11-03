import { describe, expect, it } from "vitest";
import { writingRequestPrompt, writingPromptMatches } from "../src/components/writing-workbench/writing-purpose";
import { StudioWritingGenerateInput } from "@brandai/contracts";
describe("writing purpose", () => {
  it("leaves general writing free-form and makes image requirements explicit", () => {
    expect(writingRequestPrompt(" 解释这个概念 ", "GENERAL")).toBe("解释这个概念");
    const prompt = writingRequestPrompt("只写黑白构图，保留字样", "IMAGE_PROMPT");
    expect(prompt).toContain("本轮具体要求优先");
    expect(prompt).toContain("不默认添加社交帖格式");
    expect(prompt.endsWith("本轮具体要求：\n只写黑白构图，保留字样")).toBe(true);
  });
  it("does not truncate long requests or consider newer typing acknowledged", () => {
    const prompt = writingRequestPrompt("原始要求", "IMAGE_PROMPT");
    expect(writingPromptMatches("原始要求", prompt)).toBe(true);
    expect(writingPromptMatches("新的要求", prompt)).toBe(false);
    const long = writingRequestPrompt("文".repeat(4000), "IMAGE_PROMPT");
    expect(long.endsWith("文".repeat(4000))).toBe(true);
    expect(StudioWritingGenerateInput.safeParse({ mutationId: "83db413d-0c60-4d9c-b70c-8750f20dc32e", expectedRevision: 0, mode: "GENERATE", prompt: long, referenceIds: [], styleRevision: null }).success).toBe(false);
  });
});
