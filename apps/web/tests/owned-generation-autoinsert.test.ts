import { describe, expect, it } from "vitest";
import { takeReadyGenerationImages } from "../src/components/owned-canvas/owned-generation-autoinsert";
import { emptyOwnedDocument } from "../src/lib/owned-canvas-model";
import type { GenerationTask } from "../src/components/owned-canvas/owned-editor-api";

// Synthetic task views; no account, database or provider.
const image = (n: number) => ({ versionId: `v${n}`, assetId: `a${n}`, assetSha256: String(n).repeat(64).slice(0, 64), width: 1024, height: 1024, mimeType: "image/png" as const, url: `/api/workspaces/w/assets/a${n}/raw` });
const task = (requestId: string, status: string, resultState: string, results = [image(1)]) =>
  ({ requestId, status, resultState, results, mode: "generate", expiresAt: "2026-10-19T12:00:00.000Z" } as unknown as GenerationTask);

describe("automatic placement of generated images", () => {
  it("keeps a candidate retryable until insertion is acknowledged", () => {
    const watched = new Set<string>(), taken = new Set<string>();
    expect(takeReadyGenerationImages([task("r1", "RUNNING", "NOT_REQUESTED", [])], watched, taken, null)).toEqual([]);
    const first = takeReadyGenerationImages([task("r1", "SUCCEEDED", "READY")], watched, taken, null);
    expect(first).toHaveLength(1);
    expect(first[0]!.images.map(value => value.assetId)).toEqual(["a1"]);
    // A network/image decoding failure must not consume a result.
    expect(taken.has("r1")).toBe(false);
    expect(takeReadyGenerationImages([task("r1", "SUCCEEDED", "READY")], watched, taken, null)).toHaveLength(1);
    taken.add("r1"); // The caller acknowledges only after successful insertion.
    expect(takeReadyGenerationImages([task("r1", "SUCCEEDED", "READY")], watched, taken, null)).toEqual([]);
  });

  it("recovers a result that completed while the project was closed", () => {
    expect(takeReadyGenerationImages([task("old", "SUCCEEDED", "READY")], new Set(), new Set(), null)).toHaveLength(1);
  });

  it("does not re-add saved results after refresh or after a user undoes their image", () => {
    const document = emptyOwnedDocument();
    document.source.novartPlacedGenerations = ["saved"];
    expect(document.items).toEqual([]); // Image was explicitly undone/deleted.
    expect(takeReadyGenerationImages([task("saved", "SUCCEEDED", "READY")], new Set(), new Set(), document)).toEqual([]);
  });

  it("allows acknowledging a task whose images were already inserted before a lost receipt", () => {
    const document = emptyOwnedDocument();
    document.items.push({ id: "shape:already", kind: "image", x: 0, y: 0, w: 1, h: 1, rotation: 0, opacity: 1, assetId: "a1", assetSha256: image(1).assetSha256 });
    const ready = takeReadyGenerationImages([task("r1", "SUCCEEDED", "READY")], new Set(), new Set(), document);
    expect(ready).toHaveLength(1);
    expect(ready[0]!.images).toEqual([]);
  });

  it("orders completion candidates deterministically independent of list polling order", () => {
    const earlier = { ...task("earlier", "SUCCEEDED", "READY"), expiresAt: "2026-10-19T11:00:00.000Z" };
    const later = task("later", "SUCCEEDED", "READY");
    expect(takeReadyGenerationImages([later, earlier], new Set(), new Set(), null).map(value => value.task.requestId)).toEqual(["earlier", "later"]);
  });

  it("skips images already on the canvas and keeps waiting while results are archiving", () => {
    const watched = new Set(["r2"]), taken = new Set<string>();
    expect(takeReadyGenerationImages([task("r2", "SUCCEEDED", "RUNNING")], watched, taken, null)).toEqual([]);
    const document = { ...emptyOwnedDocument(), items: [{ id: "shape:x", kind: "image" as const, x: 0, y: 0, w: 1, h: 1, rotation: 0, opacity: 1, parentId: "page:novart", url: image(1).url, assetId: "a1", assetSha256: image(1).assetSha256 }] };
    const ready = takeReadyGenerationImages([task("r2", "SUCCEEDED", "READY", [image(1), image(2)])], watched, taken, document);
    expect(ready[0]!.images.map(value => value.assetId)).toEqual(["a2"]);
  });

  it("does not place or acknowledge a failed task", () => {
    const watched = new Set(["r3"]), taken = new Set<string>();
    expect(takeReadyGenerationImages([task("r3", "FAILED", "NOT_REQUESTED", [])], watched, taken, null)).toEqual([]);
    expect(taken.has("r3")).toBe(false);
  });

  it("can place an existing task after its archive failure is explicitly retried", () => {
    const watched = new Set(["archive"]), taken = new Set<string>();
    expect(takeReadyGenerationImages([task("archive", "SUCCEEDED", "FAILED", [])], watched, taken, null)).toEqual([]);
    expect(takeReadyGenerationImages([task("archive", "SUCCEEDED", "PENDING", [])], watched, taken, null)).toEqual([]);
    expect(takeReadyGenerationImages([task("archive", "SUCCEEDED", "READY")], watched, taken, null)).toHaveLength(1);
  });
});
