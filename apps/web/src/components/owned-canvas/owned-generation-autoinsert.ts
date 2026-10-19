import type { OwnedCanvasDocument } from "../../lib/owned-canvas-model";
import type { GenerationTask, PersistentImage } from "./owned-editor-api";

const inFlight = (task: GenerationTask) =>
  ["PENDING", "RUNNING"].includes(task.status) || task.status === "SUCCEEDED" && ["NOT_REQUESTED", "PENDING", "RUNNING"].includes(task.resultState);

/** The saved document ledger survives refresh and user undo. A candidate is
 * acknowledged only AFTER insertion succeeds, never merely after polling. */
export function takeReadyGenerationImages(tasks: GenerationTask[], watched: Set<string>, taken: Set<string>, document: OwnedCanvasDocument | null) {
  const ready: { task: GenerationTask; images: PersistentImage[] }[] = [];
  const acknowledged = new Set(Array.isArray(document?.source.novartPlacedGenerations) ? document.source.novartPlacedGenerations as string[] : []);
  for (const task of [...tasks].sort((a, b) => a.expiresAt.localeCompare(b.expiresAt) || a.requestId.localeCompare(b.requestId))) {
    if (inFlight(task)) { watched.add(task.requestId); continue; }
    if (taken.has(task.requestId) || acknowledged.has(task.requestId)) continue;
    // Archive retry reuses this identity. Failure is not a placement receipt.
    if (task.status !== "SUCCEEDED" || task.resultState !== "READY") continue;
    const placed = new Set((document?.items ?? []).filter(item => item.kind === "image").map(item => `${item.assetId}:${item.assetSha256}`));
    const images = task.results.filter(image => !placed.has(`${image.assetId}:${image.assetSha256}`));
    ready.push({ task, images });
  }
  return ready;
}
