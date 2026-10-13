import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OwnedLayerPanel } from "../../../apps/web/src/components/owned-canvas/OwnedLayerPanel";
import { OwnedLayerOptions } from "../../../apps/web/src/components/owned-canvas/OwnedLayerOptions";
import { emptyOwnedDocument, type OwnedCanvasDocument } from "../../../apps/web/src/lib/owned-canvas-model";
import { StudioDecompositionView } from "../../contracts/src/studio-decomposition";

// Explicitly synthetic component receipts; no account, database or provider.
const source = { id: "shape:original", kind: "image" as const, x: 0, y: 0, w: 100, h: 100, rotation: 0, opacity: 1, parentId: "page:novart", assetId: "original", assetSha256: "a".repeat(64), url: "/api/workspaces/w/assets/original/raw" };
const input = { projectId: "p", mutationId: "00000000-0000-4000-8000-000000000001", sourceShapeId: source.id, assetId: source.assetId, assetSha256: source.assetSha256, documentRevision: 3, layerCount: 2 };
const task = StudioDecompositionView.parse({ ...input, requestId: "task", sourceWidth: 100, sourceHeight: 100, status: "SUCCEEDED", error: null, createdAt: "2026-10-13T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z", archiveExpiresAt: null, canRetryArchive: false,
  layers: [0, 1].map(order => ({ order, assetId: `layer-${order}`, assetSha256: String(order + 1).repeat(64), width: 100, height: 100, mimeType: "image/png", url: `/api/workspaces/w/assets/layer-${order}/raw`, sizeBytes: 100, alphaBounds: { left: 0, top: 0, width: 100, height: 100 }, inkCoverage: 0.5 })) });
const settle = async () => { await act(async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); }); };
beforeEach(() => { vi.stubGlobal("React", React); window.sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function fixture(document: OwnedCanvasDocument = { ...emptyOwnedDocument(), items: [source] }, tasks = [task]) {
  const api = { listDecompositions: vi.fn(async () => tasks), submitDecomposition: vi.fn(async (value: typeof input) => ({ ...task, ...value, requestId: "recursive", layerMode: "AUTO" as const, layerCount: 2, analysisStatus: "PENDING" as const, status: "PENDING" as const, layers: [] })) };
  const onPrepare = vi.fn(async () => ({ document, revision: 3 }));
  render(<OwnedLayerPanel api={api as never} workspaceId="w" projectId="p" userId="u" document={document} selectedIds={[source.id]} readOnly={false} onPrepare={onPrepare} onPlace={vi.fn()} />);
  return { api, onPrepare };
}
describe("owned semantic layer interaction", () => {
  it("keeps manual counts behind advanced controls and defaults to AUTO", () => {
    const onMode = vi.fn(), onCount = vi.fn();
    const view = render(<OwnedLayerOptions mode="AUTO" count={4} context="PSD" disabled={false} onMode={onMode} onCount={onCount} />);
    expect(screen.queryByRole("combobox", { name: "PSD图层数量" })).toBeNull();
    const advanced = screen.getByText("高级分层设置").closest("details")!; advanced.open = true;
    fireEvent.click(screen.getByRole("radio", { name: "手动指定层数" })); expect(onMode).toHaveBeenCalledWith("MANUAL");
    view.rerender(<OwnedLayerOptions mode="MANUAL" count={4} context="PSD" disabled={false} onMode={onMode} onCount={onCount} />);
    fireEvent.change(screen.getByRole("combobox", { name: "PSD图层数量" }), { target: { value: "6" } }); expect(onCount).toHaveBeenCalledWith(6);
  });
  it("selects a stored layer for further decomposition without submitting until confirmed", async () => {
    const layers = task.layers.map((layer, index) => ({ ...source, id: `shape:layer-${index}`, assetId: layer.assetId, assetSha256: layer.assetSha256, url: layer.url, groupId: "group:existing" }));
    const document = { ...emptyOwnedDocument(), items: [{ ...source, hidden: true }, ...layers] }, f = fixture(document); await settle();
    fireEvent.click(screen.getByRole("button", { name: "进一步分层：图层 1" }));
    expect(f.api.submitDecomposition).not.toHaveBeenCalled(); expect(screen.getByTestId("owned-layer-source").textContent).toContain("只拆分这一个图层");
    fireEvent.click(screen.getByTestId("owned-layer-submit")); await settle();
    expect(f.api.submitDecomposition).toHaveBeenCalledTimes(1);
    expect(f.api.submitDecomposition.mock.calls[0]![0]).toMatchObject({ sourceShapeId: "shape:layer-0", assetId: "layer-0", assetSha256: "1".repeat(64), layerMode: "AUTO" });
    expect(f.api.submitDecomposition.mock.calls[0]![0]).not.toHaveProperty("layerCount");
    expect(document.items[2]!.assetId).toBe("layer-1");
  });
  it("does not submit a changed source while its document save is being confirmed", async () => {
    const f = fixture(); await settle(); f.onPrepare.mockResolvedValueOnce({ document: { ...emptyOwnedDocument(), items: [{ ...source, assetSha256: "b".repeat(64) }] }, revision: 3 });
    fireEvent.click(screen.getByTestId("owned-layer-submit")); await settle();
    expect(f.api.submitDecomposition).not.toHaveBeenCalled(); expect(screen.getByTestId("owned-layer-notice").textContent).toContain("选中的图片已变化");
  });
  it("does not offer refinement before the real saved layer is on the canvas", async () => {
    fixture(); await settle(); expect((screen.getByRole("button", { name: "进一步分层：图层 1" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
