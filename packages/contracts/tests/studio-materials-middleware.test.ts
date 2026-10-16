import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import configureNext from "../../../apps/web/next.config.mjs";
import { STUDIO_MATERIAL_MAX_BYTES } from "../src/studio-materials";

vi.mock("../../../apps/web/src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
import { readStudioMaterialForm } from "../../../apps/web/src/lib/studio-materials-policy";
import { readAssetUploadForm, validateAssetUpload } from "../../../apps/web/src/lib/asset-upload-policy";
import { MAX_ASSET_UPLOAD_BYTES } from "../../../apps/web/src/lib/upload-limits";

// Exercise the installed Next implementation on a real IncomingMessage, not a
// simulated truncation. Both streams use the same bounded middleware buffer.
const requireWeb = createRequire(new URL("../../../apps/web/next.config.mjs", import.meta.url));
const { PHASE_PRODUCTION_BUILD } = requireWeb("next/constants");
const nextConfig = configureNext(PHASE_PRODUCTION_BUILD);
const { getCloneableBody, requestToBodyStream } = requireWeb("next/dist/server/body-streams") as {
  getCloneableBody(req: IncomingMessage, limit?: number): { cloneBodyStream(): Readable; finalize(): Promise<void> };
  requestToBodyStream(context: typeof globalThis, bytes: typeof Uint8Array, stream: Readable): ReadableStream<Uint8Array>;
};
let base = "";
const server = createServer(async (incoming, response) => {
  try {
    const clone = getCloneableBody(incoming, nextConfig.experimental.middlewareClientMaxBodySize);
    const clonedBody = clone.cloneBodyStream();
    const headers = new Headers();
    for (const name of ["content-type", "content-length"]) {
      const value = incoming.headers[name];
      if (typeof value === "string") headers.set(name, value);
    }
    const request = new Request(base + "/studio/material-upload", {
      method: "POST", headers, body: requestToBodyStream(globalThis, Uint8Array, clonedBody), duplex: "half",
    } as RequestInit);
    let upload: { body: Buffer; sha256: string };
    if (incoming.url === "/legacy-upload") {
      const form = await readAssetUploadForm(request);
      const file = form.get("file") as File;
      const body = Buffer.from(await file.arrayBuffer());
      validateAssetUpload(body, file.name);
      upload = { body, sha256: createHash("sha256").update(body).digest("hex") };
    } else {
      upload = await readStudioMaterialForm(request);
    }
    await clone.finalize();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ size: upload.body.length, sha256: upload.sha256 }));
  } catch (error) {
    response.writeHead((error as { status?: number }).status ?? 500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }));
  }
});

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback test listener");
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

function multipart(size: number) {
  const bytes = new Uint8Array(size).fill(0x5a);
  const form = new FormData();
  form.append("projectId", "middleware-boundary-project");
  form.append("mutationId", "831a0280-2cf1-41ba-ac94-621053c4a4c6");
  form.append("file", new Blob([bytes], { type: "image/png" }), "boundary.png");
  return { bytes, form };
}

describe("studio multipart intake through Next middleware body cloning", () => {
  it("preserves an entire maximum-size file plus its multipart envelope", async () => {
    const { bytes, form } = multipart(STUDIO_MATERIAL_MAX_BYTES);
    const response = await fetch(base + "/studio/material-upload", { method: "POST", body: form });
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(200);
    expect(result).toEqual({ size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  });

  it("rejects a file one byte above the limit with 413 instead of a truncated-form 400", async () => {
    const { form } = multipart(STUDIO_MATERIAL_MAX_BYTES + 1);
    const response = await fetch(base + "/studio/material-upload", { method: "POST", body: form });
    expect(response.status, await response.text()).toBe(413);
  });

  it("rejects a declared request above the multipart envelope budget", async () => {
    const { form } = multipart(STUDIO_MATERIAL_MAX_BYTES + 64 * 1024);
    const response = await fetch(base + "/studio/material-upload", { method: "POST", body: form });
    expect(response.status, await response.text()).toBe(413);
  });

  it("preserves a 50 MiB legacy document through the same middleware without raising Studio's own limit", async () => {
    const bytes = Buffer.alloc(MAX_ASSET_UPLOAD_BYTES); bytes.write("%PDF-1.7\n");
    const form = new FormData(); form.append("category", "VI_DOC"); form.append("file", new Blob([bytes], { type: "application/pdf" }), "manual.pdf");
    const response = await fetch(base + "/legacy-upload", { method: "POST", body: form });
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(200);
    expect(result).toEqual({ size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }, 30_000);

  it("rejects a legacy document just above 50 MiB with 413 instead of truncating it", async () => {
    const bytes = Buffer.alloc(MAX_ASSET_UPLOAD_BYTES + 1); bytes.write("%PDF-1.7\n");
    const form = new FormData(); form.append("category", "VI_DOC"); form.append("file", new Blob([bytes], { type: "application/pdf" }), "manual.pdf");
    const response = await fetch(base + "/legacy-upload", { method: "POST", body: form });
    expect(response.status, await response.text()).toBe(413);
  }, 30_000);
});
