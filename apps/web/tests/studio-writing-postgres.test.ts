import { createHash, randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from "vitest";
// Auth.js requires Next's request context; test the real authorization/data
// services with a plain error class. Prisma, membership and project are real.
vi.mock("@/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
import { prisma } from "@brandai/db";
import { StudioWritingState } from "@brandai/contracts";
import { saveWriting, writingState, writingVersions, writingMessages, submitWriting, writingTask, lookupWritingTask,
  uploadWritingReference, deleteWritingReference, writingReferenceContent, readWritingStyle, saveWritingStyle, expireWriting,
  writingDocumentId, type WritingScope, type WritingInput } from "@/lib/studio-writing";
import { prepareWritingSources, processWritingTask } from "@/lib/studio-writing-runtime";
import { buildWritingMessages, type WritingProviderContext } from "@/lib/studio-writing-provider";
import { getTask } from "@/lib/async-tasks";
import sharp from "sharp";

const isolated = process.env.WRITING_TEST_DATABASE_URL;
const suite = isolated ? describe : describe.skip;
suite("writing workbench real PostgreSQL isolation and durable transitions", () => {
  let s: WritingScope, member: WritingScope, viewer: WritingScope, foreign: WritingScope, otherProject: WritingScope;
  let users: string[] = [], spaces: string[] = [];
  beforeAll(() => {
    const url = new URL(isolated!);
    if (url.hostname !== "127.0.0.1" || url.pathname !== "/nova_writing_test" || process.env.DATABASE_URL !== isolated) throw new Error("Explicit isolated local test database required");
  });
  beforeEach(async () => {
    vi.stubEnv("COPYWRITING_API_KEY", "synthetic-test-only"); vi.stubEnv("COPYWRITING_BASE_URL", "https://never-called.invalid");
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No network allowed in database tests"); }));
    const prefix = "writing-test-" + randomUUID(); users = [prefix + "-owner", prefix + "-member", prefix + "-viewer", prefix + "-foreign"];
    await prisma.user.createMany({ data: users.map(id => ({ id, email: id + "@example.invalid", isActive: true })) });
    spaces = [prefix + "-ws", prefix + "-other"];
    await prisma.brandWorkspace.createMany({ data: spaces.map((id, i) => ({ id, ownerId: users[i ? 3 : 0], name: "合成品牌" })) });
    const projects = [prefix + "-p", prefix + "-p2", prefix + "-foreign-p"];
    await prisma.project.createMany({ data: projects.map((id, i) => ({ id, workspaceId: spaces[i === 2 ? 1 : 0], name: "合成项目" })) });
    await prisma.membership.createMany({ data: [{ userId: users[1], workspaceId: spaces[0], role: "EDITOR" }, { userId: users[2], workspaceId: spaces[0], role: "VIEWER" }] });
    s = { userId: users[0], workspaceId: spaces[0], projectId: projects[0] }; member = { ...s, userId: users[1] }; viewer = { ...s, userId: users[2] };
    foreign = { userId: users[3], workspaceId: spaces[1], projectId: projects[2] }; otherProject = { ...s, projectId: projects[1] };
  });
  afterEach(async () => {
    await prisma.asyncTask.deleteMany({ where: { workspaceId: { in: spaces } } });
    await prisma.usageLog.deleteMany({ where: { workspaceId: { in: spaces } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
  });
  afterAll(async () => { await prisma.$disconnect(); });
  const save = (scope: WritingScope, revision: number, text = "第一稿😀保留原文") => saveWriting(scope, { mutationId: randomUUID(), expectedRevision: revision, operation: "SAVE", title: "标题", text });
  const generate = (revision = 0, extra: Record<string, unknown> = {}) => ({ mutationId: randomUUID(), expectedRevision: revision, prompt: "只修改所选事实", mode: "GENERATE", referenceIds: [], styleRevision: null, ...extra });
  const output = (revision = 0, text = "模型建议") => ({ text, scope: "DOCUMENT" as const, baseRevision: revision, citations: [], styleDraft: null, model: "synthetic-only", inputTokens: 1, outputTokens: 1, latencyMs: 1 });
  async function reference(scope = s, name = "资料.txt", text = "产品事实和测试依据") {
    const accepted = await uploadWritingReference(scope, { mutationId: randomUUID(), name, mimeType: "text/plain", body: Buffer.from(text) });
    await processWritingTask(accepted.task.id, { parse: async () => ({ segments: [{ id: "segment-1", pageNumber: 3, label: "第3页", text }], truncated: false, parserRevision: "studio-writing-text-v1" }) });
    return accepted.reference.id;
  }

  it("GET is side-effect free for an empty draft and authorization isolates workspace/project/user", async () => {
    const empty = StudioWritingState.parse(await writingState(s)); expect(empty.document.revision).toBe(0);
    expect(await prisma.studioWritingDocument.count({ where: { workspaceId: s.workspaceId } })).toBe(0);
    await save(s, 0, "owner private");
    for (const scope of [member, viewer, otherProject, foreign]) expect((await writingState(scope)).document.text).toBe("");
    await expect(writingState({ ...s, workspaceId: foreign.workspaceId })).rejects.toMatchObject({ status: 404 });
    await expect(writingState({ ...s, projectId: foreign.projectId })).rejects.toMatchObject({ status: 404 });
    await expect(save(viewer, 0)).rejects.toMatchObject({ status: 403 });
    await prisma.user.update({ where: { id: member.userId }, data: { isActive: false } });
    await expect(writingState(member)).rejects.toMatchObject({ status: 403 });
  });
  it("concurrent CAS has exactly one winner, saves replay safely and restore makes a new immutable version", async () => {
    const request = { mutationId: randomUUID(), expectedRevision: 0, operation: "SAVE", title: "标题", text: "第一稿" };
    const first = await saveWriting(s, request);
    const race = await Promise.allSettled([save(s, 1, "winner A"), save(s, 1, "winner B")]);
    expect(race.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(race.filter(r => r.status === "rejected")).toHaveLength(1);
    const replay = await saveWriting(s, request); expect(replay.version.id).toBe(first.version.id); expect(replay.document.revision).toBe(2);
    await expect(saveWriting(s, { ...request, text: "changed payload" })).rejects.toMatchObject({ status: 409 });
    const restored = await saveWriting(s, { mutationId: randomUUID(), expectedRevision: 2, operation: "RESTORE", versionId: first.version.id });
    expect(restored.document).toMatchObject({ text: "第一稿", revision: 3 }); expect(restored.version.operation).toBe("RESTORE");
    expect((await writingVersions(s)).versions).toHaveLength(3);
    await expect(saveWriting(member, { mutationId: randomUUID(), expectedRevision: 0, operation: "RESTORE", versionId: first.version.id })).rejects.toMatchObject({ status: 404 });
  });
  it("selection exact UTF-16 offsets reject stale or different text and can be restored", async () => {
    await save(s, 0, "甲😀乙丙");
    await expect(saveWriting(s, { mutationId: randomUUID(), expectedRevision: 1, operation: "REPLACE", selection: { start: 1, end: 3, text: "甲乙" }, replacement: "新" })).rejects.toMatchObject({ status: 409 });
    const updated = await saveWriting(s, { mutationId: randomUUID(), expectedRevision: 1, operation: "REPLACE", selection: { start: 1, end: 3, text: "😀" }, replacement: "新" });
    expect(updated.document.text).toBe("甲新乙丙");
    await expect(submitWriting(s, generate(1, { mode: "SELECTION", selection: { start: 1, end: 3, text: "😀" } }))).rejects.toMatchObject({ status: 409 });
  });
  it("queue receipt and lost-response replay are stable, no mutation/parse invokes models", async () => {
    const request = generate(); const task = await submitWriting(s, request);
    expect(await submitWriting(s, request)).toEqual(task);
    expect((await lookupWritingTask(s, request.mutationId)).task?.id).toBe(task.id);
    await expect(submitWriting(s, { ...request, prompt: "different" })).rejects.toMatchObject({ status: 409 });
    await expect(submitWriting(s, generate())).rejects.toMatchObject({ status: 409 });
    expect((await writingMessages(s)).messages.map(m => m.role)).toEqual(["user"]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("task/refs/messages/versions cannot cross users even in same brand and generic polling remains private", async () => {
    const id = await reference(); const task = await submitWriting(s, generate(0, { referenceIds: [id] }));
    for (const scope of [member, otherProject, foreign]) {
      await expect(writingTask(scope, task.id)).rejects.toMatchObject({ status: 404 });
      expect((await lookupWritingTask(scope, task.mutationId)).task).toBeNull();
      await expect(deleteWritingReference(scope, id)).rejects.toMatchObject({ status: 404 });
      await expect(submitWriting(scope, generate(0, { referenceIds: [id] }))).rejects.toMatchObject({ status: 422 });
      expect((await writingMessages(scope)).messages).toEqual([]);
    }
    expect(await getTask(s.workspaceId, task.id, member.userId)).toBeNull();
    expect(await getTask(s.workspaceId, task.id)).toBeNull();
    expect((await getTask(s.workspaceId, task.id, s.userId))?.id).toBe(task.id);
  });
  it("generation uses selected files, confirmed style and prior conversation while manual edits survive model completion", async () => {
    await save(s, 0, "accepted draft"); const chosen = await reference(); await reference(s, "不选.txt", "不要发送的私人内容");
    const style = await saveWritingStyle(s, { mutationId: randomUUID(), expectedRevision: 0, confirmed: true, rules: ["短句"], examples: [{ title: "例", text: "温和直接" }] });
    expect((await readWritingStyle(member)).revision).toBe(style.revision);
    const task = await submitWriting(s, generate(1, { referenceIds: [chosen], styleRevision: style.revision }));
    await save(s, 1, "user edited while running");
    const model = vi.fn(async (context: WritingProviderContext) => {
      const body = JSON.stringify(buildWritingMessages(context)); expect(body).toContain("产品事实和测试依据"); expect(body).toContain("短句");
      expect(body).toContain("accepted draft"); expect(body).not.toContain("不要发送的私人内容");
      expect(context.sources).toHaveLength(1); expect(context.sources[0].segments[0].pageNumber).toBe(3);
      return output(1);
    });
    await Promise.all([processWritingTask(task.id, { generate: model }), processWritingTask(task.id, { generate: model })]);
    expect(model).toHaveBeenCalledTimes(1); expect((await writingState(s)).document).toMatchObject({ text: "user edited while running", revision: 2 });
    expect((await writingTask(s, task.id)).result?.baseRevision).toBe(1);
    const second = await submitWriting(s, generate(2));
    const input = (await prisma.asyncTask.findUniqueOrThrow({ where: { id: second.id } })).inputJson as unknown as WritingInput;
    expect(input.context?.history).toEqual([{ role: "user", text: "只修改所选事实" }, { role: "assistant", text: "模型建议" }]);
    expect(input.context?.style).toBeNull(); expect(input.context?.references).toEqual([]);
  });
  it("style extraction is a proposed draft only, confirmation is explicit, versioned and CAS-protected", async () => {
    const id = await reference();
    const task = await submitWriting(s, { mutationId: randomUUID(), referenceIds: [id], prompt: "归纳写法" }, true);
    await processWritingTask(task.id, { generate: async () => ({ ...output(), scope: "STYLE_DRAFT", styleDraft: { rules: ["模型草稿"], examples: [] } }) });
    expect((await readWritingStyle(s)).revision).toBe(0); expect((await writingState(s)).document.revision).toBe(0);
    const request = { mutationId: randomUUID(), expectedRevision: 0, confirmed: true, rules: ["人工确认规则"], examples: [] };
    await expect(saveWritingStyle(s, { ...request, confirmed: false })).rejects.toThrow();
    expect((await saveWritingStyle(s, request)).revision).toBe(1); expect((await saveWritingStyle(s, request)).revision).toBe(1);
    await expect(saveWritingStyle(member, { ...request, mutationId: randomUUID() })).rejects.toMatchObject({ status: 409 });
    expect(await prisma.studioWritingStyleVersion.count({ where: { workspaceId: s.workspaceId } })).toBe(1);
  });
  it("document bytes are hashed before parsing, parse failures clear retained bytes and are never auto-retried", async () => {
    const file = await uploadWritingReference(s, { mutationId: randomUUID(), name: "broken.pdf", mimeType: "application/pdf", body: Buffer.from("not a pdf") });
    await prisma.studioWritingReference.update({ where: { id: file.reference.id }, data: { body: Buffer.from("tampered") } });
    const parse = vi.fn(); await processWritingTask(file.task.id, { parse });
    expect(parse).not.toHaveBeenCalled(); expect((await writingTask(s, file.task.id)).error).toContain("哈希");
    expect((await prisma.studioWritingReference.findUniqueOrThrow({ where: { id: file.reference.id } })).body).toBeNull();
    await processWritingTask(file.task.id, { parse }); expect(parse).not.toHaveBeenCalled();
  });
  it("truncated status persists and only relevant bounded later-page snippets may be cited", async () => {
    const accepted = await uploadWritingReference(s, { mutationId: randomUUID(), name: "long.txt", mimeType: "text/plain", body: Buffer.from("synthetic") });
    await processWritingTask(accepted.task.id, { parse: async () => ({ segments: [
      { id: "one", pageNumber: 1, label: "第一页", text: "无关".repeat(1500) },
      { id: "two", pageNumber: 2, label: "第二页", text: "旧内容".repeat(1000) },
      { id: "nine", pageNumber: 9, label: "第九页", text: "冰淇淋口味带来清凉" }], truncated: true, parserRevision: "studio-writing-text-v1" }) });
    expect((await writingState(s)).references[0].truncated).toBe(true);
    const task = await submitWriting(s, generate(0, { prompt: "冰淇淋口味", referenceIds: [accepted.reference.id] }));
    const input = (await prisma.asyncTask.findUniqueOrThrow({ where: { id: task.id } })).inputJson as unknown as WritingInput;
    const sources = await prepareWritingSources(s, input, new AbortController().signal);
    expect(sources[0].segments[0]).toMatchObject({ id: "nine", pageNumber: 9 });
    expect(sources[0].coverage).toMatchObject({ extractionTruncated: true, partial: true, selection: "relevant-snippets" });
    expect(sources[0].segments.reduce((sum, segment) => sum + segment.text.length, 0)).toBeLessThanOrEqual(6000);
  });
  it("removal and permission revocation during the model call discard the result without changing the draft", async () => {
    const id = await reference(); const task = await submitWriting(s, generate(0, { referenceIds: [id] }));
    await processWritingTask(task.id, { generate: async () => { await deleteWritingReference(s, id); return output(); } });
    expect((await writingTask(s, task.id)).status).toBe("FAILED"); expect((await writingMessages(s)).messages.map(m => m.role)).toEqual(["user"]);
    const second = await submitWriting(member, generate());
    const model = vi.fn(async () => { await prisma.membership.delete({ where: { userId_workspaceId: { userId: member.userId, workspaceId: member.workspaceId } } }); return output(); });
    await processWritingTask(second.id, { generate: model });
    expect((await prisma.asyncTask.findUniqueOrThrow({ where: { id: second.id } })).status).toBe("FAILED");
  });
  it("expired queued tasks never make calls, clear pending references and preserve an explicit failure", async () => {
    const file = await uploadWritingReference(s, { mutationId: randomUUID(), name: "a.txt", mimeType: "text/plain", body: Buffer.from("data") });
    await prisma.asyncTask.update({ where: { id: file.task.id }, data: { expiresAt: new Date(Date.now() - 1) } });
    const parse = vi.fn(); await processWritingTask(file.task.id, { parse }); await expireWriting(s.workspaceId);
    expect(parse).not.toHaveBeenCalled(); expect((await writingState(s)).references[0].status).toBe("FAILED");
    expect((await prisma.studioWritingReference.findUniqueOrThrow({ where: { id: file.reference.id } })).body).toBeNull();
  });
  it("images remain private, verify actual decoding and support four bounded visual references", async () => {
    const body = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#336699" } }).png().toBuffer();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const file = await uploadWritingReference(s, { mutationId: randomUUID(), name: `image${i}.png`, mimeType: "image/png", body });
      await processWritingTask(file.task.id); ids.push(file.reference.id);
    }
    expect(Buffer.from((await writingReferenceContent(s, ids[0])).bytes)).toEqual(body);
    await expect(writingReferenceContent(member, ids[0])).rejects.toMatchObject({ status: 404 });
    await expect(submitWriting(s, generate(0, { referenceIds: ids }))).rejects.toMatchObject({ status: 422 });
    const task = await submitWriting(s, generate(0, { referenceIds: ids.slice(0, 4) }));
    await processWritingTask(task.id, { generate: async context => { expect(context.sources.filter(source => source.imageBase64)).toHaveLength(4); return output(); } });
    expect((await writingTask(s, task.id)).status).toBe("SUCCEEDED"); expect(fetch).not.toHaveBeenCalled();
  });
  it("byte, name, file type and aggregate document storage boundaries fail before paid work", async () => {
    await expect(uploadWritingReference(s, { mutationId: randomUUID(), name: "bad.exe", mimeType: "application/octet-stream", body: Buffer.from("x") })).rejects.toMatchObject({ status: 422 });
    await expect(uploadWritingReference(s, { mutationId: randomUUID(), name: "big.txt", mimeType: "text/plain", body: Buffer.alloc(10 * 1024 * 1024 + 1) })).rejects.toMatchObject({ status: 413 });
    await reference();
    await prisma.studioWritingReference.updateMany({ where: { documentId: writingDocumentId(s.workspaceId, s.projectId, s.userId) }, data: { sizeBytes: 64 * 1024 * 1024 } });
    await expect(uploadWritingReference(s, { mutationId: randomUUID(), name: "a.txt", mimeType: "text/plain", body: Buffer.from("x") })).rejects.toMatchObject({ status: 413 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("versions and continuous conversation paginate without omissions or foreign cursors", async () => {
    for (let revision = 0; revision < 23; revision++) await save(s, revision, `draft-${revision}`);
    const first = await writingVersions(s); expect(first.versions).toHaveLength(20); expect(first.hasMore).toBe(true);
    const second = await writingVersions(s, first.versions.at(-1)!.revision); expect(second.versions.map(v => v.revision)).toEqual([3, 2, 1]); expect(second.hasMore).toBe(false);
    const documentId = writingDocumentId(s.workspaceId, s.projectId, s.userId);
    await prisma.studioWritingMessage.createMany({ data: Array.from({ length: 54 }, (_, i) => ({ id: `msg-${randomUUID()}`, documentId, taskId: `synthetic-history-${i}`, role: i % 2 ? "assistant" : "user", text: `turn-${i}`, createdAt: new Date(2026, 0, 1, 0, 0, i) })) });
    const page = await writingMessages(s); expect(page.messages).toHaveLength(50); expect(page.hasMore).toBe(true); expect(page.messages[0].text).toBe("turn-4");
    const older = await writingMessages(s, page.messages[0].id); expect(older.messages.map(m => m.text)).toEqual(["turn-0", "turn-1", "turn-2", "turn-3"]); expect(older.hasMore).toBe(false);
    await expect(writingMessages(member, page.messages[0].id)).rejects.toMatchObject({ status: 404 });
  });
  it("existing asset references require current project ownership and reserve full capacity before fetch", async () => {
    const asset = await prisma.asset.create({ data: { workspaceId: s.workspaceId, category: "OTHER", fileName: "owned.png", storageKey: "test-only", url: "https://never-fetch.invalid/image", mimeType: "image/png", projectLinks: { create: { projectId: s.projectId } } } });
    const request = { mutationId: randomUUID(), assetId: asset.id, assetSha256: "a".repeat(64), name: "owned image" };
    await expect(uploadWritingReference(otherProject, request)).rejects.toMatchObject({ status: 404 });
    await expect(uploadWritingReference(foreign, request)).rejects.toMatchObject({ status: 404 });
    for (let i = 0; i < 6; i++) {
      const receipt = await uploadWritingReference(s, { ...request, mutationId: randomUUID() });
      expect(receipt.reference.sizeBytes).toBe(10 * 1024 * 1024);
    }
    await expect(uploadWritingReference(s, { ...request, mutationId: randomUUID() })).rejects.toMatchObject({ status: 413 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("failed generation has one model attempt and repeated receipt does not re-enqueue", async () => {
    const request = generate(); const task = await submitWriting(s, request);
    const model = vi.fn(async () => { throw new Error("private upstream value"); });
    await processWritingTask(task.id, { generate: model });
    const receipt = await submitWriting(s, request); expect(receipt.status).toBe("FAILED"); expect(receipt.error).not.toContain("private upstream");
    await processWritingTask(task.id, { generate: model }); expect(model).toHaveBeenCalledTimes(1);
    expect((await writingState(s)).document.revision).toBe(0);
  });
  it("a workspace rate limit includes different editors and archived projects reject writes", async () => {
    await prisma.asyncTask.createMany({ data: Array.from({ length: 15 }, (_, i) => ({ id: `rate-${randomUUID()}`, workspaceId: s.workspaceId, kind: "STUDIO_WRITING", status: "FAILED", refId: s.projectId, expiresAt: new Date(Date.now() + 60000), inputJson: { operation: "GENERATE", request: generate(), userId: i % 2 ? member.userId : s.userId } })) });
    await expect(submitWriting(member, generate())).rejects.toMatchObject({ status: 429 });
    await prisma.project.update({ where: { id: s.projectId }, data: { archivedAt: new Date() } });
    await expect(save(s, 0)).rejects.toMatchObject({ status: 409 });
    expect((await writingState(s)).document.revision).toBe(0);
  });
  it("concurrent different-document submissions cannot jointly exceed a shared workspace rate budget", async () => {
    await prisma.asyncTask.createMany({ data: Array.from({ length: 14 }, () => ({ id: `rate-${randomUUID()}`, workspaceId: s.workspaceId, kind: "STUDIO_WRITING", status: "FAILED", refId: s.projectId, expiresAt: new Date(Date.now() + 60000), inputJson: { operation: "GENERATE", request: generate(), userId: s.userId } })) });
    const results = await Promise.allSettled([submitWriting(member, generate()), submitWriting(otherProject, generate())]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { status: 429 } });
    expect(await prisma.asyncTask.count({ where: { workspaceId: s.workspaceId, kind: "STUDIO_WRITING" } })).toBe(15);
  });
  it.each(["remove-link", "disable"])("existing asset revocation %s blocks cached bytes and post-model persistence", async action => {
    const body = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#336699" } }).png().toBuffer();
    const asset = await prisma.asset.create({ data: { workspaceId: s.workspaceId, category: "OTHER", fileName: "owned.png", storageKey: "", url: "data:image/png;base64," + body.toString("base64"), mimeType: "image/png", projectLinks: { create: { projectId: s.projectId } } } });
    const file = await uploadWritingReference(s, { mutationId: randomUUID(), assetId: asset.id, assetSha256: createHash("sha256").update(body).digest("hex"), name: "owned image" });
    await processWritingTask(file.task.id); expect((await writingTask(s, file.task.id)).status).toBe("SUCCEEDED");
    expect(Buffer.from((await writingReferenceContent(s, file.reference.id)).bytes)).toEqual(body);
    const task = await submitWriting(s, generate(0, { referenceIds: [file.reference.id] }));
    await processWritingTask(task.id, { generate: async () => {
      if (action === "remove-link") await prisma.projectAsset.deleteMany({ where: { assetId: asset.id, projectId: s.projectId } });
      else await prisma.asset.update({ where: { id: asset.id }, data: { availableForGeneration: false } });
      return output();
    } });
    expect((await writingTask(s, task.id)).status).toBe("FAILED");
    await expect(writingReferenceContent(s, file.reference.id)).rejects.toMatchObject({ status: 404 });
    expect((await writingMessages(s)).messages.map(message => message.role)).toEqual(["user"]);
    expect((await writingState(s)).document.revision).toBe(0);
  });
});
