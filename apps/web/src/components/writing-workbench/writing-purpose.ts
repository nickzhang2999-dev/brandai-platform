export type WritingPurpose = "GENERAL" | "IMAGE_PROMPT";
const IMAGE_PROMPT_PREFIX = "写作用途：生图提示词。默认只输出可直接用于生图的描述，覆盖主体、场景、构图、光线、色彩和材质；不默认添加社交帖格式、话题标签或推广话术。下面的本轮具体要求优先；缺失的品牌事实不要编造。\n\n本轮具体要求：\n";
export function writingRequestPrompt(prompt: string, purpose: WritingPurpose): string {
  return purpose === "IMAGE_PROMPT" ? IMAGE_PROMPT_PREFIX + prompt.trim() : prompt.trim();
}
export function writingPromptMatches(prompt: string, submitted: string): boolean {
  return prompt.trim() === submitted || IMAGE_PROMPT_PREFIX + prompt.trim() === submitted;
}
