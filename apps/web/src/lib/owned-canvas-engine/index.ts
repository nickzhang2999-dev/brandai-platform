import { decodeOwnedCanvas, encodeOwnedCanvas } from "../owned-canvas-codec";
import { serializeOwnedDocument, type OwnedCanvasDocument } from "../owned-canvas-model";
import { exportOwnedPng, exportOwnedSvg, getOwnedBounds } from "../owned-canvas-export";

/** Product adapter: the existing native document and export paths remain the
 * sole persistence boundary. Authentication, revisions, uploads and model jobs
 * belong to the host application, never to this browser-only engine.
 */
export const ownedCanvasEngine = Object.freeze({
  id: "deepflare-owned-v1",
  documentFormat: "novart-native-v1",
  decodeDocument: decodeOwnedCanvas,
  encodeDocument: encodeOwnedCanvas,
  serializeDocument: serializeOwnedDocument,
  exportPng: exportOwnedPng,
  exportSvg: exportOwnedSvg,
  getBounds: getOwnedBounds,
  canEdit: (document: OwnedCanvasDocument, readOnly = false) => !readOnly && document.warnings.length === 0,
});

export { OwnedCanvasScene } from "./scene";
export { OwnedCanvasHistory } from "./history";
export { cameraTransform, screenToWorld, worldToScreen, zoomCameraAt } from "./camera";
