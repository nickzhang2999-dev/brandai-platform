// Read only trusted deployment configuration; never derive an origin from a request.
try {
  const value = process.env.NOVART_PUBLIC_ORIGIN;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/"
    || url.search || url.hash || !value || value !== url.origin)
    throw new Error("Invalid preview origin");
  process.stdout.write(url.origin);
} catch {
  console.error("NOVART_PUBLIC_ORIGIN must be an HTTPS origin without credentials, path, query or fragment.");
  process.exitCode = 1;
}
