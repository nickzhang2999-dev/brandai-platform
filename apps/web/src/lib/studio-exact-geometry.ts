import { AssetUsageInput, ExactAssetTransform } from "@brandai/contracts";
import { ApiException } from "./api";

/** Native affine layout [a,b,c,d,e,f], acting on column vectors (x,y,1). */
export type StudioExactMatrix = [number, number, number, number, number, number];
export type StudioExactReference = { shapeId: string; assetId: string; sha256: string; width: number; height: number };
export type StudioExactLayoutInput = { store: unknown; outputFrameId: string; outputWidth: number; outputHeight: number; references: StudioExactReference[] };
export type StudioExactLayer = StudioExactReference & {
  displayWidth: number; displayHeight: number;
  relativeTransform: StudioExactMatrix;
  transform: ExactAssetTransform;
};
export type StudioExactLayout = {
  target: { width: number; height: number };
  frame: { shapeId: string; width: number; height: number; pageId: string; pageTransform: StudioExactMatrix };
  layers: StudioExactLayer[];
  assetUsages: AssetUsageInput[];
};

type ObjectValue = Record<string, unknown>;
type Shape = { id: string; type: string; parentId: string; index: string; x: number; y: number; rotation: number; props: ObjectValue };
type Point = { x: number; y: number };
const IDENTITY: StudioExactMatrix = [1, 0, 0, 1, 0, 0];
const ADJUST_KEYS = new Set(["light", "exposure", "contrast", "highlights", "shadows", "whites", "blacks", "vibrance", "saturation", "temperature", "tint", "sharpen", "clarity", "grain", "vignette", "glamour", "bloom"]);
const fail = (message: string): never => { throw new ApiException(422, message); };
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const clean = (value: number) => Math.abs(value) < 1e-12 ? 0 : value;

function positive(value: unknown, message: string): number {
  if (!finite(value) || value < 1e-6 || value > 1e9) return fail(message);
  return value;
}
function sourceSize(width: unknown, height: unknown) {
  if (!finite(width) || !finite(height) || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > 16384 || height > 16384 || width * height > 40_000_000) fail("图片的权威尺寸或输出尺寸无效，请重新读取素材后提交。");
}
function optionalFlag(value: unknown): boolean {
  if (value !== undefined && typeof value !== "boolean") return fail("画布翻转参数无效，请重新保存画布。");
  return value === true;
}

function multiply(left: StudioExactMatrix, right: StudioExactMatrix): StudioExactMatrix {
  const [a, b, c, d, e, f] = left, [g, h, i, j, k, l] = right;
  return [a * g + c * h, b * g + d * h, a * i + c * j, b * i + d * j, a * k + c * l + e, b * k + d * l + f];
}
function inverse(matrix: StudioExactMatrix): StudioExactMatrix {
  const [a, b, c, d, e, f] = matrix, determinant = a * d - b * c;
  if (!finite(determinant) || Math.abs(determinant) < 1e-12) return fail("输出区域的变换不可逆，请重新创建输出区域。");
  return [d / determinant, -b / determinant, -c / determinant, a / determinant, (c * f - d * e) / determinant, (b * e - a * f) / determinant];
}
function point(matrix: StudioExactMatrix, x: number, y: number): Point {
  return { x: matrix[0] * x + matrix[2] * y + matrix[4], y: matrix[1] * x + matrix[3] * y + matrix[5] };
}
function local(shape: Shape): StudioExactMatrix {
  const cos = Math.cos(shape.rotation), sin = Math.sin(shape.rotation);
  return [cos, sin, -sin, cos, shape.x, shape.y];
}

/** Captured 1773.fe2335a6 module 45995: adjust fields are optional zero
 * deltas, cropRegion={x,y,w,h}; the captured processor treats a full crop
 * within 1e-6 as inactive. Never map native crop dimensions to ExactAssetCrop. */
function noImageProcessing(props: ObjectValue) {
  if (props.adjust !== undefined) {
    if (!object(props.adjust) || Object.entries(props.adjust).some(([key, value]) => !ADJUST_KEYS.has(key) || !finite(value) || value !== 0)) fail("严格保留暂不支持调色或滤镜，请先重置图片调整。");
  }
  if (props.cropRegion !== undefined) {
    const crop = props.cropRegion;
    if (!object(crop) || Object.keys(crop).some(key => !["x", "y", "w", "h"].includes(key)) ||
      !finite(crop.x) || !finite(crop.y) || !finite(crop.w) || !finite(crop.h) ||
      Math.abs(crop.x) > 1e-6 || Math.abs(crop.y) > 1e-6 || Math.abs(crop.w - 1) > 1e-6 || Math.abs(crop.h - 1) > 1e-6) fail("严格保留暂不支持裁切图片，请先重置裁切。");
  }
  if (props.radius !== undefined && (!finite(props.radius) || props.radius !== 0)) fail("严格保留暂不支持圆角裁剪，请将图片或输出区域圆角设为0。");
}

function visibleUnscaled(record: ObjectValue, props: ObjectValue) {
  // Captured shape rendering uses the native top-level opacity. The custom
  // frame can also be temporarily hidden with meta.agentHiddenUntilFit.
  if (record.opacity !== undefined && record.opacity !== 1) fail("严格保留暂不支持隐藏或半透明图层，请恢复图片和父级容器的不透明度。");
  if (props.opacity !== undefined && props.opacity !== 1) fail("严格保留暂不支持额外透明度。");
  const meta = object(record.meta) ? record.meta : {};
  if (meta.agentHiddenUntilFit === true || meta.isUploading === true) fail("图片或容器尚未完成加载，请等待完成后重新保存画布。");
  for (const value of [record, props, meta]) {
    if ((value.hidden !== undefined && value.hidden !== false) || (value.isHidden !== undefined && value.isHidden !== false) ||
      (value.visible !== undefined && value.visible !== true) || (value.visibility !== undefined && value.visibility !== "visible")) fail("严格保留不接受隐藏或可见性状态不明的图层。");
  }
  for (const value of [record, props]) {
    // Native tldraw local matrices contain translation and rotation only;
    // group resizing is baked into child x/y/w/h. A separate scale/skew is
    // not part of the captured c-image/group/frame model, so never ignore it.
    if (["scale", "scaleX", "scaleY", "skewX", "skewY", "transform", "matrix"].some(key => value[key] !== undefined)) fail("严格保留暂不支持额外缩放或倾斜矩阵，请整理图层后重试。");
    if (["clip", "clipPath", "mask", "crop", "clipContent", "clipChildren"].some(key => value[key] !== undefined && value[key] !== false && value[key] !== null)) fail("严格保留暂不支持额外蒙版或容器裁剪。");
  }
}

function readShape(store: ObjectValue, id: string): Shape {
  const value = Object.prototype.hasOwnProperty.call(store, id) ? store[id] : undefined;
  if (!object(value) || value.typeName !== "shape" || value.id !== id || !object(value.props) || typeof value.type !== "string" ||
    typeof value.parentId !== "string" || !value.parentId || typeof value.index !== "string" || !/^[A-Za-z][A-Za-z0-9]{0,255}$/.test(value.index) ||
    !finite(value.x) || !finite(value.y) || Math.abs(value.x) > 1e9 || Math.abs(value.y) > 1e9 || !finite(value.rotation) || Math.abs(value.rotation) > 1e6) return fail("画布图层的坐标、父级或排序数据无效，请重新保存画布。");
  visibleUnscaled(value, value.props);
  return value as unknown as Shape;
}

function ancestors(store: ObjectValue, id: string) {
  const path: Shape[] = [], visited = new Set<string>();
  let current = id;
  while (!current.startsWith("page:")) {
    if (visited.has(current) || path.length >= 128) return fail("画布父级存在循环或嵌套过深，请整理图层后重试。");
    visited.add(current);
    const shape = readShape(store, current);
    if (path.length && shape.type !== "group" && shape.type !== "frame") return fail("严格保留暂不支持这种父级容器，请将图片移到普通分组或画框中。");
    if (shape.type === "group" || shape.type === "frame") {
      noImageProcessing(shape.props);
      if (optionalFlag(shape.props.flipX) || optionalFlag(shape.props.flipY)) return fail("严格保留暂不支持父级容器翻转，请先取消容器翻转。");
      if (shape.type === "frame") { positive(shape.props.w, "父级画框宽度无效。"); positive(shape.props.h, "父级画框高度无效。"); }
    }
    path.push(shape); current = shape.parentId;
  }
  const page = Object.prototype.hasOwnProperty.call(store, current) ? store[current] : undefined;
  if (!object(page) || page.id !== current || page.typeName !== "page") return fail("图片所在的画布页面不存在，请重新保存画布。");
  path.reverse();
  let matrix: StudioExactMatrix = [...IDENTITY];
  for (const shape of path) matrix = multiply(matrix, local(shape));
  if (matrix.some(value => !finite(value))) return fail("画布坐标超出可计算范围，请调整布局后重试。");
  return { pageId: current, path, matrix };
}

/** Positive-area polygon intersection, not an axis-aligned bounding-box test:
 * a rotated image can have a bounding box over a frame while wholly outside. */
function hasVisibleArea(corners: Point[], width: number, height: number) {
  let polygon = corners.map(corner => ({ x: corner.x / width, y: corner.y / height }));
  for (const [axis, boundary, sign] of [["x", 0, 1], ["x", 1, -1], ["y", 0, 1], ["y", 1, -1]] as const) {
    const next: Point[] = [];
    for (let index = 0; index < polygon.length; index++) {
      const from = polygon[index]!, to = polygon[(index + 1) % polygon.length]!;
      const fromInside = sign * (from[axis] - boundary) >= 0, toInside = sign * (to[axis] - boundary) >= 0;
      if (fromInside) next.push(from);
      if (fromInside !== toInside) {
        const ratio = (boundary - from[axis]) / (to[axis] - from[axis]);
        next.push({ x: from.x + ratio * (to.x - from.x), y: from.y + ratio * (to.y - from.y) });
      }
    }
    polygon = next;
    if (polygon.length < 3) return false;
  }
  const origin = polygon[0]!;
  let twiceArea = 0;
  for (let index = 1; index + 1 < polygon.length; index++) {
    const a = polygon[index]!, b = polygon[index + 1]!;
    twiceArea += (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
  }
  return Math.abs(twiceArea) > 1e-12;
}

function comparePaths(left: Shape[], right: Shape[]) {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const a = left[index]!, b = right[index]!;
    if (a.id === b.id) continue;
    if (a.index === b.index) return fail("画布同级图层排序重复，无法确定严格保留的叠放顺序，请整理图层后重试。");
    return a.index < b.index ? -1 : 1;
  }
  return left.length - right.length;
}

function rasterWithinLimits(targetWidth: number, reference: Pick<StudioExactReference, "width" | "height">, transform: ExactAssetTransform) {
  const width = Math.max(1, Math.round(targetWidth * transform.widthRatio));
  const height = Math.max(1, Math.round(width * reference.height / reference.width));
  const degrees = ((transform.rotationDeg % 360) + 360) % 360, quarter = degrees % 90 === 0;
  const radians = degrees * Math.PI / 180;
  const cos = Math.abs(Math.cos(radians)), sin = Math.abs(Math.sin(radians));
  const rotatedWidth = quarter ? (degrees % 180 === 0 ? width : height) : Math.ceil(width * cos + height * sin) + 2;
  const rotatedHeight = quarter ? (degrees % 180 === 0 ? height : width) : Math.ceil(width * sin + height * cos) + 2;
  if ([width, height, rotatedWidth, rotatedHeight].some(dimension => !finite(dimension) || dimension > 16384) || width * height > 40_000_000 || rotatedWidth * rotatedHeight > 40_000_000) fail("严格保留图层在当前输出尺寸下过大，请缩小图片或降低输出分辨率。");
}

/** Shared by initial document derivation and persisted-snapshot preflight.
 * These bounds concern all decoded sources plus the target, even when an
 * oversized source would eventually be displayed as a small thumbnail. */
export function assertStudioExactRasterBudget(target: { width: number; height: number }, layers: ReadonlyArray<Pick<StudioExactLayer, "width" | "height" | "transform">>): void {
  sourceSize(target?.width, target?.height);
  if (!Array.isArray(layers) || layers.length > 100) return fail("严格保留图层数量无效。");
  let pixels = target.width * target.height;
  for (const layer of layers) {
    sourceSize(layer?.width, layer?.height);
    const transform = ExactAssetTransform.safeParse(layer?.transform);
    if (!transform.success) return fail("严格保留图层的变换快照无效，请重新选择图片后提交。");
    pixels += layer.width * layer.height;
    if (pixels > 40_000_000) return fail("本次输出和严格保留源图片合计超过4000万像素，请减少素材或降低图片分辨率。");
    rasterWithinLimits(target.width, layer, transform.data);
  }
}

/** Derive only from the saved native document plus server-owned source metadata.
 * Captured lib-tldraw getShapeLocalTransform = T(x,y)·R(rotation), around the
 * local origin (NOT the box center); parent matrices compose root-to-leaf.
 * Captured custom FrameShapeUtil.getClipPath is empty: normal frames do not
 * silently crop descendants. Only the explicit output rectangle clips here. */
export function deriveStudioExactLayout(input: StudioExactLayoutInput): StudioExactLayout {
  if (!object(input.store) || typeof input.outputFrameId !== "string" || !input.outputFrameId || !Array.isArray(input.references) || input.references.length < 1 || input.references.length > 100) return fail("请选择一个输出画框和1至100张严格保留图片。");
  const store = input.store;
  sourceSize(input.outputWidth, input.outputHeight);
  const frameShape = readShape(store, input.outputFrameId);
  if (frameShape.type !== "frame") return fail("输出区域必须是已保存的画框，请先选择一个画框。");
  const framePath = ancestors(store, frameShape.id);
  const width = positive(frameShape.props.w, "输出画框宽度无效。"), height = positive(frameShape.props.h, "输出画框高度无效。");
  // One common scale must fit BOTH actual dimensions within pixel rounding. This
  // admits only <=0.5 output-pixel rounding, not arbitrary aspect distortion.
  const lowerScale = Math.max((input.outputWidth - 0.5) / width, (input.outputHeight - 0.5) / height);
  const upperScale = Math.min((input.outputWidth + 0.5) / width, (input.outputHeight + 0.5) / height);
  if (lowerScale > upperScale + Number.EPSILON * Math.max(1, Math.abs(upperScale)) * 8) return fail("输出比例与所选画框不一致，请调整输出尺寸或画框比例。");
  const frameInverse = inverse(framePath.matrix), shapeIds = new Set<string>(), assetIds = new Set<string>();
  const entries = input.references.map(reference => {
    if (!reference || typeof reference.shapeId !== "string" || !reference.shapeId || typeof reference.assetId !== "string" || !reference.assetId || typeof reference.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(reference.sha256)) return fail("严格保留图片的权威素材关联或内容摘要无效。");
    if (shapeIds.has(reference.shapeId) || assetIds.has(reference.assetId)) return fail("同一素材暂不能重复作为多个严格保留图层，请每个素材只选择一次。");
    shapeIds.add(reference.shapeId); assetIds.add(reference.assetId); sourceSize(reference.width, reference.height);
    const shape = readShape(store, reference.shapeId);
    if (shape.type !== "c-image") return fail("严格保留仅支持已入库的静态图片，请重新选择图片素材。");
    noImageProcessing(shape.props);
    const displayWidth = positive(shape.props.w, "图片显示宽度无效。"), displayHeight = positive(shape.props.h, "图片显示高度无效。");
    const aspect = reference.width / reference.height;
    if (Math.abs(displayWidth / displayHeight / aspect - 1) > 1e-6) return fail("严格保留暂不支持非等比拉伸，请恢复图片原始宽高比。");
    const flipX = optionalFlag(shape.props.flipX), flipY = optionalFlag(shape.props.flipY);
    const imagePath = ancestors(store, shape.id);
    if (imagePath.pageId !== framePath.pageId) return fail("严格保留图片与输出画框不在同一页面，请调整选择。");
    const relativeTransform = multiply(frameInverse, imagePath.matrix).map(clean) as StudioExactMatrix;
    const center = point(relativeTransform, displayWidth / 2, displayHeight / 2);
    const corners = [point(relativeTransform, 0, 0), point(relativeTransform, displayWidth, 0), point(relativeTransform, displayWidth, displayHeight), point(relativeTransform, 0, displayHeight)];
    if (!hasVisibleArea(corners, width, height)) return fail("严格保留图片完全位于输出区域之外，请将图片移入输出画框。");
    // Around the SAME center: FY = R(180deg)·FX. Hence an absent native flipY
    // maps directly; an enabled flipY adds 180deg and toggles the EXACT flipX.
    const degrees = Math.atan2(relativeTransform[1], relativeTransform[0]) * 180 / Math.PI + (flipY ? 180 : 0);
    const transform = ExactAssetTransform.safeParse({ xRatio: center.x / width, yRatio: center.y / height, widthRatio: displayWidth / width,
      rotationDeg: clean(((degrees + 180) % 360 + 360) % 360 - 180), flipX: flipX !== flipY,
      crop: { left: 0, top: 0, right: 0, bottom: 0 }, zIndex: 0 });
    if (!transform.success) return fail("图片的中心或大小超出严格保留支持范围，请缩小图片或移近输出画框。");
    const layer: StudioExactLayer = { shapeId: reference.shapeId, assetId: reference.assetId, sha256: reference.sha256, width: reference.width, height: reference.height, displayWidth, displayHeight, relativeTransform, transform: transform.data };
    return { layer, path: imagePath.path };
  });
  entries.sort((left, right) => comparePaths(left.path, right.path));
  const layers = entries.map(({ layer }, index) => ({ ...layer, transform: { ...layer.transform, zIndex: index } }));
  assertStudioExactRasterBudget({ width: input.outputWidth, height: input.outputHeight }, layers);
  const assetUsages = layers.map((layer, order) => AssetUsageInput.parse({ assetId: layer.assetId, mode: "EXACT", order, exactTransform: layer.transform }));
  return { target: { width: input.outputWidth, height: input.outputHeight }, frame: { shapeId: frameShape.id, width, height, pageId: framePath.pageId, pageTransform: framePath.matrix.map(clean) as StudioExactMatrix }, layers, assetUsages };
}
