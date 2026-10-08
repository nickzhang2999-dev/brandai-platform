/** Next can expose an internal req.url; browser Origin must match the incoming Host. */
export function isWorkbenchSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    const url = new URL(origin), internal = new URL(req.url);
    const host = req.headers.get("host") ?? internal.host;
    const protocol = req.headers.get("x-forwarded-proto") ?? internal.protocol.slice(0, -1);
    return ["http", "https"].includes(protocol) && url.origin === `${protocol}://${host}`;
  } catch { return false; }
}
