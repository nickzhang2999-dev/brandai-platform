/** Real HTTP/auth/Postgres rejection checks. Never calls a paid or mock provider. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@brandai/db";
import { getEffectiveAiSettings } from "../src/lib/settings";

type Result = { status: number; data: any };
type Options = {
  call: (actor: string, path: string, method?: string, body?: unknown, origin?: string, headers?: Record<string, string>) => Promise<Result>;
  check: (label: string, fn: () => void) => void;
  base: string; ws: string;
};

export async function verifyStudioGenerationBackend({ call, check, base, ws }: Options) {
  const db = new URL(process.env.DATABASE_URL ?? "http://invalid");
  assert.equal(db.pathname, "/novart_integration_test");
  assert.ok(["localhost", "127.0.0.1"].includes(db.hostname));
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
  const cfg = await getEffectiveAiSettings();
  assert.ok(cfg.image.provider === "mock" || !cfg.image.apiKey, "This rejection suite refuses an enabled real provider; run paid-provider acceptance separately.");
  const created = await call("owner", `/api/workspaces/${ws}/projects`, "POST", { name: "Generation boundary acceptance" });
  assert.equal(created.status, 201); const pid = created.data.id;
  const endpoint = `/studio/generation?workspaceId=${ws}`;
  const payload = { projectId: pid, mutationId: randomUUID(), prompt: "An abstract brand illustration",
    sizeSelection: { ratioKey: "1:1", resolutionTier: "1K" }, workflowRevision: 0, documentRevision: 0 };
  const before = { requests: await prisma.studioGenerationRequest.count({ where: { workspaceId: ws } }),
    generations: await prisma.generation.count({ where: { workspaceId: ws } }) };

  const anonymous = await call("anonymous", endpoint, "POST", payload);
  const viewer = await call("viewer", endpoint, "POST", payload);
  const outsider = await call("outsider", endpoint, "POST", payload);
  const crossOrigin = await call("owner", endpoint, "POST", payload, "https://foreign.invalid");
  check("studio generation enforces authentication, writer membership and same origin", () => {
    assert.equal(anonymous.status, 401); assert.equal(viewer.status, 403);
    assert.equal(outsider.status, 404); assert.equal(crossOrigin.status, 403);
  });
  const unsupported = await call("owner", endpoint, "POST", { ...payload, assetUsages: [{ assetId: "forged", mode: "REFERENCE" }] });
  const invalid = await call("owner", endpoint, "POST", { ...payload, sizeSelection: { ratioKey: "1:1", resolutionTier: "4K" } });
  check("client cannot inject material resolution or unsupported resolution into generation", () => {
    assert.equal(unsupported.status, 422); assert.equal(invalid.status, 422);
  });
  const unavailable = await call("owner", endpoint, "POST", payload);
  check("unconfigured or mock generation fails explicitly before acceptance", () => {
    assert.equal(unavailable.status, 503, JSON.stringify(unavailable.data));
    assert.ok(typeof unavailable.data.error === "string" && unavailable.data.error.length > 0);
    assert.ok(!unavailable.data.requestId);
  });
  const history = await call("owner", `${endpoint}&projectId=${pid}`);
  const foreignHistory = await call("outsider", `${endpoint}&projectId=${pid}`);
  check("new project has a real empty generation history and outsider access is denied", () => {
    assert.equal(history.status, 200); assert.deepEqual(history.data.requests, []); assert.equal(foreignHistory.status, 404);
  });
  const missing = await call("owner", `${endpoint}&projectId=${pid}&requestId=missing-generation`);
  const retry = await call("owner", `/studio/generation/retry-archive?workspaceId=${ws}`, "POST", { projectId: pid, requestId: "missing-generation" });
  check("missing generation and archive retry cannot manufacture a completed receipt", () => {
    assert.equal(missing.status, 404); assert.equal(retry.status, 404);
  });
  const after = { requests: await prisma.studioGenerationRequest.count({ where: { workspaceId: ws } }),
    generations: await prisma.generation.count({ where: { workspaceId: ws } }) };
  check("rejected requests create neither generation quota reservations nor outbox rows", () => assert.deepEqual(after, before));
}
