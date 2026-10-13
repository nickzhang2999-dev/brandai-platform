import type { createOwnedEditorApi, DecompositionTask } from "./owned-editor-api";

/** Fetch and validate the authenticated binary before starting a browser
 * download, so a rejected JSON response never becomes a misleading .psd. */
export async function downloadOwnedPsd(api: ReturnType<typeof createOwnedEditorApi>, task: DecompositionTask) {
  const output = await api.downloadPsd(task), url = URL.createObjectURL(output.blob);
  try {
    const link = document.createElement("a"); link.href = url; link.download = output.fileName;
    link.style.display = "none"; document.body.append(link);
    try { link.click(); } finally { link.remove(); }
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
