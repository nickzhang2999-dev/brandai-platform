import type { OwnedCanvasDocument } from "../owned-canvas-model";

export type CanvasCamera = OwnedCanvasDocument["camera"];
export type CanvasPoint = { x: number; y: number };

/** Canvas-local screen coordinates. The host alone subtracts its DOM origin. */
export function screenToWorld(point: CanvasPoint, camera: CanvasCamera): CanvasPoint {
  return { x: (point.x - camera.x) / camera.zoom, y: (point.y - camera.y) / camera.zoom };
}

export function worldToScreen(point: CanvasPoint, camera: CanvasCamera): CanvasPoint {
  return { x: point.x * camera.zoom + camera.x, y: point.y * camera.zoom + camera.y };
}

export function zoomCameraAt(camera: CanvasCamera, zoom: number, anchor: CanvasPoint): CanvasCamera {
  if (!Number.isFinite(zoom) || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) return camera;
  const nextZoom = Math.max(0.1, Math.min(4, zoom));
  const world = screenToWorld(anchor, camera);
  return { x: anchor.x - world.x * nextZoom, y: anchor.y - world.y * nextZoom, zoom: nextZoom };
}

export function cameraTransform(camera: CanvasCamera): string {
  return `translate(${camera.x}px,${camera.y}px) scale(${camera.zoom})`;
}
