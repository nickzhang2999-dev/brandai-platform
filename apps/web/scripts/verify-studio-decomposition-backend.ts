/** Real HTTP/auth/PG/upload-worker/S3 boundaries with zero model calls.
 * These are rejection and source-preservation checks, not Fal acceptance. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { prisma } from "@brandai/db";
import { StudioDecompositionInput, StudioMaterialUploadView } from "@brandai/contracts";
import { getEffectiveAiSettings, getEffectiveStorage } from "../src/lib/settings";
import { decodeOwnedCanvas, encodeOwnedCanvas } from "../src/lib/owned-canvas-codec";
import { emptyOwnedDocument } from "../src/lib/owned-canvas-model";
import { requireOwnedLayerSource } from "../src/lib/owned-canvas-decomposition";

type Result = { status: number; data: any; bytes?: Uint8Array };
type Options = {
  call: (actor: string, path: string, method?: string, body?: unknown, origin?: string, headers?: Record<string, string>) => Promise<Result>;
  check: (label: string, fn: () => void) => void;
  base: string; ws: string;
};

export async function verifyStudioDecompositionBackend({ call, check, base, ws }: Options) {
  const database = new URL(process.env.DATABASE_URL ?? "http://invalid"), app = new URL(base);
  assert.ok(["postgresql:", "postgres:"].includes(database.protocol));
  assert.equal(database.pathname, "/novart_integration_test");
  assert.ok(["localhost", "127.0.0.1"].includes(database.hostname));
  assert.ok(["http:", "https:"].includes(app.protocol) && ["localhost", "127.0.0.1"].includes(app.hostname));
  assert.ok(!app.username && !app.password && !app.search && !app.hash);
  assert.equal(process.env.WORKBENCH_TEST_MATERIAL_UPLOAD, "1", "Requires the actual disposable upload Worker and S3.");
  const guardProvider = async () => {
    const settings = await getEffectiveAiSettings();
    assert.equal(settings.layer.provider.trim().toLowerCase(), "mock", "Zero-call rejection checks refuse configured real layer providers.");
    assert.equal(settings.layer.apiKey.trim(), "", "Zero-call rejection checks refuse any layer API key.");
  };
  await guardProvider();
  const storage = await getEffectiveStorage();
  assert.equal(storage.configured, true, "Explicit disposable AppSetting storage is required.");

  const created = await call("owner", `/api/workspaces/${ws}/projects`, "POST", { name: "AI layering source preservation acceptance" });
  assert.equal(created.status, 201);
  const pid = created.data.id as string, endpoint = `/studio/decomposition?workspaceId=${ws}`;
  const query = `${endpoint}&projectId=${pid}`, retryEndpoint = `/studio/decomposition/retry-archive?workspaceId=${ws}`;
  const owner = await prisma.brandWorkspace.findUniqueOrThrow({ where: { id: ws }, select: { ownerId: true } });
  const project = await prisma.project.findUniqueOrThrow({ where: { id: pid }, select: { workspaceId: true, archivedAt: true } });
  check("layering source project is created through the real authenticated API", () => {
    assert.equal(project.workspaceId, ws); assert.equal(project.archivedAt, null);
  });

  const emptyBefore = await prisma.studioDecompositionRequest.count({ where: { workspaceId: ws, projectId: pid } });
  for (const actor of ["owner", "editor", "viewer"]) {
    const history = await call(actor, query);
    const rows = await prisma.studioDecompositionRequest.count({ where: { workspaceId: ws, projectId: pid } });
    check(`${actor} reads real empty layering history without creating a task`, () => {
      assert.equal(history.status, 200); assert.deepEqual(history.data.requests, []); assert.equal(rows, 0); assert.equal(emptyBefore, 0);
    });
  }

  const bytes = await sharp({ create: { width: 48, height: 32, channels: 4, background: "#8870df" } }).png().toBuffer();
  const mutationId = randomUUID(), uploadEndpoint = `/studio/material-upload?workspaceId=${ws}`;
  const form = new FormData(); form.append("projectId", pid); form.append("mutationId", mutationId);
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "image/png" }), "layering-source.png");
  const accepted = await call("owner", uploadEndpoint, "POST", form);
  assert.equal(accepted.status, 202);
  const acceptedReceipt = StudioMaterialUploadView.parse(accepted.data);
  let finished = acceptedReceipt;
  const deadline = Date.now() + 120_000;
  while (!["SUCCEEDED", "FAILED"].includes(finished.status) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 350));
    const polled = await call("owner", `${uploadEndpoint}&projectId=${pid}&taskId=${acceptedReceipt.taskId}`);
    assert.equal(polled.status, 200); finished = StudioMaterialUploadView.parse(polled.data);
  }
  assert.equal(finished.status, "SUCCEEDED", "Actual upload Worker must finish within 120 seconds.");
  const material = finished.material!;
  const upload = await prisma.studioMaterialUpload.findUniqueOrThrow({ where: { taskId: finished.taskId }, include: { task: true } });
  const asset = await prisma.asset.findUniqueOrThrow({ where: { id: material.assetId } });
  const links = await prisma.projectAsset.count({ where: { projectId: pid, assetId: material.assetId } });
  const sha256 = createHash("sha256").update(bytes).digest("hex"), raw = await call("owner", material.url);
  check("layering uses a real uploaded image with Worker-created durable identity and exact bytes", () => {
    assert.equal(upload.workspaceId, ws); assert.equal(upload.projectId, pid); assert.equal(upload.userId, owner.ownerId);
    assert.equal(upload.mutationId, mutationId); assert.equal(upload.body, null); assert.equal(upload.task.status, "SUCCEEDED");
    assert.equal(upload.assetId, asset.id); assert.equal(upload.sha256, sha256); assert.equal(upload.objectKey, asset.storageKey);
    assert.equal(asset.workspaceId, ws); assert.equal(asset.sizeBytes, bytes.length); assert.equal(asset.mimeType, "image/png");
    assert.equal(links, 1); assert.equal(material.assetSha256, sha256); assert.equal(material.width, 48); assert.equal(material.height, 32);
    assert.equal(raw.status, 200); assert.deepEqual(Buffer.from(raw.bytes!), bytes);
  });

  const document = emptyOwnedDocument(), shapeId = "shape:layering-source";
  document.items.push({ id: shapeId, kind: "image", x: 10, y: 20, w: 48, h: 32, rotation: 0, opacity: 1,
    parentId: document.pageId, assetId: material.assetId, assetSha256: sha256, url: material.url });
  const canvas = await encodeOwnedCanvas(document), documentEndpoint = `/api/workspaces/${ws}/projects/${pid}/editor-document`;
  const saved = await call("owner", documentEndpoint, "PUT", { format: "novart-native-v1", canvas, revision: 0, mutationId: randomUUID() });
  assert.equal(saved.status, 200);
  const savedRow = await prisma.editorDocument.findUniqueOrThrow({ where: { projectId: pid } });
  const payload = StudioDecompositionInput.parse({ projectId: pid, mutationId: randomUUID(), sourceShapeId: shapeId,
    assetId: material.assetId, assetSha256: sha256, documentRevision: saved.data.revision, layerCount: 2 });
  const source = requireOwnedLayerSource(await decodeOwnedCanvas(savedRow.canvas), payload);
  check("real API save retains a valid owned source image ready for layering", () => {
    assert.equal(savedRow.workspaceId, ws); assert.equal(savedRow.canvas, canvas); assert.equal(savedRow.revision, 1);
    assert.equal(source.assetId, material.assetId); assert.equal(source.assetSha256, sha256); assert.equal(source.url, material.url);
  });

  const protectedState = async () => ({
    requests: await prisma.studioDecompositionRequest.count({ where: { workspaceId: ws, projectId: pid } }),
    assets: await prisma.projectAsset.count({ where: { projectId: pid } }),
    usage: await prisma.usageLog.count({ where: { workspaceId: ws, kind: "DECOMPOSE" } }),
    document: await prisma.editorDocument.findUniqueOrThrow({ where: { projectId: pid } }),
    source: await prisma.asset.findUniqueOrThrow({ where: { id: material.assetId } }),
  });
  const before = await protectedState();
  assert.equal(before.requests, 0);
  const rejected = async (label: string, actor: string, path: string, method: string, body: unknown, expected: number, origin = base) => {
    await guardProvider();
    const response = await call(actor, path, method, body, origin), after = await protectedState();
    check(label, () => { assert.equal(response.status, expected); assert.deepEqual(after, before, "Rejected requests must leave the source, document, tasks and model usage unchanged."); });
    return response;
  };
  await rejected("anonymous cannot read layering history", "anonymous", query, "GET", undefined, 401);
  await rejected("nonmember cannot read another workspace's layering history", "outsider", query, "GET", undefined, 404);
  await rejected("anonymous cannot submit layering", "anonymous", endpoint, "POST", payload, 401);
  await rejected("nonmember cannot submit another workspace's layering", "outsider", endpoint, "POST", payload, 404);
  await rejected("viewer cannot submit layering even with a valid saved source", "viewer", endpoint, "POST", payload, 403);
  await rejected("cross-origin layering is denied before accepting a task", "owner", endpoint, "POST", payload, 403, "https://foreign.invalid");
  await rejected("layer count outside the contract is rejected", "owner", endpoint, "POST", { ...payload, layerCount: 1 }, 422);
  await rejected("client cannot inject provider configuration into layering", "owner", endpoint, "POST", { ...payload, provider: "fal" }, 422);
  for (const actor of ["owner", "editor"]) {
    const unavailable = await rejected(`${actor} receives explicit 503 without a real layer provider or durable task`, actor, endpoint, "POST", payload, 503);
    assert.ok(typeof unavailable.data?.error === "string" && unavailable.data.error.length > 0);
    assert.ok(!unavailable.data.requestId);
  }
  const missingRequest = "missing-layer-" + randomUUID();
  await rejected("unknown layer request cannot expose a receipt", "owner", `${query}&requestId=${missingRequest}`, "GET", undefined, 404);
  // These new delivery boundaries run through real Auth.js/Next/PG. No
  // synthetic provider result is inserted to manufacture a successful PSD.
  const missingGeneration = "missing-generation-" + randomUUID();
  const automaticPsd = `/api/workspaces/${ws}/studio/generated-psd?projectId=${pid}&requestId=${missingGeneration}`;
  const psdDownload = `/api/workspaces/${ws}/studio/decomposition/${missingRequest}/export?projectId=${pid}&format=psd`;
  await rejected("anonymous cannot read automatic PSD progress", "anonymous", automaticPsd, "GET", undefined, 401);
  await rejected("nonmember cannot read another workspace's automatic PSD progress", "outsider", automaticPsd, "GET", undefined, 404);
  await rejected("missing generation cannot manufacture an automatic PSD receipt", "owner", automaticPsd, "GET", undefined, 404);
  await rejected("anonymous cannot download private layered PSD", "anonymous", psdDownload, "GET", undefined, 401);
  await rejected("nonmember cannot download another workspace's layered PSD", "outsider", psdDownload, "GET", undefined, 404);
  await rejected("missing layer task cannot produce an empty or flattened PSD", "owner", psdDownload, "GET", undefined, 404);
  await rejected("viewer cannot obtain a fabricated PSD for an unknown task", "viewer", psdDownload, "GET", undefined, 404);
  await rejected("unknown project cannot read layering history", "owner", `${endpoint}&projectId=missing-project-${randomUUID()}`, "GET", undefined, 404);
  const retry = { projectId: pid, requestId: missingRequest };
  await rejected("missing archive retry cannot manufacture model output", "owner", retryEndpoint, "POST", retry, 404);
  await rejected("viewer cannot retry a layer archive", "viewer", retryEndpoint, "POST", retry, 403);
  await rejected("nonmember cannot retry another workspace's layer archive", "outsider", retryEndpoint, "POST", retry, 404);
  await rejected("cross-origin archive retry is denied", "owner", retryEndpoint, "POST", retry, 403, "https://foreign.invalid");

  const reopened = await call("viewer", documentEndpoint), originalAgain = await call("owner", material.url), after = await protectedState();
  check("all rejected layering requests preserve the original image and exact document on reopen", () => {
    assert.equal(reopened.status, 200); assert.equal(reopened.data.canvas, canvas); assert.equal(reopened.data.revision, savedRow.revision);
    assert.equal(originalAgain.status, 200); assert.deepEqual(Buffer.from(originalAgain.bytes!), bytes); assert.deepEqual(after, before);
  });
}
