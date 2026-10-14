import { StudioConversationIntent, StudioConversationPixels, type StudioConversationInput, type StudioConversationReference, resolveGenerationSize } from "@brandai/contracts";

/** Deliberately conservative. Unseen or ambiguous language asks a question;
 * this parser never infers a chargeable edit solely from having attachments. */
export function parseStudioConversationIntent(input: StudioConversationInput, previous?: StudioConversationReference, decision?: { action: "generate" | "modify"; targetReferenceId: string | null }): StudioConversationIntent {
  const text = input.text.trim();
  const refs = [...input.references];
  const forcedId = input.quickEditTargetId ?? (decision?.action === "modify" ? decision.targetReferenceId : null);
  const forced = forcedId ? refs.find(ref => ref.referenceId === forcedId) : undefined;
  const clarify = (message: string) => StudioConversationIntent.parse({ action: "clarify", targetReferenceId: null, referenceIds: refs.map(ref => ref.referenceId), prompt: text,
    clarification: message, requestedSize: null, sizeSource: "default", sizeSelection: input.sizeSelection, parser: "safe-rules-v1" });
  const explicitNew = decision?.action === "generate" || /(?:重新(?:生成|设计|制作)|新建|新做|全新|另做|另外|再生成|生成一张|设计一张|制作一张|合成|融合|组合|结合|new\s+(?:image|design)|combine|compose)/i.test(text);
  const edit = /(?:修改|改成|改为|改一下|改图|调整|换成|变成|去掉|删除|移除|背景.*(?:改|换)|(?:改|换).*背景|edit|change|remove)/i.test(text);
  const continuing = /(?:继续|上一张|刚才那张|上张|last\s+(?:image|result))/i.test(text);
  let target = forced;
  if (!target && !explicitNew) {
    const named = refs.filter(ref => {
      const escaped = ref.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(?:修改|调整|改|edit|change)\\s*(?:一下\\s*)?${escaped}(?![0-9])|${escaped}(?![0-9])\\s*(?:的)?[^，。;]{0,16}(?:改成|改为|换成|修改)`, "i").test(text);
    });
    if (named.length > 1) return clarify("这次要修改哪张图片？请明确写出图片名称，其他图片可以作为参考。");
    target = named[0];
    if (!target && continuing) {
      if (!previous) return clarify("无法唯一确定上一张结果，请把要继续修改的图片加入对话。");
      target = refs.find(ref => ref.assetId === previous.assetId);
      if (!target) return clarify("请将上一张结果加入本次对话引用，再继续修改。");
    }
    if (!target && edit && refs.length === 1) target = refs[0];
  }
  if (target && !target.shapeId) return clarify("快捷改图需要画布中的图片，请先将这张素材加入画布再选择它。");
  if (!forced && !explicitNew && refs.length > 1 && !target) return clarify("你引用了多张图片：要合成一张新图，还是修改其中一张？请写明图片名称。");
  if (!forced && edit && !target && !explicitNew) return clarify("请把要修改的图片加入对话，或明确说明需要设计一张新图。");
  if (refs.length && !target && !explicitNew && !/(?:生成|设计|海报|创作|制作|poster|design)/i.test(text)) return clarify("请说明要用这些参考设计什么，或者指定要修改的图片。");
  if (!target && refs.some(ref => ref.purpose === "EXACT") && !input.outputFrameId) return clarify("严格保留素材需要指定输出画框，请选择画框，或将素材用途改为参考后发送。");

  // Quoted/copywriting dimensions are poster content, not output settings.
  const sizeText = text.replace(/[“"'「].*?[”"'」]/g, "").replace(/(?:写上|写着|文字为|文案为|标注|印上|标题为|text\s+(?:says|is))[^，。;]*/gi, "");
  const dimensions = [...sizeText.matchAll(/(\d{2,5})\s*(?:×|x|X|\*|乘)\s*(\d{2,5})(?:\s*(?:像素|px))?/g)].map(match => ({ width: Number(match[1]), height: Number(match[2]) }));
  if (/(?:\d+(?:\.\d+)?)\s*(?:厘米|毫米|英寸|cm|mm|inch)/i.test(sizeText)) return clarify("请用像素宽高指定图片尺寸，例如 1080×1920；印刷单位需要先确定 DPI。");
  if (dimensions.length > 1 && dimensions.some(value => value.width !== dimensions[0]!.width || value.height !== dimensions[0]!.height)) return clarify("对话里有不同的输出尺寸，请只保留这次需要的宽×高。");
  const ratios = [...sizeText.matchAll(/(?:比例\s*(?:为|是|用)?\s*)?(1:1|4:5|3:4|2:3|9:16|5:4|4:3|3:2|16:10|16:9|2\.35:1|3:1)(?![\d:])/g)].map(match => match[1]!);
  if (new Set(ratios).size > 1) return clarify("对话里出现了多个比例，请确认这次的输出比例。");
  const tiers = [...sizeText.matchAll(/\b([1248])\s*[kK]\b/g)].map(match => `${match[1]}K`);
  if (tiers.some(tier => !["1K", "2K"].includes(tier)) || new Set(tiers).size > 1) return clarify("当前对话生成支持 1K 和 2K；更大的文件请通过图片尺寸工具明确设置。");
  let sizeSelection = { ...input.sizeSelection };
  let requestedSize = dimensions[0] ?? input.requestedSize ?? null;
  let sizeSource: StudioConversationIntent["sizeSource"] = requestedSize ? "dialog-pixels" : "control";
  if (!requestedSize && (ratios.length || tiers.length)) {
    sizeSelection = { ratioKey: (ratios[0] ?? input.sizeSelection.ratioKey) as typeof input.sizeSelection.ratioKey, resolutionTier: (tiers[0] ?? input.sizeSelection.resolutionTier) as "1K" | "2K" };
    if (sizeSelection.ratioKey === "custom") sizeSelection.customRatio = input.sizeSelection.customRatio;
    const resolved = resolveGenerationSize(sizeSelection);
    requestedSize = { width: resolved.width, height: resolved.height };
    sizeSource = "dialog-ratio";
  } else if (!requestedSize && target) {
    requestedSize = { width: target.width, height: target.height }; sizeSource = "target";
  } else if (!requestedSize) { const resolved = resolveGenerationSize(sizeSelection); requestedSize = { width: resolved.width, height: resolved.height }; }
  if (!StudioConversationPixels.safeParse(requestedSize).success) return clarify("该尺寸超过支持范围：单边 32–8192 像素，总量不超过 1677 万像素，比例在 1:3 到 3:1 之间。");
  if (dimensions.length && ratios.length) {
    const [w, h] = ratios[0]!.split(":").map(Number);
    if (Math.abs(requestedSize.width / requestedSize.height - w! / h!) > 0.01) return clarify("宽高和比例要求不一致，请确认一个输出尺寸。");
  }
  return StudioConversationIntent.parse({ action: target ? "modify" : "generate", targetReferenceId: target?.referenceId ?? null,
    referenceIds: refs.filter(ref => ref.referenceId !== target?.referenceId).map(ref => ref.referenceId), prompt: text, clarification: null,
    requestedSize, sizeSource, sizeSelection, parser: "safe-rules-v1" });
}
