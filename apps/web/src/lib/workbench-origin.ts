/** CDS can rewrite both Host and req.url. Only server configuration may override them. */
export function isWorkbenchSameOrigin(req: Request, publicUrl = process.env.AUTH_URL): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    const url = new URL(origin);
    if (!["http:", "https:"].includes(url.protocol) || origin !== url.origin) return false;
    if (publicUrl !== undefined) {
      const configured = new URL(publicUrl);
      if (!["http:", "https:"].includes(configured.protocol) || configured.username || configured.password) return false;
      return url.origin === configured.origin;
    }
    const internal = new URL(req.url);
    const host = req.headers.get("host") ?? internal.host;
    const protocol = req.headers.get("x-forwarded-proto") ?? internal.protocol.slice(0, -1);
    return ["http", "https"].includes(protocol) && url.origin === `${protocol}://${host}`;
  } catch { return false; }
}
