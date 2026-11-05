/** Mirrors raw asset inline support: SVG, PDF and editable design files are downloads. */
export function evidencePreviewKind(mimeType?: string): "image" | "pdf" | "file" | "unknown" {
  if (!mimeType) return "unknown";
  const mime = mimeType.split(";", 1)[0]!.trim().toLowerCase();
  if (["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"].includes(mime)) return "image";
  return mime === "application/pdf" ? "pdf" : "file";
}
