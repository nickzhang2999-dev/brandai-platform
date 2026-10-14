import { validateOwnedCanvasItems, type OwnedCanvasItem } from "./owned-canvas-model";

export type OwnedDelta = { x: number; y: number };
export type OwnedAlignment = "left" | "center" | "right" | "top" | "middle" | "bottom";
export type OwnedSnapGuide = { axis: "x" | "y"; value: number };
export type OwnedSceneFlags = { hidden: boolean; locked: boolean };
type Box = { x: number; y: number; w: number; h: number };

/** Build once per scene render/gesture. Ancestor flags are memoized in linear time. */
export function getSceneFlags(items: OwnedCanvasItem[]): Map<string, OwnedSceneFlags> {
  const byId = new Map(items.map(item => [item.id, item])), result = new Map<string, OwnedSceneFlags>();
  for (const item of items) {
    if (result.has(item.id)) continue;
    const path: OwnedCanvasItem[] = [], seen = new Set<string>(); let current: OwnedCanvasItem | undefined = item;
    let inherited: OwnedSceneFlags = { hidden: false, locked: false };
    while (current) {
      const cached = result.get(current.id);
      if (cached) { inherited = cached; break; }
      if (seen.has(current.id)) { inherited = { hidden: true, locked: true }; break; }
      seen.add(current.id); path.push(current);
      if (!current.frameId) break;
      current = byId.get(current.frameId);
      if (!current) inherited = { hidden: true, locked: true };
    }
    for (let index = path.length - 1; index >= 0; index--) {
      const node = path[index]!;
      inherited = { hidden: inherited.hidden || node.hidden === true, locked: inherited.locked || node.locked === true };
      result.set(node.id, inherited);
    }
  }
  return result;
}

function append(map: Map<string, string[]>, key: string, id: string) {
  const list = map.get(key); if (list) list.push(id); else map.set(key, [id]);
}

/** Selection closure is for scene operations. UI hit testing excludes hidden/locked records. */
export function expandSelection(items: OwnedCanvasItem[], ids: readonly string[]): string[] {
  const byId = new Map(items.map(item => [item.id, item])), groups = new Map<string, string[]>(), children = new Map<string, string[]>();
  for (const item of items) {
    if (item.groupId) append(groups, item.groupId, item.id);
    if (item.frameId) append(children, item.frameId, item.id);
  }
  const selected = new Set<string>(), expandedGroups = new Set<string>(), queue = [...ids];
  while (queue.length) {
    const id = queue.pop()!, item = byId.get(id);
    if (!item || selected.has(id)) continue;
    selected.add(id);
    if (item.groupId && !expandedGroups.has(item.groupId)) { expandedGroups.add(item.groupId); queue.push(...(groups.get(item.groupId) ?? [])); }
    if (item.kind === "frame") queue.push(...(children.get(id) ?? []));
  }
  return items.filter(item => selected.has(item.id)).map(item => item.id);
}

function editableSelection(items: OwnedCanvasItem[], ids: readonly string[]): Set<string> {
  const expanded = new Set(expandSelection(items, ids)), flags = getSceneFlags(items);
  // A locked descendant freezes its whole moving unit, never a partial frame/group.
  return items.some(item => expanded.has(item.id) && flags.get(item.id)?.locked) ? new Set() : expanded;
}

/** Convenience for a single lookup; bulk callers should reuse getSceneFlags. */
export const isItemHidden = (items: OwnedCanvasItem[], id: string) => getSceneFlags(items).get(id)?.hidden ?? true;
export const isItemLocked = (items: OwnedCanvasItem[], id: string) => getSceneFlags(items).get(id)?.locked ?? true;

function mint(prefix: "shape" | "group", seed: string, taken: Set<string>) {
  const base = seed.replace(/^[^:]+:/, "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 108) || "item";
  let count = 1, id = `${prefix}:${base}_copy`;
  while (taken.has(id)) id = `${prefix}:${base}_copy${++count}`;
  taken.add(id); return id;
}

/** Duplicates reuse persisted asset identity and perform no upload or other side effect. */
export function duplicateItems(items: OwnedCanvasItem[], ids: readonly string[], offset: OwnedDelta = { x: 24, y: 24 }) {
  if (![offset.x, offset.y].every(Number.isFinite)) throw new Error("复制偏移无效。");
  const selected = new Set(expandSelection(items, ids)), source = items.filter(item => selected.has(item.id));
  const takenIds = new Set(items.map(item => item.id)), takenGroups = new Set(items.flatMap(item => item.groupId ? [item.groupId] : []));
  const idMap = new Map(source.map(item => [item.id, mint("shape", item.id, takenIds)])), groupMap = new Map<string, string>();
  for (const item of source) if (item.groupId && !groupMap.has(item.groupId)) groupMap.set(item.groupId, mint("group", item.groupId, takenGroups));
  const copies = source.map(item => ({ ...item, id: idMap.get(item.id)!, x: item.x + offset.x, y: item.y + offset.y,
    ...(item.kind === "image" ? { imageNumber: undefined, sourceShapeId: item.id } : {}),
    ...(item.points ? { points: item.points.map(point => ({ ...point })) } : {}), ...(item.crop ? { crop: { ...item.crop } } : {}),
    ...(item.locked !== undefined ? { locked: false } : {}),
    ...(item.groupId ? { groupId: groupMap.get(item.groupId)! } : {}),
    ...(item.frameId ? { frameId: idMap.get(item.frameId) ?? item.frameId } : {}) }));
  const result = [...items, ...copies]; validateOwnedCanvasItems(result);
  return { items: result, selectedIds: copies.map(item => item.id) };
}

/** Groups are flat sibling sets; a frame's descendants remain attached to their frame. */
export function groupItems(items: OwnedCanvasItem[], ids: readonly string[]): { items: OwnedCanvasItem[]; selectedIds: string[]; groupId: string | null } {
  const selected = editableSelection(items, ids), byId = new Map(items.map(item => [item.id, item]));
  const roots = items.filter(item => selected.has(item.id) && !hasSelectedAncestor(item, selected, byId));
  if (roots.length < 2) return { items, selectedIds: [...selected], groupId: null };
  if (roots.some(item => item.frameId !== roots[0]!.frameId)) throw new Error("请先把对象放到同一个画框或画布，再分组。");
  const id = mint("group", "selection", new Set(items.flatMap(item => item.groupId ? [item.groupId] : []))), rootIds = new Set(roots.map(item => item.id));
  const result = items.map(item => rootIds.has(item.id) ? { ...item, groupId: id } : item);
  validateOwnedCanvasItems(result); return { items: result, selectedIds: expandSelection(result, roots.map(item => item.id)), groupId: id };
}

export function ungroupItems(items: OwnedCanvasItem[], ids: readonly string[]): OwnedCanvasItem[] {
  const selected = editableSelection(items, ids), groups = new Set(items.filter(item => selected.has(item.id) && item.groupId).map(item => item.groupId));
  return items.map(item => {
    if (!item.groupId || !groups.has(item.groupId)) return item;
    const { groupId: _group, ...rest } = item; return rest;
  });
}

export function moveItems(items: OwnedCanvasItem[], ids: readonly string[], delta: OwnedDelta): OwnedCanvasItem[] {
  if (![delta.x, delta.y].every(Number.isFinite)) throw new Error("移动距离无效。");
  const selected = editableSelection(items, ids);
  if (!selected.size || (!delta.x && !delta.y)) return items;
  const result = items.map(item => selected.has(item.id) ? { ...item, x: item.x + delta.x, y: item.y + delta.y } : item);
  validateOwnedCanvasItems(result); return result;
}

function hasSelectedAncestor(item: OwnedCanvasItem, selected: Set<string>, byId: Map<string, OwnedCanvasItem>) {
  const seen = new Set<string>(); let frameId = item.frameId;
  while (frameId && !seen.has(frameId)) {
    if (selected.has(frameId)) return true;
    seen.add(frameId); frameId = byId.get(frameId)?.frameId;
  }
  return false;
}

function itemBox(item: OwnedCanvasItem): Box {
  const c = Math.cos(item.rotation), s = Math.sin(item.rotation);
  const points = [{ x: 0, y: 0 }, { x: item.w, y: 0 }, { x: item.w, y: item.h }, { x: 0, y: item.h }]
    .map(point => ({ x: item.x + point.x * c - point.y * s, y: item.y + point.x * s + point.y * c }));
  const x = Math.min(...points.map(point => point.x)), y = Math.min(...points.map(point => point.y));
  return { x, y, w: Math.max(...points.map(point => point.x)) - x, h: Math.max(...points.map(point => point.y)) - y };
}
function unionBoxes(boxes: Box[]): Box {
  const x = Math.min(...boxes.map(box => box.x)), y = Math.min(...boxes.map(box => box.y));
  return { x, y, w: Math.max(...boxes.map(box => box.x + box.w)) - x, h: Math.max(...boxes.map(box => box.y + box.h)) - y };
}
function selectionUnits(items: OwnedCanvasItem[], ids: readonly string[]) {
  const selected = editableSelection(items, ids), byId = new Map(items.map(item => [item.id, item])), sets = new Map<string, string[]>();
  for (const item of items) {
    if (!selected.has(item.id) || hasSelectedAncestor(item, selected, byId)) continue;
    append(sets, item.groupId ?? item.id, item.id);
  }
  return [...sets.values()].map(roots => {
    const members = new Set(expandSelection(items, roots));
    // Align a selected frame by its own bounds while translating all descendants.
    return { ids: members, box: unionBoxes(roots.map(id => itemBox(byId.get(id)!))) };
  });
}

export function alignItems(items: OwnedCanvasItem[], ids: readonly string[], alignment: OwnedAlignment): OwnedCanvasItem[] {
  const units = selectionUnits(items, ids); if (units.length < 2) return items;
  const box = unionBoxes(units.map(unit => unit.box)), horizontal = ["left", "center", "right"].includes(alignment);
  const shifts = new Map<string, OwnedDelta>();
  for (const unit of units) {
    const delta = alignment === "left" ? box.x - unit.box.x : alignment === "center" ? box.x + box.w / 2 - unit.box.x - unit.box.w / 2
      : alignment === "right" ? box.x + box.w - unit.box.x - unit.box.w : alignment === "top" ? box.y - unit.box.y
        : alignment === "middle" ? box.y + box.h / 2 - unit.box.y - unit.box.h / 2 : box.y + box.h - unit.box.y - unit.box.h;
    for (const id of unit.ids) shifts.set(id, horizontal ? { x: delta, y: 0 } : { x: 0, y: delta });
  }
  const result = items.map(item => shifts.has(item.id) ? { ...item, x: item.x + shifts.get(item.id)!.x, y: item.y + shifts.get(item.id)!.y } : item);
  validateOwnedCanvasItems(result); return result;
}

/** Equal gaps between visual bounding boxes, with both outer units fixed. */
export function distributeItems(items: OwnedCanvasItem[], ids: readonly string[], axis: "horizontal" | "vertical"): OwnedCanvasItem[] {
  const horizontal = axis === "horizontal", position = horizontal ? "x" : "y", size = horizontal ? "w" : "h";
  const units = selectionUnits(items, ids).sort((a, b) => a.box[position] - b.box[position]); if (units.length < 3) return items;
  const first = units[0]!, last = units[units.length - 1]!, span = last.box[position] + last.box[size] - first.box[position];
  const gap = (span - units.reduce((sum, unit) => sum + unit.box[size], 0)) / (units.length - 1), shifts = new Map<string, number>();
  let cursor = first.box[position];
  units.forEach((unit, index) => { if (index > 0 && index < units.length - 1) for (const id of unit.ids) shifts.set(id, cursor - unit.box[position]); cursor += unit.box[size] + gap; });
  const result = items.map(item => shifts.has(item.id) ? { ...item, [position]: item[position] + shifts.get(item.id)! } : item);
  validateOwnedCanvasItems(result); return result;
}

/** Changes membership only: moving into/out of a frame never changes world coordinates. */
export function attachItemsToFrame(items: OwnedCanvasItem[], ids: readonly string[], frameId: string | null): OwnedCanvasItem[] {
  const selected = editableSelection(items, ids), byId = new Map(items.map(item => [item.id, item]));
  if (!selected.size) return items;
  if (frameId !== null && (!byId.has(frameId) || byId.get(frameId)!.kind !== "frame" || selected.has(frameId))) throw new Error("目标画框无效，不能把画框放进自己。");
  if (frameId !== null && isItemLocked(items, frameId)) return items;
  const result = items.map(item => {
    if (!selected.has(item.id) || hasSelectedAncestor(item, selected, byId)) return item;
    const { frameId: _frame, ...rest } = item; return frameId === null ? rest : { ...rest, frameId };
  });
  validateOwnedCanvasItems(result); return result;
}

export function reorderItems(items: OwnedCanvasItem[], ids: readonly string[], direction: "front" | "back" | "forward" | "backward"): OwnedCanvasItem[] {
  const selected = editableSelection(items, ids); if (!selected.size) return items;
  if (direction === "front") return [...items.filter(item => !selected.has(item.id)), ...items.filter(item => selected.has(item.id))];
  if (direction === "back") return [...items.filter(item => selected.has(item.id)), ...items.filter(item => !selected.has(item.id))];
  const result = [...items];
  if (direction === "forward") {
    for (let n = result.length - 2; n >= 0; n--) if (selected.has(result[n]!.id) && !selected.has(result[n + 1]!.id)) [result[n], result[n + 1]] = [result[n + 1]!, result[n]!];
  } else {
    for (let n = 1; n < result.length; n++) if (selected.has(result[n]!.id) && !selected.has(result[n - 1]!.id)) [result[n], result[n - 1]] = [result[n - 1]!, result[n]!];
  }
  return result;
}

export function deleteItems(items: OwnedCanvasItem[], ids: readonly string[]): OwnedCanvasItem[] {
  const selected = editableSelection(items, ids); if (!selected.size) return items;
  const result = items.filter(item => !selected.has(item.id)), counts = new Map<string, number>();
  for (const item of result) if (item.groupId) counts.set(item.groupId, (counts.get(item.groupId) ?? 0) + 1);
  return result.map(item => {
    if (!item.groupId || (counts.get(item.groupId) ?? 0) >= 2) return item;
    const { groupId: _group, ...rest } = item; return rest;
  });
}

/** Snaps the moving selection's visual edges/centers and returns world-space guides. */
export function getMoveSnap(items: OwnedCanvasItem[], ids: readonly string[], delta: OwnedDelta, options: { grid?: number; threshold?: number } = {}): { delta: OwnedDelta; guides: OwnedSnapGuide[] } {
  const selected = editableSelection(items, ids), moving = items.filter(item => selected.has(item.id));
  if (!moving.length) return { delta, guides: [] };
  const threshold = options.threshold ?? 6, grid = options.grid ?? 0;
  if (![delta.x, delta.y, threshold, grid].every(Number.isFinite) || threshold < 0 || grid < 0) throw new Error("吸附设置无效。");
  const box = unionBoxes(moving.map(itemBox)), guides: OwnedSnapGuide[] = [], result = { ...delta };
  const flags = getSceneFlags(items), targets = items.filter(item => !selected.has(item.id) && !flags.get(item.id)?.hidden).map(itemBox);
  for (const axis of ["x", "y"] as const) {
    const size = axis === "x" ? "w" : "h", edges = [box[axis] + delta[axis], box[axis] + delta[axis] + box[size] / 2, box[axis] + delta[axis] + box[size]];
    let distance = threshold + 1, adjustment = 0, guide: number | undefined;
    for (const target of targets) for (const value of [target[axis], target[axis] + target[size] / 2, target[axis] + target[size]]) for (const edge of edges) {
      const difference = value - edge;
      if (Math.abs(difference) <= threshold && Math.abs(difference) < distance) { distance = Math.abs(difference); adjustment = difference; guide = value; }
    }
    if (guide !== undefined) { result[axis] += adjustment; guides.push({ axis, value: guide }); }
    else if (grid > 0) result[axis] = Math.round((box[axis] + delta[axis]) / grid) * grid - box[axis];
  }
  return { delta: result, guides };
}
