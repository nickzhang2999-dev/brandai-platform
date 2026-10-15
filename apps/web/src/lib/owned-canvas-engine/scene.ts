import type { OwnedCanvasDocument, OwnedCanvasItem } from "../owned-canvas-model";
import { getSceneFlags } from "../owned-canvas-operations";
import { getOwnedArrowBoundsPoints } from "../owned-canvas-style";
import { screenToWorld } from "./camera";

type Box = { x: number; y: number; w: number; h: number };
export type CanvasViewport = { width: number; height: number };
export type CanvasRenderEntry = { item: OwnedCanvasItem; zIndex: number };

/** Independently implemented, renderer-neutral scene derivation. No SDK/runtime dependency.
 * Item records are immutable; camera changes reuse the scene and cached bounds.
 * This remains an O(n) viewport query, deliberately not a pretend spatial index.
 */
export class OwnedCanvasScene {
  private items: OwnedCanvasItem[] | null = null;
  private boxes = new WeakMap<OwnedCanvasItem, Box>();
  private entries: CanvasRenderEntry[] = [];
  private flags = getSceneFlags([]);
  private culled: ReadonlySet<string> = new Set();

  update(items: OwnedCanvasItem[]) {
    if (items === this.items) return;
    this.items = items;
    this.flags = getSceneFlags(items);
    // Stable DOM order; document order is still the authoritative paint order.
    this.entries = items.map((item, zIndex) => ({ item, zIndex }))
      .sort((a, b) => a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0);
  }

  get renderEntries(): readonly CanvasRenderEntry[] { return this.entries; }
  get sceneFlags() { return this.flags; }

  private bounds(item: OwnedCanvasItem): Box {
    const cached = this.boxes.get(item);
    if (cached) return cached;
    const points = item.kind === "stroke" && item.points?.length ? item.points
      : item.shape === "arrow" ? getOwnedArrowBoundsPoints(item)
        : [{ x: 0, y: 0 }, { x: item.w, y: 0 }, { x: item.w, y: item.h }, { x: 0, y: item.h }];
    const cos = Math.cos(item.rotation), sin = Math.sin(item.rotation);
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const p of points) {
      const x = item.x + p.x * cos - p.y * sin, y = item.y + p.x * sin + p.y * cos;
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
    const pad = item.kind === "image" || item.kind === "text" ? 0 : (item.strokeWidth ?? 2) / 2;
    const box = { x: left - pad, y: top - pad, w: right - left + pad * 2, h: bottom - top + pad * 2 };
    this.boxes.set(item, box);
    return box;
  }

  cull(camera: OwnedCanvasDocument["camera"], viewport: CanvasViewport, protectedIds: ReadonlySet<string>): ReadonlySet<string> {
    const next = new Set<string>();
    // Unknown host size must never blank the scene during its first layout.
    if (viewport.width > 0 && viewport.height > 0) {
      // Screen-space overscan covers image names, frame labels and near-edge drags.
      const start = screenToWorld({ x: -96, y: -96 }, camera);
      const end = screenToWorld({ x: viewport.width + 96, y: viewport.height + 96 }, camera);
      for (const { item } of this.entries) {
        if (protectedIds.has(item.id)) continue;
        const box = this.bounds(item);
        if (box.x > end.x || box.x + box.w < start.x || box.y > end.y || box.y + box.h < start.y) next.add(item.id);
      }
    }
    if (next.size !== this.culled.size || [...next].some(id => !this.culled.has(id))) this.culled = next;
    return this.culled;
  }
}
