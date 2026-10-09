/** Real HTTP + password cookies + PostgreSQL + BullMQ + disposable S3 only.
 * Never substitute fake successful Asset rows or a mocked object store. */
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import sharp from "sharp";
import { prisma } from "@brandai/db";
import { StudioMaterialUploadView } from "@brandai/contracts";
import { verifyStudioWorkflowInitial, verifyStudioWorkflowBackend } from "./verify-studio-workflow-backend";

type Result = { status: number; data: any; bytes?: Uint8Array };
type Options = {
  call: (actor: string, path: string, method?: string, body?: unknown, origin?: string, headers?: Record<string, string>) => Promise<Result>;
  check: (label: string, fn: () => void) => void;
  base: string; ws: string;
};

export async function verifyStudioMaterialsBackend({ call, check, base, ws }: Options) {
  if (process.env.WORKBENCH_TEST_MATERIAL_UPLOAD !== "1") return;
  const db = new URL(process.env.DATABASE_URL ?? "http://invalid");
  assert.equal(db.pathname, "/novart_integration_test");
  assert.ok(["localhost", "127.0.0.1"].includes(db.hostname));
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
  const project = await call("owner", `/api/workspaces/${ws}/projects`, "POST", { name: "Durable image integration" });
  assert.equal(project.status, 201); const pid = project.data.id;
  await verifyStudioWorkflowInitial({ call, check, base, ws, projectId: pid });
  const endpoint = `/studio/material-upload?workspaceId=${ws}`;
  const bytes = await sharp({ create: { width: 48, height: 32, channels: 4, background: "#8870df" } }).png().toBuffer();
  const multipart = (mutationId = randomUUID(), body = bytes, projectId = pid) => {
    const form = new FormData(); form.append("projectId", projectId); form.append("mutationId", mutationId);
    form.append("file", new Blob([new Uint8Array(body)], { type: "image/png" }), "integration-image.png"); return form;
  };
  const upload = (actor = "owner", form = multipart(), origin = base) => call(actor, endpoint, "POST", form, origin);
  const poll = async (taskId: string) => {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const result = await call("owner", `${endpoint}&projectId=${pid}&taskId=${taskId}`);
      assert.equal(result.status, 200, JSON.stringify(result.data));
      const receipt = StudioMaterialUploadView.parse(result.data);
      if (["SUCCEEDED", "FAILED"].includes(receipt.status)) return receipt;
      await new Promise(resolve => setTimeout(resolve, 350));
    }
    throw new Error("Durable image task did not reach a terminal state within 120 seconds");
  };
  const viewer = await upload("viewer"), outsider = await upload("outsider"), anonymous = await upload("anonymous");
  const crossOrigin = await upload("owner", multipart(), "https://foreign.invalid");
  check("image upload enforces EDITOR, workspace membership, login and same origin", () => {
    assert.equal(viewer.status, 403); assert.equal(outsider.status, 404); assert.equal(anonymous.status, 401); assert.equal(crossOrigin.status, 403);
  });
  const oversized = await upload("owner", multipart(randomUUID(), Buffer.alloc(10 * 1024 * 1024 + 1)));
  check("actual multipart file size is bounded before staging", () => assert.equal(oversized.status, 413));

  const mutationId = randomUUID();
  const submitted = await Promise.all([upload("owner", multipart(mutationId)), upload("owner", multipart(mutationId))]);
  for (const result of submitted) assert.equal(result.status, 202, JSON.stringify(result.data));
  const taskId = submitted[0]!.data.taskId;
  check("concurrent duplicate submissions share one durable task", () => assert.equal(submitted[1]!.data.taskId, taskId));
  const changed = await upload("owner", multipart(mutationId, Buffer.from("different bytes")));
  check("a reused upload mutation cannot replace its file", () => assert.equal(changed.status, 409));
  const finished = await poll(taskId);
  assert.equal(finished.status, "SUCCEEDED", finished.error);
  const material = finished.material!;
  const staged = await prisma.studioMaterialUpload.findUniqueOrThrow({ where: { taskId }, include: { task: true } });
  const asset = await prisma.asset.findUniqueOrThrow({ where: { id: material.assetId } });
  const linked = await prisma.projectAsset.count({ where: { projectId: pid, assetId: material.assetId } });
  check("worker stores the real image, decodes dimensions and atomically clears staging", () => {
    assert.equal(staged.body, null); assert.equal(staged.task.status, "SUCCEEDED"); assert.equal(staged.task.refId, material.assetId);
    assert.equal(material.width, 48); assert.equal(material.height, 32); assert.equal(material.assetSha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(asset.storageKey, staged.objectKey); assert.equal(asset.workspaceId, ws); assert.equal(linked, 1); assert.equal(asset.sizeBytes, bytes.length);
    assert.equal(material.url, `/api/workspaces/${ws}/assets/${asset.id}/raw`);
    assert.ok(!JSON.stringify(finished).includes(asset.storageKey));
  });
  const raw = await call("owner", material.url), viewerRaw = await call("viewer", material.url), outsiderRaw = await call("outsider", material.url);
  check("authenticated raw reads exact stored bytes without exposing object-store URLs", () => {
    assert.equal(raw.status, 200); assert.deepEqual(Buffer.from(raw.bytes!), bytes); assert.equal(viewerRaw.status, 200); assert.equal(outsiderRaw.status, 404);
  });
  const foreignTask = await call("editor", `${endpoint}&projectId=${pid}&taskId=${taskId}`);
  const ownTasks = await call("owner", `${endpoint}&projectId=${pid}`);
  check("upload recovery is user scoped and retains completed receipts", () => {
    assert.equal(foreignTask.status, 404); assert.equal(ownTasks.status, 200); assert.ok(ownTasks.data.tasks.some((task: any) => task.taskId === taskId && task.material.assetId === asset.id));
  });
  const ownNotifications = await call("owner", `/api/workspaces/${ws}/notifications`);
  const teammateNotifications = await call("editor", `/api/workspaces/${ws}/notifications`);
  check("upload completion notifications stay private and link to the correct branded project", () => {
    assert.equal(ownNotifications.status, 200); assert.equal(teammateNotifications.status, 200);
    const note = ownNotifications.data.items.find((item: any) => item.id === `task:${taskId}`);
    assert.equal(note.kind, "STUDIO_UPLOAD"); assert.equal(note.href, `/canvas?workspaceId=${ws}&projectId=${pid}`);
    assert.ok(!teammateNotifications.data.items.some((item: any) => item.id === `task:${taskId}`));
  });
  const replay = await upload("owner", multipart(mutationId));
  const duplicateCount = await prisma.studioMaterialUpload.count({ where: { workspaceId: ws, projectId: pid, mutationId } });
  check("replaying a completed upload does not recreate Asset or ProjectAsset", () => {
    assert.equal(replay.status, 202); assert.equal(replay.data.material.assetId, asset.id); assert.equal(duplicateCount, 1);
  });

  const canvas = "SHAKKERDATA://" + gzipSync(JSON.stringify({ tldrawSnapshot: { document: { schema: {}, store: {
    "shape:uploaded": { id: "shape:uploaded", typeName: "shape", type: "c-image", x: 10, y: 20, rotation: 0, props: { url: material.url, w: 48, h: 32 }, meta: { name: "integration-image.png" } },
  } } } })).toString("base64");
  const saved = await call("owner", `/api/workspaces/${ws}/projects/${pid}/editor-document`, "PUT", { format: "novart-native-v1", canvas, revision: 0, mutationId: randomUUID() });
  const reopened = await call("viewer", `/api/workspaces/${ws}/projects/${pid}/editor-document`);
  const workflow = await call("viewer", `/workflow/assets?workspaceId=${ws}&projectId=${pid}`);
  check("the persistent image survives a real document save and shared workflow inspection", () => {
    assert.equal(saved.status, 200, JSON.stringify(saved.data)); assert.equal(reopened.status, 200); assert.equal(reopened.data.canvas, canvas);
    assert.equal(workflow.status, 200, JSON.stringify(workflow.data)); assert.ok(workflow.data.assets.some((item: any) => item.shapeId === "shape:uploaded" && item.assetSha256 === material.assetSha256));
  });
  await verifyStudioWorkflowBackend({ call, check, base, ws, projectId: pid, material });
  const beforeInvalid = await prisma.asset.count({ where: { workspaceId: ws } });
  const invalid = await upload("owner", multipart(randomUUID(), Buffer.from("malformed png")));
  assert.equal(invalid.status, 202); const invalidDone = await poll(invalid.data.taskId);
  const invalidRow = await prisma.studioMaterialUpload.findUniqueOrThrow({ where: { taskId: invalid.data.taskId } });
  const afterInvalid = await prisma.asset.count({ where: { workspaceId: ws } });
  check("corrupt images terminate with a readable error and no fake asset or retained bytes", () => {
    assert.equal(invalidDone.status, "FAILED"); assert.ok(invalidDone.error); assert.equal(invalidRow.body, null); assert.equal(invalidRow.assetId, null); assert.equal(afterInvalid, beforeInvalid);
  });
  await call("owner", `/api/workspaces/${ws}/projects/${pid}`, "PATCH", { archive: true });
  const archived = await upload();
  check("archived projects reject new uploads", () => assert.equal(archived.status, 409));
}
