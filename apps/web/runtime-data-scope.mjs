/** One identity binds the preview database and physical object namespace. */
export function dataScope(env = process.env) {
  const scope = env.NOVART_DATA_SCOPE || "";
  if (scope && !/^novart_preview_[a-z0-9_]{1,40}$/.test(scope)) throw new Error("Invalid isolated runtime data scope");
  return scope;
}
export function assertRuntimeDataScope(env = process.env) {
  const scope = dataScope(env);
  if (!scope) return;
  try {
    const url = new URL(env.DATABASE_URL || "");
    if (url.searchParams.get("schema") !== scope || !env.BRANDAI_QUEUE_PREFIX || env.BRANDAI_QUEUE_PREFIX === "main") throw new Error();
  } catch { throw new Error("Isolated runtime requires its own database schema and queue prefix"); }
}
export function scopedObjectKey(key, env = process.env) {
  const scope = dataScope(env);
  if (!scope) return key;
  const prefix = `deployments/${scope}/`;
  if (!key || /[\\?#]/.test(key) || key.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Invalid storage object key");
  if (key.startsWith(prefix)) return key;
  if (key.startsWith("deployments/")) throw new Error("Cross-environment storage access rejected");
  return prefix + key;
}
