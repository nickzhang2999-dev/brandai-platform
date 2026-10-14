import { assertOwnedDocumentWritable, type OwnedCanvasDocument, type OwnedCanvasItem } from "./owned-canvas-model";
import { getOwnedArrowBoundsPoints, getOwnedArrowMarker, getOwnedImageLayout, getOwnedLinePoints, getOwnedTextLayout } from "./owned-canvas-style";

export type OwnedExportScope = { itemIds?: string[]; frameId?: string; expandGroups?: boolean };
export type OwnedExportOptions = OwnedExportScope & { origin?: string; fetcher?: typeof fetch };
type ExportBounds = { x: number; y: number; w: number; h: number };
export type OwnedExportScene = { document: OwnedCanvasDocument; bounds: ExportBounds; frame?: OwnedCanvasItem };
const MAX_PIXELS = 16_000_000, MAX_SIDE = 8192, MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_EXPORT_BYTES = 32 * 1024 * 1024;
const exportTooLarge = () => new Error("导出内容超过 32 MiB 安全上限，请减少图片或压缩素材后重试。");
const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);

/** Bounds use the same top-left rotation origin as the owned renderer. */
function boundsForItems(items: OwnedCanvasItem[]): ExportBounds {
  if (!items.length) return { x: 0, y: 0, w: 1200, h: 800 };
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const item of items) {
    const cos = Math.cos(item.rotation), sin = Math.sin(item.rotation);
    const pad = item.kind === "image" || item.kind === "text" ? 0 : (item.strokeWidth ?? 2) / 2;
    const points = item.kind === "stroke" ? item.points! : item.kind === "shape" && item.shape === "arrow" ? getOwnedArrowBoundsPoints(item)
      : item.kind === "shape" && item.shape === "line" ? getOwnedLinePoints(item)
        : [{ x: 0, y: 0 }, { x: item.w, y: 0 }, { x: item.w, y: item.h }, { x: 0, y: item.h }];
    for (const point of points) {
      const x = item.x + point.x * cos - point.y * sin, y = item.y + point.x * sin + point.y * cos;
      left = Math.min(left, x - pad); right = Math.max(right, x + pad);
      top = Math.min(top, y - pad); bottom = Math.max(bottom, y + pad);
    }
  }
  return { x: Math.floor(left), y: Math.floor(top), w: Math.max(1, Math.ceil(right) - Math.floor(left)), h: Math.max(1, Math.ceil(bottom) - Math.floor(top)) };
}

/** Validate the WHOLE document before deriving a render-only subset. Never edit source. */
export function selectOwnedExportScene(doc: OwnedCanvasDocument, scope: OwnedExportScope = {}): OwnedExportScene {
  assertOwnedDocumentWritable(doc);
  const byId = new Map(doc.items.map(item => [item.id, item]));
  if (scope.itemIds !== undefined && (!Array.isArray(scope.itemIds) || scope.itemIds.length > 10_000
    || scope.itemIds.some(id => typeof id !== "string" || !byId.has(id)))) throw new Error("导出选区包含不存在的对象，请重新选择。");
  const frame = scope.frameId === undefined ? undefined : byId.get(scope.frameId);
  if (scope.frameId !== undefined && (!frame || frame.kind !== "frame")) throw new Error("请选择一个可见画框后再导出。");
  const groups = new Map<string, OwnedCanvasItem[]>(), children = new Map<string, OwnedCanvasItem[]>();
  for (const item of doc.items) {
    if (item.groupId) { const members = groups.get(item.groupId) ?? []; members.push(item); groups.set(item.groupId, members); }
    if (item.frameId) { const members = children.get(item.frameId) ?? []; members.push(item); children.set(item.frameId, members); }
  }
  const hidden = new Set(doc.items.filter(item => item.hidden).map(item => item.id)), hiddenQueue = [...hidden];
  for (let index = 0; index < hiddenQueue.length; index++) for (const child of children.get(hiddenQueue[index]!) ?? []) {
    if (!hidden.has(child.id)) { hidden.add(child.id); hiddenQueue.push(child.id); }
  }
  if (frame && hidden.has(frame.id)) throw new Error("请选择一个可见画框后再导出。");
  let selected: Set<string> | undefined;
  if (scope.itemIds !== undefined) {
    selected = new Set(scope.itemIds);
    const queue = [...selected], expandedGroups = new Set<string>();
    for (let index = 0; index < queue.length; index++) {
      const item = byId.get(queue[index]!)!;
      const related: OwnedCanvasItem[] = item.kind === "frame" ? [...(children.get(item.id) ?? [])] : [];
      if (scope.expandGroups !== false && item.groupId && !expandedGroups.has(item.groupId)) { expandedGroups.add(item.groupId); related.push(...(groups.get(item.groupId) ?? [])); }
      for (const member of related) if (!selected.has(member.id)) { selected.add(member.id); queue.push(member.id); }
    }
  }
  let inFrame: Set<string> | undefined;
  if (frame) {
    inFrame = new Set([frame.id]);
    const queue = [frame.id];
    for (let index = 0; index < queue.length; index++) for (const child of children.get(queue[index]!) ?? []) {
      if (!inFrame.has(child.id)) { inFrame.add(child.id); if (child.kind === "frame") queue.push(child.id); }
    }
  }
  const items = doc.items.filter(item => !hidden.has(item.id) && (!selected || selected.has(item.id)) && (!inFrame || inFrame.has(item.id)))
    .map(item => ({ ...item, ...(item.points ? { points: item.points.map(point => ({ ...point })) } : {}), ...(item.crop ? { crop: { ...item.crop } } : {}) }));
  if (scope.itemIds !== undefined && !items.length) throw new Error("当前选区没有可导出的可见对象。");
  const document = { ...doc, items };
  const bounds = frame ? { x: 0, y: 0, w: Math.ceil(frame.w), h: Math.ceil(frame.h) } : boundsForItems(items);
  return { document, bounds, ...(frame ? { frame: { ...frame } } : {}) };
}

/** This subset is for rendering only; retained membership references are not rewritten. */
export function getExportDocument(doc: OwnedCanvasDocument, scope: OwnedExportScope = {}): OwnedCanvasDocument {
  return selectOwnedExportScene(doc, scope).document;
}

export function getOwnedBounds(doc: OwnedCanvasDocument, scope: OwnedExportScope = {}): ExportBounds {
  return selectOwnedExportScene(doc, scope).bounds;
}

function safeDimensions(bounds: { w: number; h: number }) {
  if (bounds.w > MAX_SIDE || bounds.h > MAX_SIDE || bounds.w * bounds.h > MAX_PIXELS) throw new Error("导出范围超过 8192 像素或 1600 万像素，请缩小内容范围后重试。");
}

function rasterSize(bytes: Uint8Array, mime: string): { w: number; h: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === "image/png" && bytes.length >= 24) return { w: view.getUint32(16), h: view.getUint32(20) };
  if (mime === "image/jpeg") {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) return null;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++]!;
      if (marker === 0xda || marker === 0xd9) return null;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (offset + 2 > bytes.length) return null;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) return null;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return length >= 7 ? { w: view.getUint16(offset + 5), h: view.getUint16(offset + 3) } : null;
      }
      offset += length;
    }
  }
  if (mime === "image/webp" && bytes.length >= 25) {
    const chunk = String.fromCharCode(...bytes.subarray(12, 16));
    if (chunk === "VP8X" && bytes.length >= 30) return { w: 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16), h: 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16) };
    if (chunk === "VP8L" && bytes[20] === 0x2f) { const bits = view.getUint32(21, true); return { w: 1 + (bits & 0x3fff), h: 1 + ((bits >>> 14) & 0x3fff) }; }
    if (chunk === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) return { w: view.getUint16(26, true) & 0x3fff, h: view.getUint16(28, true) & 0x3fff };
  }
  return null;
}

async function embeddedImage(url: string, options: OwnedExportOptions, budget: number): Promise<{ data: string; bytes: number }> {
  const base = options.origin ?? (typeof location === "undefined" ? undefined : location.origin);
  if (!base) throw new Error("导出图片需要同源浏览器环境。");
  const origin = new URL(base).origin, resolved = new URL(url, origin);
  if (!["http:", "https:"].includes(resolved.protocol) || resolved.origin !== origin || resolved.username || resolved.password) throw new Error("图片尚未通过本站素材接口读取，请重新上传或选择持久化素材后导出。");
  if (budget <= 0) throw exportTooLarge();
  const readLimit = Math.min(MAX_IMAGE_BYTES, budget);
  const readTooLarge = () => budget < MAX_IMAGE_BYTES ? exportTooLarge() : new Error("素材超过导出读取上限。");
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await (options.fetcher ?? fetch)(resolved.href, { credentials: "same-origin", redirect: "error", signal: controller.signal });
    if (!response.ok || response.redirected || (response.url && new URL(response.url).origin !== origin)) throw new Error("有图片读取失败，导出已取消，避免生成缺图文件。");
    const mime = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (!["image/png", "image/jpeg", "image/webp"].includes(mime ?? "") || !response.body) throw new Error("导出仅支持已验证的 PNG、JPEG 或 WebP 素材。");
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > readLimit) throw readTooLarge();
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        length += part.value.length;
        if (length > readLimit) { await reader.cancel(); throw readTooLarge(); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const valid = mime === "image/png" ? bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value)
      : mime === "image/jpeg" ? bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[length - 2] === 255 && bytes[length - 1] === 217
        : bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP";
    if (!valid) throw new Error("图片数据与声明的类型不一致，导出已取消。");
    const size = rasterSize(bytes, mime!);
    if (!size || !size.w || !size.h || size.w > 16384 || size.h > 16384 || size.w * size.h > 40_000_000) throw new Error("源图片尺寸无法验证或超出安全上限。");
    if (typeof createImageBitmap !== "function") throw new Error("当前浏览器无法校验图片导出，请使用支持图像解码的浏览器。");
    // A matching MIME/header alone cannot prove the compressed pixels decode.
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mime! }));
    try { if (bitmap.width !== size.w || bitmap.height !== size.h) throw new Error("图片解码尺寸与文件声明不符，导出已取消。"); }
    finally { bitmap.close(); }
    let binary = "";
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return { data: `data:${mime};base64,${btoa(binary)}`, bytes: length };
  } finally { clearTimeout(timer); }
}

function shapeMarkup(item: OwnedCanvasItem, index: number, image?: string): string {
  const fill = escape(item.fill ?? (item.kind === "text" ? "#202027" : "#ede9fe")), stroke = escape(item.stroke ?? "#7c5cff"), sw = item.strokeWidth ?? 2;
  const style = `fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"`;
  let body: string;
  if (item.kind === "image") {
    if (!image) throw new Error("有图片读取失败，导出已取消，避免生成缺图文件。");
    const layout = getOwnedImageLayout(item);
    body = `<defs><clipPath id="owned-image-${index}"><rect width="${item.w}" height="${item.h}"/></clipPath></defs><g clip-path="url(#owned-image-${index})"><g transform="${layout.flipTransform}"><image x="${layout.x}" y="${layout.y}" width="${layout.w}" height="${layout.h}" preserveAspectRatio="none" href="${escape(image)}"/></g></g>`;
  }
  else if (item.kind === "text") {
    const layout = getOwnedTextLayout(item);
    const lines = layout.lines.map(line => `<tspan x="${line.x}" y="${line.y}">${escape(line.text)}</tspan>`).join("");
    body = `<defs><clipPath id="owned-text-${index}"><rect width="${item.w}" height="${item.h}"/></clipPath></defs><text clip-path="url(#owned-text-${index})" xml:space="preserve" font-family="${escape(layout.fontFamily)}" font-size="${layout.fontSize}" font-weight="${layout.fontWeight}" font-style="${layout.fontStyle}" text-anchor="${layout.anchor}" fill="${fill}">${lines}</text>`;
  } else if (item.kind === "stroke") {
    body = item.points!.length === 1 ? `<circle cx="${item.points![0]!.x}" cy="${item.points![0]!.y}" r="${sw / 2}" fill="${stroke}"/>`
      : `<polyline points="${item.points!.map(point => `${point.x},${point.y}`).join(" ")}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`;
  } else if (item.kind === "shape" && (item.shape === "line" || item.shape === "arrow")) {
    const [start, end] = getOwnedLinePoints(item), marker = getOwnedArrowMarker();
    const arrow = item.shape === "arrow";
    const definition = arrow ? `<defs><marker id="owned-arrow-${index}" viewBox="${marker.viewBox}" markerWidth="${marker.markerWidth}" markerHeight="${marker.markerHeight}" refX="${marker.refX}" refY="${marker.refY}" orient="${marker.orient}" markerUnits="${marker.markerUnits}"><path d="${marker.path}" fill="${stroke}"/></marker></defs>` : "";
    body = `${definition}<line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round"${arrow ? ` marker-end="url(#owned-arrow-${index})"` : ""}/>`;
  } else if (item.shape === "ellipse") body = `<ellipse cx="${item.w / 2}" cy="${item.h / 2}" rx="${item.w / 2}" ry="${item.h / 2}" ${style}/>`;
  else if (item.shape === "triangle") body = `<polygon points="${item.w / 2},0 ${item.w},${item.h} 0,${item.h}" ${style}/>`;
  else if (item.shape === "star") {
    const points = Array.from({ length: 10 }, (_, n) => {
      const angle = n * Math.PI / 5 - Math.PI / 2, radius = n % 2 ? 0.42 : 1;
      return `${item.w / 2 + Math.cos(angle) * item.w / 2 * radius},${item.h / 2 + Math.sin(angle) * item.h / 2 * radius}`;
    }).join(" ");
    body = `<polygon points="${points}" ${style}/>`;
  } else body = `<rect width="${item.w}" height="${item.h}" ${style}/>`;
  return `<g transform="translate(${item.x} ${item.y}) rotate(${item.rotation * 180 / Math.PI})" opacity="${item.opacity}">${body}</g>`;
}

/** The selected scene has already passed full-source validation before filtering. */
async function renderOwnedSvg(scene: OwnedExportScene, options: OwnedExportOptions): Promise<string> {
  const { document: doc, bounds, frame } = scene; safeDimensions(bounds);
  const images = new Map<string, string>();
  let fetchedBytes = 0, embeddedCharacters = 0;
  // Sequential and deduplicated to bound network and decoded-image pressure.
  for (const item of doc.items) if (item.kind === "image") {
    if (!images.has(item.url!)) {
      const image = await embeddedImage(item.url!, options, MAX_EXPORT_BYTES - fetchedBytes);
      fetchedBytes += image.bytes; images.set(item.url!, image.data);
    }
    // Each occurrence is embedded in the SVG, even when its fetch is shared.
    embeddedCharacters += images.get(item.url!)!.length;
    if (embeddedCharacters > MAX_EXPORT_BYTES) throw exportTooLarge();
  }
  let content = doc.items.map((item, index) => shapeMarkup(item, index, item.url ? images.get(item.url) : undefined)).join("");
  // Scene children stay in world coordinates. Inverse frame transform maps them
  // into output pixels; the outer clip is expressed in unrotated frame space.
  if (frame) content = `<defs><clipPath id="owned-export-frame"><rect width="${frame.w}" height="${frame.h}"/></clipPath></defs><g clip-path="url(#owned-export-frame)"><g transform="rotate(${-frame.rotation * 180 / Math.PI}) translate(${-frame.x} ${-frame.y})">${content}</g></g>`;
  const viewBox = frame ? `0 0 ${frame.w} ${frame.h}` : `${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${bounds.w}" height="${bounds.h}" viewBox="${viewBox}">${content}</svg>`;
  if (new TextEncoder().encode(svg).byteLength > MAX_EXPORT_BYTES) throw exportTooLarge();
  return svg;
}

/** Export supported visible content; never silently omit a failed selected image. */
export async function exportOwnedSvg(doc: OwnedCanvasDocument, options: OwnedExportOptions = {}): Promise<string> {
  return renderOwnedSvg(selectOwnedExportScene(doc, options), options);
}

export async function exportOwnedPng(doc: OwnedCanvasDocument, options: OwnedExportOptions = {}): Promise<Blob> {
  const scene = selectOwnedExportScene(doc, options), svg = await renderOwnedSvg(scene, options), bounds = scene.bounds;
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { image.src = ""; reject(new Error("导出绘制超时，请重试。")); }, 15_000);
      image.onload = () => { clearTimeout(timer); resolve(); };
      image.onerror = () => { clearTimeout(timer); reject(new Error("导出图片绘制失败，原画布仍保留。")); };
      image.src = url;
    });
    const canvas = document.createElement("canvas"); canvas.width = bounds.w; canvas.height = bounds.h;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法创建导出画布。");
    context.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("PNG 导出失败。")), "image/png"));
  } finally { URL.revokeObjectURL(url); }
}
