/** Novart-owned scene data. No editor SDK is loaded by this adapter. */
export type OwnedCanvasItem = {
  id: string; kind: "image" | "shape" | "text" | "stroke" | "frame";
  x: number; y: number; w: number; h: number; rotation: number; opacity: number;
  fill?: string; stroke?: string; strokeWidth?: number;
  shape?: "rect" | "ellipse" | "triangle" | "star" | "line" | "arrow";
  text?: string; fontSize?: number; points?: { x: number; y: number }[];
  fontFamily?: "sans" | "serif" | "mono"; fontWeight?: "normal" | "bold";
  fontStyle?: "normal" | "italic"; textAlign?: "left" | "center" | "right"; lineHeight?: number;
  /** Crop is normalized against the original image, before either flip. */
  crop?: { x: number; y: number; w: number; h: number }; flipX?: boolean; flipY?: boolean;
  /** Frame membership uses world coordinates; parentId remains the page. */
  hidden?: boolean; locked?: boolean; groupId?: string; frameId?: string;
  url?: string; assetId?: string; assetSha256?: string; versionId?: string; parentId?: string;
  /** Project-local, persistent display identity. Never used as an asset identifier. */
  imageNumber?: number; sourceShapeId?: string;
};
export type OwnedCanvasDocument = {
  items: OwnedCanvasItem[]; camera: { x: number; y: number; zoom: number };
  pageId: string; source: Record<string, unknown>; warnings: string[];
};
type RecordValue = Record<string, unknown>;
const own = (value: RecordValue, key: string) => Object.prototype.hasOwnProperty.call(value, key);
export const isOwnedRecord = (value: unknown): value is RecordValue =>
  !!value && typeof value === "object" && !Array.isArray(value);
const record = (value: unknown): RecordValue => isOwnedRecord(value) ? value : {};
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const coordinate = (value: unknown): value is number => finite(value) && Math.abs(value) <= 1e7;
const dimension = (value: unknown): value is number => finite(value) && value > 0 && value <= 1e7;
const shapeId = (value: unknown): value is string => typeof value === "string" && /^shape:[A-Za-z0-9_-]{1,128}$/.test(value);
const groupId = (value: unknown): value is string => typeof value === "string" && /^group:[A-Za-z0-9_-]{1,128}$/.test(value);
const color = (value: unknown) => typeof value === "string" && /^(?:#(?:[a-fA-F0-9]{3}|[a-fA-F0-9]{4}|[a-fA-F0-9]{6}|[a-fA-F0-9]{8})|(?:rgb|rgba)\([\d.,% ]+\)|black|white|transparent|none)$/.test(value);
const safeUrl = (value: unknown): value is string => typeof value === "string" && value.length <= 4096
  && !/[\x00-\x20\x7f]/.test(value) && (/^\/(?!\/)/.test(value) || /^https?:\/\//.test(value));
const fail = (message = "画布包含暂时不能可靠转换的内容，原数据仍保留，暂不能保存或导出。") => new Error(message);

/** Reject non-JSON/cyclic or unbounded input before cloning retained records. */
function cloneJson<T>(input: T): T {
  const stack: { value: unknown; depth: number }[] = [{ value: input, depth: 0 }];
  let count = 0;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (++count > 500_000 || depth > 80) throw fail("画布数据过大或层级过深。");
    if (value === null || typeof value === "string" || typeof value === "boolean") continue;
    if (typeof value === "number") { if (!finite(value)) throw fail("画布坐标无效。"); continue; }
    if (Array.isArray(value)) { value.forEach(child => stack.push({ value: child, depth: depth + 1 })); continue; }
    if (!isOwnedRecord(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fail("画布数据格式无效。");
    Object.values(value).forEach(child => stack.push({ value: child, depth: depth + 1 }));
  }
  return JSON.parse(JSON.stringify(input)) as T;
}

export function emptyOwnedDocument(): OwnedCanvasDocument {
  const pageId = "page:novart";
  return { items: [], camera: { x: 100, y: 80, zoom: 1 }, pageId, warnings: [], source: {
    novartOwnedCanvas: { version: 1 }, tldrawSnapshot: { document: { schema: { schemaVersion: 2 },
      store: { [pageId]: { id: pageId, typeName: "page", name: "画布", index: "a1", meta: {} } } },
      session: { currentPageId: pageId, camera: { x: 100, y: 80, z: 1 } } },
  } };
}

function unsupportedEffects(value: RecordValue, props: RecordValue, ownedV2: boolean): boolean {
  const meta = record(value.meta);
  for (const object of [value, props, meta]) {
    // Native grouping/container conventions are never inferred as owned links.
    if (["groupId", "frameId"].some(key => object[key] !== undefined)) return true;
    if (["hidden", "isHidden", "isLocked", "locked"].some(key => object[key] !== undefined && object[key] !== false)
      || (object.visible !== undefined && object.visible !== true) || (object.visibility !== undefined && object.visibility !== "visible")) return true;
    if (["scale", "scaleX", "scaleY", "skewX", "skewY", "transform", "matrix"].some(key => object[key] !== undefined)) return true;
    if (["clip", "clipPath", "mask", "crop", "clipContent", "clipChildren", ...(!ownedV2 || object !== props ? ["flipX", "flipY"] : [])].some(key =>
      object[key] !== undefined && object[key] !== false && object[key] !== null)) return true;
    if (["filter", "filters", "effects", "blur", "blendMode"].some(key => object[key] !== undefined
      && object[key] !== false && object[key] !== null && object[key] !== "none" && object[key] !== "normal")) return true;
  }
  if (meta.agentHiddenUntilFit === true || meta.isUploading === true) return true;
  if (props.opacity !== undefined && props.opacity !== 1) return true;
  if (props.radius !== undefined && props.radius !== 0) return true;
  if (props.adjust !== undefined && (!isOwnedRecord(props.adjust) || Object.values(props.adjust).some(v => v !== 0))) return true;
  if (props.cropRegion !== undefined && !ownedV2) {
    const crop = record(props.cropRegion);
    if (crop.x !== 0 || crop.y !== 0 || crop.w !== 1 || crop.h !== 1 || Object.keys(crop).length !== 4) return true;
  }
  return false;
}

function readItem(value: RecordValue): OwnedCanvasItem | null {
  const props = record(value.props), meta = record(value.meta);
  const ownedMeta = record(meta.novartOwned), ownedV3 = props.novartVersion === 3 && ownedMeta.version === 3;
  const ownedV2 = props.novartVersion === 2 && ownedMeta.version === 2 || ownedV3;
  if ((props.novartVersion !== undefined && ![1, 2, 3].includes(props.novartVersion as number))
    || ([2, 3].includes(props.novartVersion as number) && !ownedV2)
    || (meta.novartOwned !== undefined && (!ownedV2 || Object.keys(ownedMeta).some(key => !["version", "hidden", "locked", "groupId", "frameId", ...(ownedV3 ? ["imageNumber", "sourceShapeId"] : [])].includes(key))))) return null;
  if (!shapeId(value.id) || !coordinate(value.x) || !coordinate(value.y)
    || !dimension(props.w) || !dimension(props.h) || !finite(value.rotation ?? 0)
    || typeof value.index !== "string" || !/^[A-Za-z][A-Za-z0-9]{0,255}$/.test(value.index)
    || !finite(value.opacity ?? 1) || Number(value.opacity ?? 1) < 0 || Number(value.opacity ?? 1) > 1
    || unsupportedEffects(value, props, ownedV2 && value.type === "c-image")) return null;
  const owned = props.novartVersion === 1 || ownedV2;
  if (!ownedV2 && (["fontFamily", "fontWeight", "fontStyle", "textAlign", "lineHeight"].some(key => props[key] !== undefined)
    || ["line", "arrow"].includes(String(props.novartShape)))) return null;
  let kind: OwnedCanvasItem["kind"];
  if (value.type === "c-image") kind = "image";
  else if (owned && ["shape", "text", "stroke", "frame"].includes(String(props.novartKind))) kind = props.novartKind as OwnedCanvasItem["kind"];
  else if (value.type === "geo" && ["rectangle", "ellipse", "triangle", "star"].includes(String(props.geo))) kind = "shape";
  else if ((value.type === "text" || value.type === "c-text") && typeof props.text === "string" && finite(props.fontSize)) kind = "text";
  else return null;
  if (kind !== "image" && (ownedMeta.imageNumber !== undefined || ownedMeta.sourceShapeId !== undefined)) return null;
  if (kind !== "text" && ["fontFamily", "fontWeight", "fontStyle", "textAlign", "lineHeight"].some(key => props[key] !== undefined)) return null;
  // Native symbolic fonts/colors/fills and rich labels are not guessed. Preserve
  // their full records and block writes until an exact adapter exists.
  if (!owned && kind !== "image") {
    const allowed = new Set(["w", "h", "geo", "text", "fontSize", "color", "fill", "stroke", "strokeWidth"]);
    if (Object.keys(props).some(key => !allowed.has(key))) return null;
  }
  const item: OwnedCanvasItem = { id: value.id, kind, x: value.x, y: value.y,
    w: props.w, h: props.h, rotation: Number(value.rotation ?? 0), opacity: Number(value.opacity ?? 1),
    ...(typeof value.parentId === "string" ? { parentId: value.parentId } : {}) };
  if (ownedV2) {
    for (const key of ["hidden", "locked", "groupId", "frameId"] as const) {
      if (ownedMeta[key] !== undefined) Object.assign(item, { [key]: ownedMeta[key] });
    }
  }
  if (kind === "image") {
    if (!safeUrl(props.url)) return null;
    item.url = props.url;
    if (ownedV3) {
      if (ownedMeta.imageNumber !== undefined) item.imageNumber = ownedMeta.imageNumber as number;
      if (ownedMeta.sourceShapeId !== undefined) item.sourceShapeId = ownedMeta.sourceShapeId as string;
    }
    if (typeof meta.novartAssetId === "string") item.assetId = meta.novartAssetId;
    if (typeof meta.novartAssetSha256 === "string") item.assetSha256 = meta.novartAssetSha256;
    if (typeof meta.novartVersionId === "string") item.versionId = meta.novartVersionId;
    if (ownedV2) {
      if (props.cropRegion !== undefined) item.crop = props.cropRegion as OwnedCanvasItem["crop"];
      if (props.flipX !== undefined) item.flipX = props.flipX as boolean;
      if (props.flipY !== undefined) item.flipY = props.flipY as boolean;
    }
  } else {
    const fill = props.novartFill ?? props.fill ?? (kind === "text" ? props.color ?? "#202027" : kind === "stroke" ? "none" : "#ede9fe");
    const stroke = props.novartStroke ?? props.stroke ?? "#7c5cff";
    if (!color(fill) || !color(stroke) || !finite(props.novartStrokeWidth ?? props.strokeWidth ?? 2)) return null;
    item.fill = fill as string; item.stroke = stroke as string;
    item.strokeWidth = Number(props.novartStrokeWidth ?? props.strokeWidth ?? 2);
    if (kind === "shape") item.shape = (props.novartShape ?? (props.geo === "rectangle" ? "rect" : props.geo) ?? "rect") as OwnedCanvasItem["shape"];
    if (kind === "text") { if (typeof props.text !== "string") return null; item.text = props.text; item.fontSize = Number(props.fontSize ?? 24); }
    if (kind === "stroke") { if (!Array.isArray(props.novartPoints)) return null; item.points = props.novartPoints as OwnedCanvasItem["points"]; }
    if (ownedV2 && kind === "shape" && props.novartPoints !== undefined) item.points = props.novartPoints as OwnedCanvasItem["points"];
    if (ownedV2 && kind === "text") {
      for (const key of ["fontFamily", "fontWeight", "fontStyle", "textAlign", "lineHeight"] as const) {
        if (props[key] !== undefined) Object.assign(item, { [key]: props[key] });
      }
    }
  }
  try { validateItem(item); } catch { return null; }
  return item;
}

function validateItem(item: OwnedCanvasItem) {
  if (!shapeId(item.id) || !["image", "shape", "text", "stroke", "frame"].includes(item.kind)
    || !coordinate(item.x) || !coordinate(item.y) || !dimension(item.w) || !dimension(item.h)
    || !finite(item.rotation) || Math.abs(item.rotation) > 1e6 || !finite(item.opacity) || item.opacity < 0 || item.opacity > 1) throw fail("画布元素的坐标、尺寸或透明度无效。");
  for (const value of [item.fill, item.stroke]) if (value !== undefined && !color(value)) throw fail("暂不支持这种画布颜色。");
  if (item.strokeWidth !== undefined && (!finite(item.strokeWidth) || item.strokeWidth < 0 || item.strokeWidth > 1000)) throw fail("画笔宽度无效。");
  if (item.kind === "image" && !safeUrl(item.url)) throw fail("图片尚未持久化，请等待上传成功后再保存。");
  if (item.imageNumber !== undefined && (item.kind !== "image" || !Number.isSafeInteger(item.imageNumber) || item.imageNumber < 1 || item.imageNumber > 1_000_000_000)) throw fail("图片编号无效。");
  if (item.sourceShapeId !== undefined && (item.kind !== "image" || !shapeId(item.sourceShapeId) || item.sourceShapeId === item.id)) throw fail("图片来源对象标识无效。");
  if (item.shape !== undefined && !["rect", "ellipse", "triangle", "star", "line", "arrow"].includes(item.shape)) throw fail("图形类型无效。");
  for (const key of ["hidden", "locked", "flipX", "flipY"] as const) if (item[key] !== undefined && typeof item[key] !== "boolean") throw fail("图层状态无效。");
  if ((item.groupId !== undefined && !groupId(item.groupId)) || (item.frameId !== undefined && !shapeId(item.frameId))) throw fail("分组或画框标识无效。");
  if (item.crop !== undefined) {
    const crop = item.crop;
    if (item.kind !== "image" || !isOwnedRecord(crop) || Object.keys(crop).length !== 4
      || ![crop.x, crop.y, crop.w, crop.h].every(finite) || crop.x < 0 || crop.y < 0 || crop.w <= 0 || crop.h <= 0
      || crop.x + crop.w > 1 + 1e-9 || crop.y + crop.h > 1 + 1e-9) throw fail("裁剪范围必须在原图之内。");
    if (!finite(item.w / crop.w) || !finite(item.h / crop.h) || item.w / crop.w > 1e9 || item.h / crop.h > 1e9) throw fail("裁剪范围过小，图片显示尺寸超过安全上限。");
  }
  if (item.kind !== "image" && (item.flipX !== undefined || item.flipY !== undefined)) throw fail("翻转仅支持图片。");
  for (const [key, allowed] of [["fontFamily", ["sans", "serif", "mono"]], ["fontWeight", ["normal", "bold"]], ["fontStyle", ["normal", "italic"]], ["textAlign", ["left", "center", "right"]]] as const) {
    if (item[key] !== undefined && (item.kind !== "text" || !(allowed as readonly string[]).includes(item[key]!))) throw fail("文字样式无效。");
  }
  if (item.lineHeight !== undefined && (item.kind !== "text" || !finite(item.lineHeight) || item.lineHeight < 0.5 || item.lineHeight > 5)) throw fail("文字行距无效。");
  if (item.kind === "text" && (typeof item.text !== "string" || item.text.length > 100_000
    || !finite(item.fontSize ?? 24) || (item.fontSize ?? 24) < 1 || (item.fontSize ?? 24) > 4096)) throw fail("文字内容或字号无效。");
  if (item.kind === "stroke" && (!Array.isArray(item.points) || item.points.length < 1 || item.points.length > 100_000
    || item.points.some(point => !isOwnedRecord(point) || !coordinate(point.x) || !coordinate(point.y)))) throw fail("笔迹数据无效。");
  if (item.kind === "shape" && item.points !== undefined && (!["line", "arrow"].includes(item.shape ?? "") || !Array.isArray(item.points) || item.points.length !== 2
    || item.points.some(point => !isOwnedRecord(point) || !coordinate(point.x) || !coordinate(point.y)
      || point.x < 0 || point.y < 0 || point.x > item.w || point.y > item.h))) throw fail("线条端点无效。");
  for (const key of ["assetId", "versionId"] as const) if (item[key] !== undefined && (typeof item[key] !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(item[key]!))) throw fail("图片资源标识无效。");
  if (item.assetSha256 !== undefined && !/^[a-fA-F0-9]{64}$/.test(item.assetSha256)) throw fail("图片资源摘要无效。");
}

/** Shared validation for pure editing operations and the save boundary. */
export function validateOwnedCanvasItems(items: OwnedCanvasItem[], pageId?: string) {
  if (items.length > 10_000) throw fail("画布元素数量超出当前编辑器上限。");
  const byId = new Map<string, OwnedCanvasItem>(), groups = new Map<string, OwnedCanvasItem[]>();
  let pointCount = 0, textLength = 0; const imageNumbers = new Set<number>();
  for (const item of items) {
    validateItem(item);
    if (item.imageNumber !== undefined) {
      if (imageNumbers.has(item.imageNumber)) throw fail("项目图片编号重复，原数据已保留。");
      imageNumbers.add(item.imageNumber);
    }
    if (byId.has(item.id) || (pageId !== undefined && item.parentId !== undefined && item.parentId !== pageId)) throw fail("暂不能保存重复对象或嵌套容器。");
    byId.set(item.id, item);
    if (item.groupId) { const members = groups.get(item.groupId); if (members) members.push(item); else groups.set(item.groupId, [item]); }
    pointCount += item.points?.length ?? 0; textLength += item.text?.length ?? 0;
    if (pointCount > 100_000 || textLength > 1_000_000) throw fail("画布笔迹或文字超过当前处理上限。");
  }
  const validatedFrames = new Set<string>();
  for (const item of items) {
    if (validatedFrames.has(item.id)) continue;
    const visited = new Set([item.id]); let current = item;
    while (current.frameId) {
      const frame = byId.get(current.frameId);
      if (!frame || frame.kind !== "frame" || visited.has(frame.id)) throw fail("画框关联缺失或存在循环。");
      if (validatedFrames.has(frame.id)) break;
      visited.add(frame.id); current = frame;
    }
    for (const id of visited) validatedFrames.add(id);
  }
  for (const members of groups.values()) {
    if (members.length < 2 || members.some(item => item.frameId !== members[0]!.frameId)) throw fail("分组至少需要两个同级对象。");
  }
}

export function parseOwnedDocument(input: unknown): OwnedCanvasDocument {
  const source = cloneJson(input);
  if (!isOwnedRecord(source) || !isOwnedRecord(source.tldrawSnapshot)) throw fail("画布文档格式无法识别。");
  const snapshot = source.tldrawSnapshot, document = record(snapshot.document), store = record(document.store);
  if (!isOwnedRecord(document.store) || !isOwnedRecord(document.schema)) throw fail("画布文档结构无法识别。");
  const session = record(snapshot.session), pageEntries = Object.entries(store).filter(([, value]) => isOwnedRecord(value) && value.typeName === "page");
  const pages = pageEntries.map(([, value]) => value as RecordValue);
  const pageId = typeof session.currentPageId === "string" && pages.some(page => page.id === session.currentPageId)
    ? session.currentPageId : typeof pages[0]?.id === "string" ? pages[0].id : "page:novart";
  const warnings: string[] = [], items: OwnedCanvasItem[] = [];
  if (snapshot.session !== undefined && !isOwnedRecord(snapshot.session)) warnings.push("旧版会话结构无法识别，当前版本仅只读保留。");
  if (!pages.length || pageEntries.some(([id, value]) => record(value).id !== id || !/^page:[A-Za-z0-9_-]{1,128}$/.test(id))
    || Object.entries(store).some(([id, value]) => id.startsWith("page:") && (!isOwnedRecord(value) || value.typeName !== "page"))) {
    warnings.push("画布页面记录不完整，当前版本仅只读保留。");
  }
  if ((session.currentPageId !== undefined && (typeof session.currentPageId !== "string" || !pages.some(page => page.id === session.currentPageId)))
    || (session.currentPageId === undefined && pages.length > 1)) warnings.push("无法可靠确定当前画布页面，当前版本仅只读保留。");
  if (source.novartOwnedCanvas !== undefined && ![1, 2, 3].includes(record(source.novartOwnedCanvas).version as number)) warnings.push("该画布来自更新的数据版本，当前版本仅只读保留。");
  const imageSequence = record(source.novartOwnedCanvas).imageSequence;
  if (imageSequence !== undefined && (!Number.isSafeInteger(imageSequence) || Number(imageSequence) < 0 || Number(imageSequence) > 1_000_000_000)) warnings.push("图片编号序列无法可靠恢复，当前版本仅只读保留。");
  const entries = Object.entries(store).filter(([, value]) => isOwnedRecord(value) && value.typeName === "shape")
    .sort(([, left], [, right]) => {
      const a = String(record(left).index ?? ""), b = String(record(right).index ?? "");
      return a < b ? -1 : a > b ? 1 : 0;
    });
  if (entries.length > 10_000) throw fail("画布元素数量超出当前编辑器上限。");
  for (const [id, raw] of entries) {
    const value = record(raw), item = value.id === id ? readItem(value) : null;
    if (!item) { warnings.push("有旧版对象尚不能可靠显示，原始记录已保留。"); continue; }
    if (!pages.some(page => page.id === value.parentId) || value.parentId !== pageId) {
      warnings.push("画布包含父级容器或其他页面的对象，当前版本仅只读保留。");
    }
    items.push(item);
  }
  if (Object.values(store).some(value => isOwnedRecord(value) && value.typeName === "binding")) warnings.push("画布包含尚未支持的对象关联，当前版本仅只读保留。");
  if (Object.entries(store).some(([id, value]) => id.startsWith("shape:") && (!isOwnedRecord(value) || value.typeName !== "shape"))) warnings.push("画布包含损坏或未知的对象记录，当前版本仅只读保留。");
  try { validateOwnedCanvasItems(items); } catch { warnings.push("画布中的分组或画框关联无法可靠恢复，当前版本仅只读保留。"); }
  // Native session snapshots keep world-space camera offsets in pageStates:
  // viewport=(world+nativeCamera)*zoom. Our renderer stores viewport pixels:
  // viewport=world*zoom+ownedCamera. Never silently reset a recovered viewport.
  const pageStates = Array.isArray(session.pageStates) ? session.pageStates : [];
  if (session.pageStates !== undefined && !Array.isArray(session.pageStates)) warnings.push("旧版页面视角结构无法识别，当前版本仅只读保留。");
  const currentStates = pageStates.filter(value => isOwnedRecord(value) && value.pageId === pageId);
  if (currentStates.length > 1) warnings.push("旧版页面含有冲突的视角记录，当前版本仅只读保留。");
  const ownedPixels = [1, 2, 3].includes(record(source.novartOwnedCanvas).version as number) && isOwnedRecord(session.camera);
  const cameraInput = ownedPixels ? session.camera : record(currentStates[0]).camera ?? session.camera;
  if (cameraInput !== undefined && (!isOwnedRecord(cameraInput) || !own(cameraInput, "x") || !own(cameraInput, "y")
    || (!own(cameraInput, "z") && !own(cameraInput, "zoom")))) warnings.push("画布视角暂不能可靠转换，原始视角已保留。");
  const rawCamera = record(cameraInput), nativeX = rawCamera.x ?? 0, nativeY = rawCamera.y ?? 0, zoom = rawCamera.z ?? rawCamera.zoom ?? 1;
  const x = ownedPixels ? nativeX : finite(nativeX) && finite(zoom) ? nativeX * zoom : nativeX;
  const y = ownedPixels ? nativeY : finite(nativeY) && finite(zoom) ? nativeY * zoom : nativeY;
  if (!coordinate(x) || !coordinate(y) || !finite(zoom) || zoom < 0.01 || zoom > 100) warnings.push("画布视角暂不能可靠转换，原始视角已保留。");
  return { source, items, pageId, warnings: [...new Set(warnings)], camera: {
    x: coordinate(x) ? x : 100, y: coordinate(y) ? y : 80, zoom: finite(zoom) && zoom >= 0.01 && zoom <= 100 ? zoom : 1 } };
}

export function assertOwnedDocumentWritable(doc: OwnedCanvasDocument) {
  const original = doc && parseOwnedDocument(doc.source);
  if (!doc || !Array.isArray(doc.items) || !Array.isArray(doc.warnings) || doc.warnings.length
    || original.warnings.length) throw fail();
  if (!/^page:[A-Za-z0-9_-]{1,128}$/.test(doc.pageId) || doc.pageId !== original.pageId
    || !coordinate(doc.camera.x) || !coordinate(doc.camera.y) || !finite(doc.camera.zoom) || doc.camera.zoom < 0.01 || doc.camera.zoom > 100) throw fail("画布页面或视角无效。");
  validateOwnedCanvasItems(doc.items, doc.pageId);
  return original;
}

export function serializeOwnedDocument(doc: OwnedCanvasDocument): RecordValue {
  const original = assertOwnedDocumentWritable(doc);
  const source = cloneJson(doc.source), snapshot = record(source.tldrawSnapshot), document = record(snapshot.document), store = record(document.store);
  const oldIds = new Set(original.items.map(item => item.id)), ids = new Set(doc.items.map(item => item.id));
  for (const id of oldIds) if (!ids.has(id)) delete store[id];
  if (!own(store, doc.pageId)) store[doc.pageId] = { id: doc.pageId, typeName: "page", name: "画布", index: "a1", meta: {} };
  doc.items.forEach((item, index) => {
    if (own(store, item.id) && !oldIds.has(item.id)) throw fail("新对象标识与保留记录冲突。");
    const previous = record(store[item.id]), props = { ...record(previous.props) }, meta = { ...record(previous.meta) };
    const named = item.imageNumber !== undefined || item.sourceShapeId !== undefined;
    const advanced = [2, 3].includes(props.novartVersion as number) || named || [item.hidden, item.locked, item.groupId, item.frameId, item.fontFamily, item.fontWeight, item.fontStyle,
      item.textAlign, item.lineHeight, item.crop, item.flipX, item.flipY].some(value => value !== undefined) || ["line", "arrow"].includes(item.shape ?? "");
    props.w = item.w; props.h = item.h;
    if (advanced) {
      props.novartVersion = named ? 3 : 2;
      meta.novartOwned = { version: named ? 3 : 2,
        ...(item.imageNumber !== undefined ? { imageNumber: item.imageNumber } : {}), ...(item.sourceShapeId !== undefined ? { sourceShapeId: item.sourceShapeId } : {}),
        ...(item.hidden !== undefined ? { hidden: item.hidden } : {}), ...(item.locked !== undefined ? { locked: item.locked } : {}),
        ...(item.groupId !== undefined ? { groupId: item.groupId } : {}), ...(item.frameId !== undefined ? { frameId: item.frameId } : {}) };
    }
    if (item.kind === "image") {
      props.url = item.url;
      if (item.assetId) meta.novartAssetId = item.assetId; else delete meta.novartAssetId;
      if (item.assetSha256) meta.novartAssetSha256 = item.assetSha256; else delete meta.novartAssetSha256;
      if (item.versionId) meta.novartVersionId = item.versionId; else delete meta.novartVersionId;
      if (advanced) {
        // Keep backend exact/edit guards aware of the original-image transform.
        if (item.crop !== undefined) props.cropRegion = item.crop; else delete props.cropRegion;
        if (item.flipX !== undefined) props.flipX = item.flipX; else delete props.flipX;
        if (item.flipY !== undefined) props.flipY = item.flipY; else delete props.flipY;
      }
    } else {
      props.novartVersion = advanced ? 2 : 1; props.novartKind = item.kind;
      props.novartFill = item.fill ?? (item.kind === "text" ? "#202027" : item.kind === "stroke" ? "none" : "#ede9fe");
      props.novartStroke = item.stroke ?? "#7c5cff"; props.novartStrokeWidth = item.strokeWidth ?? 2;
      if (item.kind === "shape") props.novartShape = item.shape ?? "rect";
      if (item.kind === "text") {
        props.text = item.text; props.fontSize = item.fontSize ?? 24;
        if (advanced) for (const key of ["fontFamily", "fontWeight", "fontStyle", "textAlign", "lineHeight"] as const) {
          if (item[key] !== undefined) props[key] = item[key]; else delete props[key];
        }
      }
      if (item.kind === "stroke" || (item.kind === "shape" && ["line", "arrow"].includes(item.shape ?? ""))) props.novartPoints = item.points ?? [{ x: 0, y: 0 }, { x: item.w, y: item.h }];
      else delete props.novartPoints;
    }
    store[item.id] = { ...previous, id: item.id, typeName: "shape",
      type: item.kind === "image" ? "c-image" : item.kind === "frame" ? "frame" : "novart-" + item.kind,
      parentId: item.parentId ?? doc.pageId, index: "a" + index.toString(36).padStart(6, "0"),
      x: item.x, y: item.y, rotation: item.rotation, opacity: item.opacity, props, meta };
  });
  const session = record(snapshot.session);
  const pageStates = Array.isArray(session.pageStates) ? session.pageStates : [];
  const patchState = (value: RecordValue) => ({ ...value, pageId: doc.pageId,
    camera: { ...record(value.camera), x: doc.camera.x / doc.camera.zoom, y: doc.camera.y / doc.camera.zoom, z: doc.camera.zoom } });
  const hadState = pageStates.some(value => isOwnedRecord(value) && value.pageId === doc.pageId);
  snapshot.session = { ...session, currentPageId: doc.pageId,
    camera: { ...record(session.camera), x: doc.camera.x, y: doc.camera.y, z: doc.camera.zoom },
    pageStates: hadState ? pageStates.map(value => isOwnedRecord(value) && value.pageId === doc.pageId ? patchState(value) : value)
      : [...pageStates, patchState({})] };
  source.novartOwnedCanvas = { ...record(source.novartOwnedCanvas), version: doc.items.some(item => record(record(store[item.id]).props).novartVersion === 3) ? 3 : doc.items.some(item => record(record(store[item.id]).props).novartVersion === 2) ? 2 : 1 };
  return source;
}

export function ownedImageName(item: Pick<OwnedCanvasItem, "kind" | "imageNumber">): string {
  return item.kind === "image" && item.imageNumber ? `图片${item.imageNumber}` : "图片";
}

/** Allocate once, preserve gaps and keep the high-water mark after deletion/undo. */
export function assignOwnedImageNames(doc: OwnedCanvasDocument, minimumSequence = 0): OwnedCanvasDocument {
  if (doc.warnings.length) return doc;
  const header = record(doc.source.novartOwnedCanvas);
  let sequence = Math.max(minimumSequence, Number(header.imageSequence) || 0, ...doc.items.map(item => item.imageNumber ?? 0));
  const used = new Set<number>(); let changed = false;
  const items = doc.items.map(item => {
    if (item.kind !== "image") return item;
    if (item.imageNumber && !used.has(item.imageNumber)) { used.add(item.imageNumber); return item; }
    if (sequence >= 1_000_000_000) throw fail("项目图片编号已达安全上限。");
    changed = true; const imageNumber = ++sequence; used.add(imageNumber); return { ...item, imageNumber };
  });
  if (!changed && header.imageSequence === sequence) return doc;
  return { ...doc, items, source: { ...doc.source, novartOwnedCanvas: { ...header, imageSequence: sequence } } };
}
