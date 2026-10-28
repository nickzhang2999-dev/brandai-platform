import { validateOwnedCanvasItems, type OwnedCanvasDocument, type OwnedCanvasItem } from "@/lib/owned-canvas-model";
/** Native text objects use the existing history, autosave and export pipeline. */
export function placeCopywriting(document: OwnedCanvasDocument, text: string, receiptId: string, anchorId?: string): OwnedCanvasDocument {
  const id = "shape:copy-" + receiptId.replace(/[^a-zA-Z0-9_-]/g, "");
  if (document.items.some(item => item.id === id)) return document;
  if (document.warnings.length || !text.trim() || text.length > 5000) throw new Error("当前画布或文案无法插入，请检查后再试。");
  const anchor = document.items.find(item => item.id === anchorId && !item.hidden);
  const x = anchor ? anchor.x + anchor.w + 40 : (-document.camera.x + 80) / document.camera.zoom;
  const y = anchor ? anchor.y : (-document.camera.y + 80) / document.camera.zoom;
  // The native SVG renderer lays out explicit lines, so wrap before insertion.
  const lines = text.split("\n").flatMap(line => { const result: string[] = []; let current = "", width = 0;
    for (const char of line) { const size = /[\u0000-\u007f]/.test(char) ? 0.6 : 1; if (width + size > 18) { result.push(current); current = ""; width = 0; } current += char; width += size; }
    return [...result, current]; });
  return { ...document, items: [...document.items, { id, kind: "text", text: lines.join("\n"), x, y, w: 460, h: Math.max(90, lines.length * 34),
    rotation: 0, opacity: 1, fontSize: 24, fontFamily: "sans", fontWeight: "normal", fontStyle: "normal", textAlign: "left", lineHeight: 1.4 }] };
}

const WRITING_ROW_WIDTH = 32;
const WRITING_CHUNK_LINES = 32;
const WRITING_CHUNK_CHARACTERS = 4000;
const WRITING_PAGE_LINES = 40;
const WRITING_WIDTH = 720;
const WRITING_LINE_HEIGHT = 30;

/** Split only at grapheme boundaries. Each row is an exact slice of the input:
 * soft wrapping uses separate native objects, never new characters in the text. */
function writingRows(text: string): string[] {
  const segments = Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), value => value.segment);
  const widths = segments.map(value => value === "\t" ? 4 : Math.max(1,
    Array.from(value).filter(character => !/[\p{Mark}\u200d\ufe0e\ufe0f]/u.test(character)).length));
  if (segments.some((value, index) => value.length > WRITING_CHUNK_CHARACTERS || widths[index]! > WRITING_ROW_WIDTH)) {
    throw new Error("文案含有过长的连续字符组合，请先分段；原文没有被截断。");
  }
  const rows: string[] = [];
  for (let start = 0; start < segments.length;) {
    let end = start, width = 0, characters = 0, lastBreak = start;
    while (end < segments.length) {
      const value = segments[end]!, newline = value.endsWith("\n");
      if (end > start && (characters + value.length > WRITING_CHUNK_CHARACTERS || (!newline && width + widths[end]! > WRITING_ROW_WIDTH))) break;
      characters += value.length; width += newline ? 0 : widths[end]!; end++;
      if (newline) break;
      if (/[\s，。！？、；：,.!?;:]$/u.test(value)) lastBreak = end;
    }
    // Prefer a word/sentence boundary without making tiny fragments. Preserve
    // original CRLF, leading/trailing spaces, blank lines and all emoji bytes.
    if (end < segments.length && !segments[end - 1]!.endsWith("\n") && lastBreak > start && lastBreak - start >= (end - start) / 2) end = lastBreak;
    rows.push(segments.slice(start, end).join("")); start = end;
  }
  return rows;
}

/** One immutable document change: the caller records one undo step for the
 * whole handoff. Existing canvas limits and the old short-copy API are intact. */
export function placeWritingDocument(document: OwnedCanvasDocument, text: string, receiptId: string, anchorId?: string): OwnedCanvasDocument {
  if (document.warnings.length || !text.trim() || text.length > 60000 || text.includes("\0")) throw new Error("当前画布或文案无法插入，请检查后再试；原文仍保留。");
  // The caller supplies the immutable writing document id + revision. Reject
  // malformed ids instead of sanitizing different receipts into the same id.
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(receiptId)) throw new Error("文案版本标识无效，请刷新后再试。");
  if (document.items.some(item => item.id === "shape:copy-" + receiptId)) return document;
  const chunks: { text: string; lines: number }[] = [];
  for (const row of writingRows(text)) {
    const previous = chunks[chunks.length - 1];
    if (previous?.text.endsWith("\n") && previous.lines < WRITING_CHUNK_LINES && previous.text.length + row.length <= WRITING_CHUNK_CHARACTERS) {
      previous.text += row; previous.lines++;
    } else chunks.push({ text: row, lines: 1 });
  }
  const prefix = "shape:writing-" + receiptId.length + "_" + receiptId + "-";
  const ids = chunks.map((_, index) => prefix + index);
  const previous = document.items.filter(item => item.id.startsWith(prefix));
  if (previous.length) {
    const previousIds = new Set(previous.map(item => item.id));
    if (previous.length === ids.length && ids.every(id => previousIds.has(id))) return document;
    throw new Error("这版文案已部分送入画布或被编辑，请先核对；不会重复插入或覆盖现有内容。");
  }
  const anchor = document.items.find(item => item.id === anchorId && !item.hidden);
  const x = anchor ? anchor.x + anchor.w + 40 : (-document.camera.x + 80) / document.camera.zoom;
  const y = anchor ? anchor.y : (-document.camera.y + 80) / document.camera.zoom;
  if (![document.camera.x, document.camera.y].every(value => Number.isFinite(value) && Math.abs(value) <= 1e7)
    || !Number.isFinite(document.camera.zoom) || document.camera.zoom < 0.01 || document.camera.zoom > 100) throw new Error("画布视角无效，请恢复视角后再试。");
  let page = 0, line = 0;
  const additions: OwnedCanvasItem[] = chunks.map((chunk, index) => {
    if (line + chunk.lines > WRITING_PAGE_LINES) { page++; line = 0; }
    const item: OwnedCanvasItem = { id: ids[index]!, kind: "text", text: chunk.text,
      x: x + (page % 2) * (WRITING_WIDTH + 80), y: y + Math.floor(page / 2) * (WRITING_PAGE_LINES * WRITING_LINE_HEIGHT + 80) + line * WRITING_LINE_HEIGHT,
      w: WRITING_WIDTH, h: chunk.lines * WRITING_LINE_HEIGHT, rotation: 0, opacity: 1,
      fontSize: 20, fontFamily: "sans", fontWeight: "normal", fontStyle: "normal", textAlign: "left", lineHeight: 1.5 };
    line += chunk.lines; return item;
  });
  const items = [...document.items, ...additions];
  // Validate the complete result before returning anything: item/text capacity
  // or coordinate overflow must never produce a truncated or partial handoff.
  validateOwnedCanvasItems(items, document.pageId);
  return { ...document, items };
}
