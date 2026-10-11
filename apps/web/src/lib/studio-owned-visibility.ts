const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Own v2 frames keep world-space children flat. Visibility still inherits
 * through their explicit frame links; never infer these links for old SDK data. */
export function studioOwnedLayerHidden(store: Record<string, unknown>, shape: Record<string, unknown>): boolean {
  const seen = new Set<string>();
  let current = shape;
  for (let depth = 0; depth < 64; depth++) {
    const props = object(current.props), meta = object(object(current.meta).novartOwned);
    if (props.novartVersion !== 2 || meta.version !== 2) return false;
    if (meta.hidden === true) return true;
    if (meta.frameId === undefined) return false;
    if (typeof meta.frameId !== "string" || seen.has(meta.frameId)) return true;
    seen.add(meta.frameId);
    const frame = object(store[meta.frameId]);
    if (frame.id !== meta.frameId || frame.typeName !== "shape" || frame.type !== "frame") return true;
    current = frame;
  }
  return true;
}
