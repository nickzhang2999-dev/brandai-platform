import type { StudioConversationInput } from "@brandai/contracts";

// Match only a complete known application notice. A design request that quotes
// the notice as poster copy is still a real request, and must not be blocked.
const normalize = (text: string) => text.replace(/[\s,，.。]/g, "");
const editSourceNotices = new Set([
  "修改目标已失效、归属不符或原始配方发生变化，请重新选择图片。",
  "这张历史生成图片缺少可验证的原始合成记录，暂不能继续改图。请选用新工作台生成的图片。",
  "修改目标在准备期间无法通过来源校验，未调用生成服务。请重新选择图片后提交。",
].map(normalize));

export function studioConversationFeedback(input: Pick<StudioConversationInput, "text">): string | null {
  return editSourceNotices.has(normalize(input.text))
    ? "这段文字是系统报错，还不是修改需求。请重新选择要修改的图片，并写明想改哪里；不会据此发起新的模型调用。"
    : null;
}
