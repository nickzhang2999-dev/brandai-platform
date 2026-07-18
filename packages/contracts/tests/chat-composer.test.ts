/**
 * V0.0.13b — 对话面板富文本混排（图片 chip 藏在文字里，Lovart 形态）。
 *
 * 用户验收反馈：chip 不能是"文本框上方一排"，必须作为文字流的一部分嵌在
 * 句子里（"【chip】拿着【chip】在【chip】的背景里…"）。三条纯函数契约：
 *  1. serializeComposerTokens：composer 的 文本/chip token 流 → displayText
 *     （chip 位置用 U+FFFC 对象替换符 + 序号标记，用户无法手打出来，零碰撞）
 *     + 按出现顺序编号的 imageInputs；
 *  2. parseChatDisplayText：displayText + imageInputs → 渲染分段（文本段与
 *     chip 段交错，chip 段带 ordinal 与解析出的 ref）；
 *  3. buildModelBrief：displayText → 模型层 brief（标记替换为 [图N]，让
 *     多图 prompt 可读且与 multipart 顺序对应）。
 */
import { describe, expect, it } from "vitest";
import {
  buildModelBrief,
  CHAT_IMAGE_MARKER,
  parseChatDisplayText,
  serializeComposerTokens,
} from "../../../apps/web/src/lib/chat-composer";

const refA = { kind: "VERSION" as const, id: "va", url: "https://cdn/a.png" };
const refB = { kind: "ASSET" as const, id: "ab", url: "https://cdn/b.png" };

describe("serializeComposerTokens（富文本 → 线格式）", () => {
  it("chips embed as inline markers at their text positions, numbered in order", () => {
    const out = serializeComposerTokens([
      { type: "image", ref: refA },
      { type: "text", text: "拿着" },
      { type: "image", ref: refB },
      { type: "text", text: "在背景里, 增加《户外成就收藏家》的字" },
    ]);
    expect(out.displayText).toBe(
      `${CHAT_IMAGE_MARKER}1拿着${CHAT_IMAGE_MARKER}2在背景里, 增加《户外成就收藏家》的字`,
    );
    expect(out.imageInputs).toEqual([refA, refB]);
  });

  it("same image referenced twice = two ordered entries", () => {
    const out = serializeComposerTokens([
      { type: "image", ref: refA },
      { type: "text", text: "和" },
      { type: "image", ref: refA },
    ]);
    expect(out.imageInputs).toEqual([refA, refA]);
    expect(out.displayText).toBe(
      `${CHAT_IMAGE_MARKER}1和${CHAT_IMAGE_MARKER}2`,
    );
  });

  it("plain text stays verbatim with no inputs", () => {
    const out = serializeComposerTokens([
      { type: "text", text: "给我一张春季海报" },
    ]);
    expect(out.displayText).toBe("给我一张春季海报");
    expect(out.imageInputs).toEqual([]);
  });

  it("caps at 8 image inputs (extras dropped, text kept)", () => {
    const tokens = Array.from({ length: 9 }, (_, i) => ({
      type: "image" as const,
      ref: { kind: "VERSION" as const, id: `v${i}`, url: `https://cdn/${i}.png` },
    }));
    const out = serializeComposerTokens(tokens);
    expect(out.imageInputs).toHaveLength(8);
    expect(out.displayText).toContain(`${CHAT_IMAGE_MARKER}8`);
    expect(out.displayText).not.toContain(`${CHAT_IMAGE_MARKER}9`);
  });
});

describe("parseChatDisplayText（线格式 → 渲染分段）", () => {
  it("splits into interleaved text/image segments with resolved refs", () => {
    const segs = parseChatDisplayText(
      `${CHAT_IMAGE_MARKER}1拿着${CHAT_IMAGE_MARKER}2在背景里`,
      [refA, refB],
    );
    expect(segs).toEqual([
      { type: "image", ordinal: 1, ref: refA },
      { type: "text", text: "拿着" },
      { type: "image", ordinal: 2, ref: refB },
      { type: "text", text: "在背景里" },
    ]);
  });

  it("marker without matching input keeps a placeholder image segment", () => {
    const segs = parseChatDisplayText(`看这张${CHAT_IMAGE_MARKER}3`, [refA]);
    expect(segs).toEqual([
      { type: "text", text: "看这张" },
      { type: "image", ordinal: 3, ref: undefined },
    ]);
  });

  it("plain text yields a single text segment", () => {
    expect(parseChatDisplayText("纯文字", [])).toEqual([
      { type: "text", text: "纯文字" },
    ]);
  });

  it("round-trips serializeComposerTokens output", () => {
    const out = serializeComposerTokens([
      { type: "text", text: "把" },
      { type: "image", ref: refA },
      { type: "text", text: "放大" },
    ]);
    const segs = parseChatDisplayText(out.displayText, out.imageInputs);
    expect(segs).toEqual([
      { type: "text", text: "把" },
      { type: "image", ordinal: 1, ref: refA },
      { type: "text", text: "放大" },
    ]);
  });
});

describe("buildModelBrief（展示层 → 模型层）", () => {
  it("replaces markers with readable [图N] tokens", () => {
    expect(
      buildModelBrief(`${CHAT_IMAGE_MARKER}1拿着${CHAT_IMAGE_MARKER}2在背景里`),
    ).toBe("[图1]拿着[图2]在背景里");
  });

  it("leaves plain text untouched", () => {
    expect(buildModelBrief("春季海报")).toBe("春季海报");
  });
});

// ---- V0.0.13f · chip 文本 token（复制粘贴往返，Lovart 同款形态）+ 同图多引用 ----

import {
  chipToken,
  parseChipTokenText,
} from "../../../apps/web/src/lib/chat-composer";

describe("同一张图可多次引用（每个位置独立 chip/input）", () => {
  it("serializeComposerTokens 保留重复引用（各占一个 input + 标记）", () => {
    const a = { kind: "VERSION" as const, id: "v1", url: "https://x/a.png" };
    const out = serializeComposerTokens([
      { type: "image", ref: a },
      { type: "text", text: " 拿着" },
      { type: "image", ref: a },
    ]);
    expect(out.imageInputs).toHaveLength(2);
    expect(out.imageInputs[0]!.id).toBe("v1");
    expect(out.imageInputs[1]!.id).toBe("v1");
    expect(out.displayText).toBe("￼1 拿着￼2");
  });
});

describe("chipToken / parseChipTokenText（复制粘贴文本往返）", () => {
  it("token 格式与解析往返", () => {
    const t = chipToken(1, { kind: "VERSION", id: "cmr123", url: "https://cdn/x.png" });
    expect(t).toBe("[@image:#1:VERSION_cmr123:https://cdn/x.png]");
    const segs = parseChipTokenText(`${t} 拿着[@image:#2:ASSET_a9:https://cdn/y.png] 在背景里`);
    expect(segs).toEqual([
      { type: "chip", ref: { kind: "VERSION", id: "cmr123", url: "https://cdn/x.png" } },
      { type: "text", text: " 拿着" },
      { type: "chip", ref: { kind: "ASSET", id: "a9", url: "https://cdn/y.png" } },
      { type: "text", text: " 在背景里" },
    ]);
  });

  it("同图重复 token 各自成 chip", () => {
    const a = chipToken(1, { kind: "VERSION", id: "v1", url: "https://cdn/a.png" });
    const segs = parseChipTokenText(`${a} 拿着${a}`);
    expect(segs.filter((s) => s.type === "chip")).toHaveLength(2);
  });

  it("外部/不认识的 token 保持纯文本（不构造幻觉引用）", () => {
    const foreign = "[@image:#1:79587b6e90619f53:https://a.lovart.ai/artifacts/user/x.jpg]";
    const segs = parseChipTokenText(`${foreign} 增加艺术字`);
    expect(segs).toEqual([{ type: "text", text: `${foreign} 增加艺术字` }]);
  });

  it("无 token 的纯文本原样返回", () => {
    expect(parseChipTokenText("普通一句话")).toEqual([
      { type: "text", text: "普通一句话" },
    ]);
  });
});
