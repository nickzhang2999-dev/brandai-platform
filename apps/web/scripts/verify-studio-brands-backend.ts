/** Real HTTP/Auth.js and read-only disposable PostgreSQL evidence.
 * All brand and session mutations go through the existing API. No provider
 * calls, customer database writes or direct brand/member inserts occur here.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@brandai/db";

type Result = { status: number; data: any };
type Options = {
  call: (actor: string, path: string, method?: string, body?: unknown, origin?: string, headers?: Record<string, string>) => Promise<Result>;
  check: (label: string, fn: () => void) => void;
  base: string;
  ws: string;
  ownerId: string;
};

export async function verifyStudioBrandsBackend({ call, check, base, ws, ownerId }: Options) {
  const database = new URL(process.env.DATABASE_URL ?? "http://invalid");
  assert.equal(database.pathname, "/novart_integration_test");
  assert.ok(["localhost", "127.0.0.1"].includes(database.hostname));
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
  const before = await prisma.plan.findMany({ orderBy: { tier: "asc" } });
  check("brand policy migration enables unlimited brands for every seeded plan", () => {
    assert.ok(before.length >= 4);
    assert.ok(before.every(plan => plan.maxWorkspaces === -1));
  });
  const created = await Promise.all([1, 2].map(index => call("owner", "/api/workspaces", "POST", {
    name: `Multiple brand HTTP ${index} ${randomUUID().slice(0, 8)}`,
  })));
  check("two concurrent additional brands are created through real API transactions", () => {
    assert.deepEqual(created.map(result => result.status), [201, 201]);
    assert.notEqual(created[0]!.data.id, created[1]!.data.id);
  });
  const second: string = created[0]!.data.id;
  const ids = created.map(result => result.data.id as string);
  const rows = await prisma.brandWorkspace.findMany({ where: { id: { in: ids } } });
  const memberships = await prisma.membership.findMany({ where: { workspaceId: { in: ids } } });
  check("new brands and OWNER membership are persisted together", () => {
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.ownerId, ownerId);
      assert.ok(memberships.some(member => member.workspaceId === row.id && member.userId === ownerId && member.role === "OWNER"));
    }
  });
  const mutationId = randomUUID(), intent = { name: `Replayable brand HTTP ${randomUUID().slice(0, 8)}` };
  const headers = { "X-Novart-Mutation": mutationId };
  const intentCount = await prisma.brandWorkspace.count({ where: { ownerId } });
  const repeated = await Promise.all([1, 2].map(() => call("owner", "/api/workspaces", "POST", intent, base, headers)));
  check("concurrent delivery of one create intent returns the same brand with 201", () => {
    assert.deepEqual(repeated.map(result => result.status), [201, 201]);
    assert.equal(repeated[0]!.data.id, repeated[1]!.data.id);
  });
  const replayId: string = repeated[0]!.data.id;
  const receipt = await prisma.studioBrandCreation.findUniqueOrThrow({ where: { userId_mutationId: { userId: ownerId, mutationId } } });
  const intentAfter = await prisma.brandWorkspace.count({ where: { ownerId } });
  const memberCount = await prisma.membership.count({ where: { userId: ownerId, workspaceId: replayId, role: "OWNER" } });
  check("one create intent persists exactly one brand, owner membership and durable receipt", () => {
    assert.equal(intentAfter, intentCount + 1); assert.equal(memberCount, 1);
    assert.equal(receipt.workspaceId, replayId); assert.match(receipt.inputDigest, /^[0-9a-f]{64}$/);
  });
  const changedIntent = await call("owner", "/api/workspaces", "POST", { ...intent, name: intent.name + " changed" }, base, headers);
  const changedCount = await prisma.brandWorkspace.count({ where: { ownerId } });
  check("reusing a create intent for different input fails without another brand", () => {
    assert.equal(changedIntent.status, 409); assert.equal(changedCount, intentAfter);
  });
  const deletionPath = `/api/workspaces/${replayId}`;
  const unconfirmedDelete = await call("owner", deletionPath, "DELETE");
  const stillExists = await prisma.brandWorkspace.findUnique({ where: { id: replayId } });
  check("an unconfirmed legacy DELETE cannot remove the replay-test brand", () => {
    assert.equal(unconfirmedDelete.status, 415); assert.ok(stillExists);
  });
  const impact = await call("owner", `${deletionPath}/deletion`);
  check("real deletion preflight binds the exact brand name and current impact", () => {
    assert.equal(impact.status, 200); assert.equal(impact.data.workspaceId, replayId);
    assert.equal(impact.data.name, intent.name); assert.equal(impact.data.canDelete, true);
    assert.equal(impact.data.activeTasks, 0); assert.equal(impact.data.counts.members, 1);
    assert.match(impact.data.confirmationToken, /^[0-9a-f]{64}$/);
  });
  const deletionInput = { confirmationName: impact.data.name, confirmationToken: impact.data.confirmationToken, mutationId: randomUUID() };
  const deletionHeaders = { "X-Novart-User": ownerId };
  const deleted = await call("owner", deletionPath, "DELETE", deletionInput, base, deletionHeaders);
  const deletionReplay = await call("owner", deletionPath, "DELETE", deletionInput, base, deletionHeaders);
  const deletionReceipt = await prisma.brandDeletionReceipt.findUniqueOrThrow({
    where: { workspaceId_userId_mutationId: { workspaceId: replayId, userId: ownerId, mutationId: deletionInput.mutationId } },
  });
  check("confirmed deletion and its exact replay return the same durable receipt", () => {
    assert.equal(deleted.status, 200); assert.equal(deleted.data.deletedWorkspaceId, replayId);
    assert.equal(deletionReplay.status, 200); assert.deepEqual(deletionReplay.data, deleted.data);
    assert.match(deletionReceipt.payloadHash, /^[0-9a-f]{64}$/);
  });
  const deletedReplay = await call("owner", "/api/workspaces", "POST", intent, base, headers);
  const tombstone = await prisma.studioBrandCreation.findUniqueOrThrow({ where: { userId_mutationId: { userId: ownerId, mutationId } } });
  const deletedCount = await prisma.brandWorkspace.count({ where: { ownerId } });
  check("brand deletion retains its receipt and a retry cannot recreate the deleted brand", () => {
    assert.equal(deleted.status, 200); assert.equal(tombstone.workspaceId, null);
    assert.equal(deletedReplay.status, 410); assert.equal(deletedCount, intentCount);
  });
  const selected = await call("owner", "/api/workbench/session", "POST", { workspaceId: second });
  const refreshed = await call("owner", "/api/workbench/session");
  check("server-confirmed new brand survives a subsequent session request", () => {
    assert.equal(selected.status, 200);
    assert.equal(selected.data.activeWorkspaceId, second);
    assert.equal(refreshed.data.activeWorkspaceId, second);
    assert.ok(refreshed.data.workspaces.some((brand: any) => brand.id === ws));
    assert.ok(ids.every(id => refreshed.data.workspaces.some((brand: any) => brand.id === id)));
  });
  const selectedOld = await call("owner", "/api/workbench/session", "POST", { workspaceId: ws });
  const deepLink = await call("owner", `/api/workbench/session?workspaceId=${encodeURIComponent(second)}`);
  const stillOld = await call("owner", "/api/workbench/session");
  check("an explicit brand deep link is independent of another tab's selected cookie", () => {
    assert.equal(selectedOld.status, 200);
    assert.equal(deepLink.status, 200);
    assert.equal(deepLink.data.activeWorkspaceId, second);
    assert.equal(stillOld.data.activeWorkspaceId, ws);
  });
  const projects = await call("owner", `/api/workspaces/${second}/projects`);
  check("a newly created brand has an independent empty project library", () => {
    assert.equal(projects.status, 200);
    assert.deepEqual(projects.data, []);
  });
  const foreign = await call("outsider", "/api/workbench/session", "POST", { workspaceId: second });
  check("switching does not grant a nonmember access to another brand", () => assert.equal(foreign.status, 404));
  const baseline = await prisma.brandWorkspace.count({ where: { ownerId } });
  const denied = await Promise.all([
    call("owner", "/api/workspaces", "POST", { name: "Foreign write" }, "https://foreign.invalid"),
    call("owner", "/api/workspaces", "POST", { name: "Too large", padding: "x".repeat(5000) }),
    call("owner", "/api/workspaces", "POST", { name: "   " }),
    call("owner", "/api/workspaces", "POST", { name: "Wrong account" }, base, { "X-Novart-User": "foreign-actor" }),
  ]);
  check("brand writes reject foreign origin, excessive body, empty name and changed identity", () => {
    assert.deepEqual(denied.map(result => result.status), [403, 413, 422, 409]);
  });
  const count = await prisma.brandWorkspace.count({ where: { ownerId } });
  check("rejected creates preserve the brand count", () => assert.equal(count, baseline));
  const after = await prisma.plan.findMany({ orderBy: { tier: "asc" } });
  check("multiple brand creation does not change prices or generation quotas", () => assert.deepEqual(after, before));
}
