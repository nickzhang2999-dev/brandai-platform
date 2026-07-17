/**
 * V0.0.13b — 对话面板富文本混排的纯函数层（图片 chip 藏在文字里）。
 *
 * 展示层线格式：`chatDisplayText` 里用 U+FFFC（OBJECT REPLACEMENT CHARACTER，
 * 键盘打不出来 → 与用户手打文本零碰撞）+ 序号 标记第 N 个图片 chip 的
 * 文字位置；`imageInputs` 是按出现顺序编号的引用数组。模型层 brief 由
 * `buildModelBrief` 把标记替换为可读的 `[图N]`（与 /images/edits multipart
 * 的 image[] 顺序一一对应）。
 *
 * 铁律不变：displayText 永远只承载用户组织的内容（文字 + chip 位置），
 * 任何路径都不得把 URL / 文件名 / 引用块文本拼进来。
 */

export const CHAT_IMAGE_MARKER = "￼";

export const MAX_CHAT_IMAGE_INPUTS = 8;

export interface ChatComposerRef {
  kind: "VERSION" | "ASSET";
  id: string;
  url?: string;
}

export type ComposerToken =
  | { type: "text"; text: string }
  | { type: "image"; ref: ChatComposerRef };

export type DisplaySegment =
  | { type: "text"; text: string }
  | { type: "image"; ordinal: number; ref: ChatComposerRef | undefined };

/**
 * composer 的 token 流（DOM 遍历产物）→ 线格式。chip 按出现顺序编号
 * 1..8，超出上限的 chip 丢弃（组件层已经阻止插入第 9 个，这里兜底）。
 */
export function serializeComposerTokens(tokens: ComposerToken[]): {
  displayText: string;
  imageInputs: ChatComposerRef[];
} {
  let displayText = "";
  const imageInputs: ChatComposerRef[] = [];
  for (const t of tokens) {
    if (t.type === "text") {
      displayText += t.text;
      continue;
    }
    if (imageInputs.length >= MAX_CHAT_IMAGE_INPUTS) continue;
    imageInputs.push(t.ref);
    displayText += `${CHAT_IMAGE_MARKER}${imageInputs.length}`;
  }
  return { displayText, imageInputs };
}

/** 线格式 → 渲染分段（文本段与 chip 段交错，供气泡行内渲染）。 */
export function parseChatDisplayText(
  displayText: string,
  imageInputs: ChatComposerRef[],
): DisplaySegment[] {
  const segments: DisplaySegment[] = [];
  const re = new RegExp(`${CHAT_IMAGE_MARKER}(\\d+)`, "g");
  let last = 0;
  for (let m = re.exec(displayText); m; m = re.exec(displayText)) {
    if (m.index > last) {
      segments.push({ type: "text", text: displayText.slice(last, m.index) });
    }
    const ordinal = Number(m[1]);
    segments.push({
      type: "image",
      ordinal,
      ref: imageInputs[ordinal - 1],
    });
    last = m.index + m[0].length;
  }
  if (last < displayText.length) {
    segments.push({ type: "text", text: displayText.slice(last) });
  }
  if (segments.length === 0) segments.push({ type: "text", text: "" });
  return segments;
}

/** 展示层线格式 → 模型层 brief（标记替换为可读 [图N]）。 */
export function buildModelBrief(displayText: string): string {
  return displayText.replace(
    new RegExp(`${CHAT_IMAGE_MARKER}(\\d+)`, "g"),
    (_all, n: string) => `[图${n}]`,
  );
}
