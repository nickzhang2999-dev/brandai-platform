import type { OwnedCanvasDocument } from "../../lib/owned-canvas-model";
import { bounds } from "./geometry";

/** World-coordinate placement. A panned viewport never changes ordering. */
export function nextOwnedImagePosition(document: OwnedCanvasDocument, width: number, height: number, sourceId?: string) {
  const items = document.items.filter(item => !item.hidden);
  const source = items.find(item => item.id === sourceId);
  const all = bounds(items);
  let x = all?.x ?? 0, y = all ? all.y + all.h + 48 : 0;
  if (source) {
    const box = bounds([source])!;
    x = box.x + box.w + 48; y = box.y;
    // Multiple variants form a row to the right of their source. Skip occupied
    // rectangles, including rotated objects, without changing existing objects.
    for (let i = 0; i <= items.length; i++) {
      const collision = items.map(item => bounds([item])!).find(box => x < box.x + box.w + 48 && x + width + 48 > box.x && y < box.y + box.h + 48 && y + height + 48 > box.y);
      if (!collision) break;
      x = collision.x + collision.w + 48;
    }
  }
  return { x: x + width / 2, y: y + height / 2 };
}
