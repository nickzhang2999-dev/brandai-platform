import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ messages: vi.fn(), materials: vi.fn(), projects: vi.fn() }));
vi.mock("../../db/src/index", () => ({ prisma: { studioConversationMessage: { findMany: f.messages }, studioBrandMaterialReceipt: { findMany: f.materials }, project: { findMany: f.projects } } }));
import { listStudioWorkflowNotifications } from "../../../apps/web/src/lib/studio-workflow-notifications";
const now = new Date("2026-10-14T04:00:00Z");
const message = () => ({ id: "m", status: "CLARIFICATION", updatedAt: now, conversation: { workspaceId: "w", userId: "u", projectId: "p" } });
const material = () => ({ assetId: "a", workspaceId: "w", userId: "u", updatedAt: now, asset: { workspaceId: "w", deprecatedAt: null }, task: { status: "SUCCEEDED", updatedAt: now } });
beforeEach(() => { vi.resetAllMocks(); f.messages.mockResolvedValue([message()]); f.materials.mockResolvedValue([material()]); f.projects.mockResolvedValue([{ id: "p", workspaceId: "w" }]); });
describe("actor-private conversation and material notifications", () => {
  it("bounds private queries and selects no prompts/masks/provider responses", async () => {
    const items = await listStudioWorkflowNotifications("w", "u", 2); expect(items).toHaveLength(2);
    expect(f.messages.mock.calls[0]![0].where).toMatchObject({ conversation: { workspaceId: "w", userId: "u" }, generationRequestId: null });
    expect(f.materials.mock.calls[0]![0].where).toMatchObject({ workspaceId: "w", userId: "u", asset: { workspaceId: "w" } });
    for (const [query] of [...f.messages.mock.calls, ...f.materials.mock.calls]) { expect(query.take).toBe(2); expect(JSON.stringify(query.select)).not.toMatch(/text|references|input|mask|error|url/); }
    expect(items[0]).toMatchObject({ title: "设计需求需要确认", href: "/studio?workspaceId=w#/workspace/p" });
  });
  it("rejects cross-brand/cross-actor rows and deleted projects even under bad query adapters", async () => {
    f.messages.mockResolvedValue([{ ...message(), conversation: { ...message().conversation, userId: "other" } }]);
    f.materials.mockResolvedValue([{ ...material(), asset: { ...material().asset, workspaceId: "other" } }]);
    expect(await listStudioWorkflowNotifications("w", "u", 30)).toEqual([]);
    f.messages.mockResolvedValue([message()]); f.projects.mockResolvedValue([]); expect(await listStudioWorkflowNotifications("w", "u", 30)).toEqual([]);
  });
  it("does not expose a deprecated material or invent model success", async () => {
    f.materials.mockResolvedValue([{ ...material(), asset: { ...material().asset, deprecatedAt: now } }]);
    const items = await listStudioWorkflowNotifications("w", "u", 30); expect(items).toHaveLength(1); expect(items[0]!.detail).toContain("尚未调用");
  });
  it("zero limit performs no query", async () => { expect(await listStudioWorkflowNotifications("w", "u", 0)).toEqual([]); expect(f.messages).not.toHaveBeenCalled(); });
});
