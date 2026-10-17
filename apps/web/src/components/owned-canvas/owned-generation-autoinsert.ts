import type { OwnedCanvasDocument } from "../../lib/owned-canvas-model";
import type { GenerationTask, PersistentImage } from "./owned-editor-api";

const inFlight = (task: GenerationTask) =>
  ["PENDING", "RUNNING"].includes(task.status) || task.status === "SUCCEEDED" && ["NOT_REQUESTED", "PENDING", "RUNNING"].includes(task.resultState);

/** Results to place automatically. Only tasks this page saw in flight are
 * eligible, so reopening a project never re-adds old results; each task is
 * taken once, and images already on the canvas are skipped. Mutates the two
 * tracking sets so repeated polls stay idempotent. */
export function takeReadyGenerationImages(tasks: GenerationTask[], watched: Set<string>, taken: Set<string>, document: OwnedCanvasDocument | null) {
  const ready: { task: GenerationTask; images: PersistentImage[] }[] = [];
  for (const task of tasks) {
    if (inFlight(task)) { watched.add(task.requestId); continue; }
    if (!watched.has(task.requestId) || taken.has(task.requestId)) continue;
    if (task.status !== "SUCCEEDED" || task.resultState !== "READY") { if (task.status === "FAILED" || task.resultState === "FAILED") taken.add(task.requestId); continue; }
    taken.add(task.requestId);
    const placed = new Set((document?.items ?? []).filter(item => item.kind === "image").map(item => `${item.assetId}:${item.assetSha256}`));
    const images = task.results.filter(image => !placed.has(`${image.assetId}:${image.assetSha256}`));
    if (images.length) ready.push({ task, images });
  }
  return ready;
}
