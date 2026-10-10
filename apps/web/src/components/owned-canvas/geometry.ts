import type { OwnedCanvasDocument, OwnedCanvasItem } from "@/lib/owned-canvas-model";

export type Point = { x: number; y: number };
export type Bounds = Point & { w: number; h: number };
export type Corner = "nw" | "ne" | "sw" | "se";
export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export const rotate = (point: Point, angle: number): Point => ({ x: point.x * Math.cos(angle) - point.y * Math.sin(angle), y: point.x * Math.sin(angle) + point.y * Math.cos(angle) });
export const center = (box: Bounds): Point => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 });
export function itemCenter(item: OwnedCanvasItem): Point { const p = rotate({ x: item.w / 2, y: item.h / 2 }, item.rotation); return { x: item.x + p.x, y: item.y + p.y }; }
export function corners(item: OwnedCanvasItem): Point[] {
  return ([[0, 0], [item.w, 0], [item.w, item.h], [0, item.h]] as [number, number][]).map(([x, y]) => {
    const point = rotate({ x, y }, item.rotation);
    return { x: item.x + point.x, y: item.y + point.y };
  });
}
export function bounds(items: OwnedCanvasItem[]): Bounds | null {
  if (!items.length) return null;
  const points = items.flatMap(corners), xs = points.map(p => p.x), ys = points.map(p => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
export function intersects(a: Bounds, b: Bounds) { return a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y; }
export function boxBetween(a: Point, b: Point): Bounds { return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }; }
export function resize(item: OwnedCanvasItem, corner: Corner, point: Point, aspect: boolean): OwnedCanvasItem {
  const sx = corner.includes("w") ? -1 : 1, sy = corner.includes("n") ? -1 : 1;
  const offset = rotate({ x: sx < 0 ? item.w : 0, y: sy < 0 ? item.h : 0 }, item.rotation);
  const fixed = { x: item.x + offset.x, y: item.y + offset.y };
  const local = rotate({ x: point.x - fixed.x, y: point.y - fixed.y }, -item.rotation);
  let w = Math.max(8, sx * local.x), h = Math.max(8, sy * local.y);
  if (aspect) { const scale = Math.max(w / item.w, h / item.h); w = item.w * scale; h = item.h * scale; }
  const nextOffset = rotate({ x: sx < 0 ? w : 0, y: sy < 0 ? h : 0 }, item.rotation);
  const points = item.points?.map(p => ({ x: p.x * w / item.w, y: p.y * h / item.h }));
  return { ...item, x: fixed.x - nextOffset.x, y: fixed.y - nextOffset.y, w, h, ...(points ? { points } : {}) };
}
export function resizeMany(items: OwnedCanvasItem[], original: Bounds, corner: Corner, point: Point): OwnedCanvasItem[] {
  const fixed = { x: corner.includes("w") ? original.x + original.w : original.x, y: corner.includes("n") ? original.y + original.h : original.y };
  const sx = corner.includes("w") ? -1 : 1, sy = corner.includes("n") ? -1 : 1;
  // Uniform scaling preserves each rotated object instead of introducing skew.
  const scale = Math.max(0.02, sx * (point.x - fixed.x) / Math.max(original.w, 1), sy * (point.y - fixed.y) / Math.max(original.h, 1));
  return items.map(item => ({ ...item, x: fixed.x + (item.x - fixed.x) * scale, y: fixed.y + (item.y - fixed.y) * scale, w: item.w * scale, h: item.h * scale,
    ...(item.points ? { points: item.points.map(p => ({ x: p.x * scale, y: p.y * scale })) } : {}) }));
}
export type CanvasEdit = { changes: { id: string; before?: OwnedCanvasItem; after?: OwnedCanvasItem }[]; beforeOrder: string[]; afterOrder: string[] };
export function createEdit(before: OwnedCanvasDocument, after: OwnedCanvasDocument): CanvasEdit | null {
  const old = new Map(before.items.map(item => [item.id, item])), next = new Map(after.items.map(item => [item.id, item]));
  const changes = [...new Set([...old.keys(), ...next.keys()])].filter(id => JSON.stringify(old.get(id)) !== JSON.stringify(next.get(id))).map(id => ({ id, before: old.get(id), after: next.get(id) }));
  const beforeOrder = [...old.keys()], afterOrder = [...next.keys()];
  return changes.length || beforeOrder.join("\0") !== afterOrder.join("\0") ? { changes, beforeOrder, afterOrder } : null;
}
export function applyEdit(document: OwnedCanvasDocument, edit: CanvasEdit, direction: "before" | "after"): OwnedCanvasDocument {
  const items = new Map(document.items.map(item => [item.id, item]));
  for (const change of edit.changes) { const item = change[direction]; if (item) items.set(change.id, item); else items.delete(change.id); }
  const order = direction === "before" ? edit.beforeOrder : edit.afterOrder;
  const restored = order.flatMap(id => items.has(id) ? [items.get(id)!] : []), known = new Set(order);
  // Uploads and other externally-added objects are absent from the edit delta.
  return { ...document, items: [...restored, ...[...items.values()].filter(item => !known.has(item.id))] };
}
