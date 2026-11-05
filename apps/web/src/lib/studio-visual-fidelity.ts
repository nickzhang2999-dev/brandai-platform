import { createHash } from "node:crypto";
import { z } from "zod";
import { VisualFidelityPlan, VisualFidelitySha256, type BrandRule, type AIConstraints, type StudioImageToolSpec } from "@brandai/contracts";
import { StudioEditSourceSnapshot } from "./studio-generation-edit";

export const StudioFidelityReferenceImage = z.object({
  assetId: z.string().min(1).max(128), sha256: VisualFidelitySha256,
  source: z.string().min(1).max(4000), polarity: z.string().min(1).max(128),
  mode: z.string().min(1).max(128).optional(), note: z.string().max(4000).optional(),
}).strict();

/** Server-owned generation receipt; never hydrated from provider echo. */
export const StudioVisualFidelitySnapshot = z.object({
  revision: z.literal("visual-fidelity-guard/1"), inputSha256: VisualFidelitySha256,
  plan: VisualFidelityPlan.nullable(), unavailableReason: z.string().min(1).max(1000).nullable(),
  editSource: StudioEditSourceSnapshot.nullable(), imageTool: z.boolean(),
  referenceImages: z.array(StudioFidelityReferenceImage).max(8).default([]),
}).strict().superRefine((value, ctx) => {
  if (value.plan && (value.plan.inputSha256 !== value.inputSha256 || value.unavailableReason !== null))
    ctx.addIssue({ code: "custom", message: "Fidelity plan must match the receipt binding" });
  if (!value.plan && !value.unavailableReason)
    ctx.addIssue({ code: "custom", message: "Unavailable plans require a reason" });
});
export type StudioVisualFidelitySnapshot = z.infer<typeof StudioVisualFidelitySnapshot>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export type StudioVisualFidelityInput = {
  prompt: string; brandRules: BrandRule[]; editSource: StudioEditSourceSnapshot | null;
  referenceAudit: Array<Record<string, unknown>>; imageTool?: StudioImageToolSpec;
  effectiveConstraints?: AIConstraints;
};

/** No model planner, no truncation. Unsupported inventories remain reviewable unknowns. */
export function buildStudioVisualFidelitySnapshot(input: StudioVisualFidelityInput): StudioVisualFidelitySnapshot {
  const rules = input.imageTool ? [] : input.brandRules;
  const inputSha256 = createHash("sha256").update(JSON.stringify(canonical({
    revision: "visual-fidelity-guard/1", prompt: input.prompt, brandRules: rules,
    editSource: input.editSource, referenceAudit: input.imageTool ? [] : input.referenceAudit,
    imageTool: input.imageTool ?? null, effectiveConstraints: input.effectiveConstraints ?? null,
  }))).digest("hex");
  const references = z.array(StudioFidelityReferenceImage).max(8).safeParse(input.imageTool ? [] : input.referenceAudit);
  const constraints: Array<Record<string, unknown>> = [];
  if (input.prompt.trim()) constraints.push({ id: "user-request", target: "本次用户指令明确指定的对象、区域与整体构图",
    attribute: "user-request", expected: input.prompt, strength: "hard", source: "user" });
  // Full original text above remains the interpretation context. Independent
  // clauses make omitted colour/count/text requirements visible as missing IDs.
  const clauses = input.prompt.split(/[。！？!?；;，,、\n]+|(?<!\d)\.(?!\d)|\b(?:and|also|then|while)\b|并且|而且|以及|同时|且/iu).map(value => value.trim()).filter(Boolean);
  if (clauses.length > 1) clauses.forEach((clause, index) => constraints.push({
    id: `user-request-${String(index + 1).padStart(3, "0")}`,
    target: "按user-request完整上下文定位本子要求的对象/区域，不能孤立解释省略的主语",
    attribute: "user-request-clause", expected: clause, strength: "hard", source: "user",
  }));
  for (const rule of rules) constraints.push({ id: `brand-${rule.id}`, target: "本条品牌规则明确适用的对象或区域；不得无差别覆盖其他主体",
    attribute: rule.type, expected: `${rule.strength === "FORBIDDEN" ? "禁止出现/违反：" : "规则要求："}${rule.summary}\n结构化要求：${JSON.stringify(canonical(rule.value))}`,
    strength: rule.strength === "WEAK" ? "soft" : "hard", source: "brand" });
  if (input.editSource) {
    const attributes = [
      ["colour", "颜色", "区分光照、反射与材质本色，不能拿背景颜色证明主体本色。"],
      ["identity", "身份", "必须比较同一主体，不能用另一个相似对象替代。"],
      ["shape", "轮廓", "检查形状及关键结构；遮挡不可见部分不假定已保留。"],
      ["logo", "标志", "检查可见标志形状与位置；无法看清或无法定位时unknown。"],
      ["text", "文字", "检查可见标签文字；模糊文字无法确认时unknown。"],
      ["count", "数量", "检查对应主体数量，不能漏掉消失或重复对象。"],
      ["region", "允许修改区域", "检查是否越出用户授权修改范围；无可靠对齐/蒙版证据不能声称像素完全不变。"],
    ] as const;
    for (const [id, label, detail] of attributes) constraints.push({ id: `edit-preservation-${id}`,
      target: `修改源图中与结果对应的同一主体/区域的${label}`, attribute: id,
      expected: `核对${label}。保留本次用户指令或指定工具未允许改变的该属性；本次明确改色或修改要求优先于对应属性原样保留，不扩张到其他属性。${detail}不存在该属性时须说明实际原图观察依据；遮挡或无法定位时unknown。仅视觉比较，不声称蒙版或像素锁定已执行。`,
      strength: "hard", source: "source" });
  }
  if (!input.imageTool && input.referenceAudit.length) constraints.push({ id: "reference-context", target: "本次输入的全部参考素材及用户/品牌要求指定的对应对象与参考角色",
    attribute: "reference-context", expected: "根据user-request完整原文及品牌规则逐一核对每张参考图的实际角色；风格参考只比较明确要求的风格，不视为身份锁定。明确保留原产品颜色、身份或其他属性时必须定位对应参考图及同一对象逐项比较。不得仅因结果好看而判pass；任一参考缺失、角色不明或复合要求未逐一得到证据时unknown。", strength: "hard", source: "source" });
  if (input.imageTool) constraints.push({ id: "image-tool", target: "指定工具处理的源图及允许变化范围", attribute: "image-tool",
    expected: `执行${input.imageTool.operation}，只改变该工具与本次指令允许的范围；未授权主体属性保持原样。${input.imageTool.mask ? "局部修复仅允许指定蒙版区域；没有蒙版定位证据时区域保真未知，不能声称像素完全不变。" : "移除背景而保留主体外观及数量。"}`, strength: "hard", source: "user" });
  if (input.effectiveConstraints && !input.imageTool) {
    // Keep individual requirements bounded instead of duplicating the entire
    // rule inventory into a single 4000-character expected field. Machine
    // execution settings remain bound by inputSha256, not asserted by vision.
    const groups = [
      ["negative", input.effectiveConstraints.negativePrompt, "需要避免的视觉内容，不能添加到画面。"],
      ["prompt", input.effectiveConstraints.promptAdditions, "遵守原要求的强弱和参考角色；风格偏好不升级为硬要求。"],
      ["block", input.effectiveConstraints.hardBlocks.map(item => item.reason), "禁止条件，不能添加到画面。"],
    ] as const;
    for (const [kind, values, context] of groups) [...new Set(values)].forEach((value, index) => {
      if (!value.trim()) return;
      constraints.push({ id: `compiled-${kind}-${index + 1}`, target: "本项实际发送的约束所指定对象或区域",
        attribute: `compiled-${kind}`, expected: `${context}仅依据可见证据判断，无法核验时unknown。\n${value}`,
        strength: "hard", source: "user" });
    });
  }
  const parsed = VisualFidelityPlan.safeParse({ revision: "visual-fidelity-guard/1", inputSha256, constraints });
  return StudioVisualFidelitySnapshot.parse({ revision: "visual-fidelity-guard/1", inputSha256,
    plan: parsed.success && references.success ? parsed.data : null,
    unavailableReason: parsed.success && references.success ? null : "完整约束清单超过可核验契约限制或存在无效字段；未截断清单，本次主体保真待人工核验。",
    editSource: input.editSource, imageTool: Boolean(input.imageTool), referenceImages: references.success ? references.data : [] });
}

export const STUDIO_VISUAL_FIDELITY_PROMPT = "主体与品牌约束：只修改本次用户明确允许的对象、属性和区域；保留其余主体的颜色、身份、轮廓、标志、文字与数量。品牌色仅用于规则指定的对象或背景，不把主体一律染成品牌色。本次明确的改色要求更新对应原色保留要求；若与仍适用的品牌硬约束冲突，不自行扩大修改或静默忽略规则。风格参考仅借鉴风格，不能当作必须替换原主体的依据。此要求是生成指令，不表示已执行蒙版或像素锁定；隐藏内容不冒充原始事实。";
