import { StudioWritingReferenceAccepted, StudioWritingState } from "@brandai/contracts";
import type { OwnedCanvasDocument } from "@/lib/owned-canvas-model";

/** Only explicit selected, persisted assets cross into writing. The server
 * rechecks project membership, asset ownership and the content hash. */
export async function importWritingReferences(scope: { workspaceId: string; projectId: string; userId: string },
  document: OwnedCanvasDocument, selectedIds: string[], fetcher: typeof fetch = fetch): Promise<string[]> {
  const images = document.items.filter(item => selectedIds.includes(item.id) && item.kind === "image" && item.assetId && item.assetSha256);
  const text = document.items.filter(item => selectedIds.includes(item.id) && item.kind === "text").map(item => item.text || "").join("\n\n").trim();
  if (!images.length && !text) return [];
  const endpoint = `/api/workspaces/${encodeURIComponent(scope.workspaceId)}/projects/${encodeURIComponent(scope.projectId)}/studio-writing`;
  const headers = { "Content-Type": "application/json", "X-Novart-User": scope.userId };
  async function request(path: string, init?: RequestInit) {
    const response = await fetcher(path, { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(20000), headers, ...init });
    const body = await response.json();
    if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : "参考图片尚未确认保存，请重试带入原素材。");
    return body;
  }
  const state = StudioWritingState.parse(await request(endpoint));
  const ids: string[] = [];
  function identity(key: string) {
    const journalKey = "novart:writing-import:" + JSON.stringify([scope.userId, scope.workspaceId, scope.projectId, key]);
    try {
      const pending = sessionStorage.getItem(journalKey);
      const mutationId = pending && /^[a-f0-9-]{36}$/i.test(pending) ? pending : crypto.randomUUID();
      sessionStorage.setItem(journalKey, mutationId);
      return { journalKey, mutationId };
    } catch { throw new Error("资料恢复记录暂时无法保存，请保留本页并恢复浏览器存储后重试。"); }
  }
  for (const image of images) {
    const existing = state.references.find(reference => reference.sha256 === image.assetSha256 && reference.kind === "IMAGE");
    if (existing) { if (!ids.includes(existing.id)) ids.push(existing.id); continue; }
    // Journal only explicit imports. A lost acknowledgement reuses its id;
    // after a confirmed import/deletion a later gesture may create a new one.
    const { journalKey, mutationId } = identity(image.assetId + ":" + image.assetSha256);
    const receipt = StudioWritingReferenceAccepted.parse(await request(endpoint + "/references", { method: "POST", body: JSON.stringify({
      mutationId, assetId: image.assetId, assetSha256: image.assetSha256, name: `画布参考图 ${image.imageNumber ?? ids.length + 1}`,
    }) }));
    ids.push(receipt.reference.id);
    state.references.push(receipt.reference);
    sessionStorage.removeItem(journalKey);
  }
  if (text) {
    const bytes = new TextEncoder().encode(text);
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map(n => n.toString(16).padStart(2, "0")).join("");
    const existing = state.references.find(reference => reference.sha256 === hash && reference.kind === "DOCUMENT");
    if (existing) ids.push(existing.id);
    else {
      const { journalKey, mutationId } = identity("selected-text:" + hash);
      const form = new FormData(); form.append("mutationId", mutationId); form.append("file", new File([bytes], "画布所选文字.txt", { type: "text/plain" }));
      const receipt = StudioWritingReferenceAccepted.parse(await request(endpoint + "/references", { method: "POST", headers: { "X-Novart-User": scope.userId }, body: form }));
      ids.push(receipt.reference.id); sessionStorage.removeItem(journalKey);
    }
  }
  return ids;
}
