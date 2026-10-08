import { readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

type Manifest = { format: string; files: Record<string, { file: string; mime: string; sha256: string; bytes: number }>; external: Record<string, string> };
const root = path.resolve(process.cwd(), "../../.novart-build/studio");
let manifestPromise: Promise<Manifest> | undefined;
export function studioManifest() {
  return manifestPromise ??= readFile(path.join(root, "manifest.json"), "utf8").then(text => {
    const value = JSON.parse(text) as Manifest;
    if (value.format !== "novart-studio-assets-v1") throw new Error("Invalid studio asset manifest");
    return value;
  }).catch(error => { manifestPromise = undefined; throw error; });
}
export async function studioAsset(urlPath: string, allowHtml = false) {
  const manifest = await studioManifest();
  const entry = Object.hasOwn(manifest.files, urlPath) ? manifest.files[urlPath] : undefined;
  if (!entry || !allowHtml && entry.mime.includes("html")) return null;
  const filename = await realpath(path.join(root, entry.file));
  const relative = path.relative(await realpath(root), filename);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Invalid studio asset path");
  const bytes = await readFile(filename);
  if (bytes.length !== entry.bytes || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new Error("Studio asset checksum mismatch");
  return { bytes, mime: entry.mime };
}
export function studioHtml(html: string, data: unknown) {
  // Delay captured scripts until the authenticated bootstrap has installed the
  // transport and scoped browser state. Preserve their original source order.
  const deferred = html.replace(/<script\b([^>]*)>/g, (_all, attrs: string) => `<script type="application/x-novart"${attrs.replace(/\s+type=["'][^"']*["']/g, "")}>`);
  const json = JSON.stringify(data).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return deferred.replace("</head>", `<script id="novart-product-context" type="application/json">${json}</script><script defer src="/novart-product-bootstrap.js"></script></head>`);
}
