import { describe, expect, it } from "vitest";
import { takeReadyGenerationImages } from "../src/components/owned-canvas/owned-generation-autoinsert";
import { emptyOwnedDocument } from "../src/lib/owned-canvas-model";
import type { GenerationTask } from "../src/components/owned-canvas/owned-editor-api";

// Synthetic task views; no account, database or provider.
const image = (n: number) => ({ versionId: `v${n}`, assetId: `a${n}`, assetSha256: String(n).repeat(64).slice(0, 64), width: 1024, height: 1024, mimeType: "image/png" as const, url: `/api/workspaces/w/assets/a${n}/raw` });
const task = (requestId: string, status: string, resultState: string, results = [image(1)]) =>
  ({ requestId, status, resultState, results, mode: "generate" } as unknown as GenerationTask);

describe("automatic placement of generated images", () => {
  it("places a result once after this page saw the task in flight", () => {
    const watched = new Set<string>(), taken = new Set<string>();
    expect(takeReadyGenerationImages([task("r1", "RUNNING", "NOT_REQUESTED", [])], watched, taken, null)).toEqual([]);
    const first = takeReadyGenerationImages([task("r1", "SUCCEEDED", "READY")], watched, taken, null);
    expect(first).toHaveLength(1);
    expect(first[0]!.images.map(value => value.assetId)).toEqual(["a1"]);
    // Later polls of the same finished task never place it again.
    expect(takeReadyGenerationImages([task("r1", "SUCCEEDED", "READY")], watched, taken, null)).toEqual([]);
  });

  it("does not re-add results that were already finished when the project opened", () => {
    expect(takeReadyGenerationImages([task("old", "SUCCEEDED", "READY")], new Set(), new Set(), null)).toEqual([]);
  });

  it("skips images already on the canvas and keeps waiting while results are archiving", () => {
    const watched = new Set(["r2"]), taken = new Set<string>();
    expect(takeReadyGenerationImages([task("r2", "SUCCEEDED", "RUNNING")], watched, taken, null)).toEqual([]);
    const document = { ...emptyOwnedDocument(), items: [{ id: "shape:x", kind: "image" as const, x: 0, y: 0, w: 1, h: 1, rotation: 0, opacity: 1, parentId: "page:novart", url: image(1).url, assetId: "a1", assetSha256: image(1).assetSha256 }] };
    const ready = takeReadyGenerationImages([task("r2", "SUCCEEDED", "READY", [image(1), image(2)])], watched, taken, document);
    expect(ready[0]!.images.map(value => value.assetId)).toEqual(["a2"]);
  });

  it("stops watching a failed task without placing anything", () => {
    const watched = new Set(["r3"]), taken = new Set<string>();
    expect(takeReadyGenerationImages([task("r3", "FAILED", "NOT_REQUESTED", [])], watched, taken, null)).toEqual([]);
    expect(taken.has("r3")).toBe(true);
  });
});
