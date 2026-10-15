import type { OwnedCanvasDocument, OwnedCanvasItem } from "../owned-canvas-model";
import { applyEdit, createEdit, type CanvasEdit } from "./geometry";

const DEFAULT_HISTORY_LIMIT = 60;
const MAX_HISTORY_LIMIT = 200;

function copyItem(item: OwnedCanvasItem | undefined): OwnedCanvasItem | undefined {
  if (!item) return undefined;
  return {
    ...item,
    ...(item.points ? { points: item.points.map(point => ({ ...point })) } : {}),
    ...(item.crop ? { crop: { ...item.crop } } : {}),
  };
}

function copyEdit(edit: CanvasEdit): CanvasEdit {
  return {
    changes: edit.changes.map(change => ({ id: change.id, before: copyItem(change.before), after: copyItem(change.after) })),
    beforeOrder: [...edit.beforeOrder],
    afterOrder: [...edit.afterOrder],
  };
}

/**
 * Bounded, scene-delta history for the owned editor. Camera, metadata and later
 * uploads remain authoritative on the current document passed to undo/redo.
 * Call clear() when switching projects/pages; history is never persisted.
 */
export class OwnedCanvasHistory {
  private past: CanvasEdit[] = [];
  private future: CanvasEdit[] = [];

  constructor(private readonly limit = DEFAULT_HISTORY_LIMIT) {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT) {
      throw new RangeError(`Canvas history limit must be an integer between 1 and ${MAX_HISTORY_LIMIT}.`);
    }
  }

  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }

  record(before: OwnedCanvasDocument, after: OwnedCanvasDocument): boolean {
    const edit = createEdit(before, after);
    if (!edit) return false;
    // Copy only changed shapes: a later gesture must not mutate stored points/crop.
    this.past.push(copyEdit(edit));
    if (this.past.length > this.limit) this.past.splice(0, this.past.length - this.limit);
    this.future = [];
    return true;
  }

  undo(document: OwnedCanvasDocument): OwnedCanvasDocument | null {
    const edit = this.past.pop();
    if (!edit) return null;
    this.future.push(edit);
    return applyEdit(document, copyEdit(edit), "before");
  }

  redo(document: OwnedCanvasDocument): OwnedCanvasDocument | null {
    const edit = this.future.pop();
    if (!edit) return null;
    this.past.push(edit);
    return applyEdit(document, copyEdit(edit), "after");
  }

  clear(): void {
    this.past = [];
    this.future = [];
  }
}
