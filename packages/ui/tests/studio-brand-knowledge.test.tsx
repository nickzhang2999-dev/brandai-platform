import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// Exercise the web component with its existing query dependency; no package/lockfile changes are needed.
import { QueryClient, QueryClientProvider } from "../../../apps/web/node_modules/@tanstack/react-query";
import { BrandKnowledgeEditor } from "../../../apps/web/src/components/brand-knowledge/BrandKnowledgeEditor";
import { DraftImportPanel } from "../../../apps/web/src/components/brand-knowledge/DraftImportPanel";
import { apiFetch, ApiFetchError } from "../../../apps/web/src/lib/client";

vi.mock("../../../apps/web/src/lib/client", async load => ({ ...await load<typeof import("../../../apps/web/src/lib/client")>(), apiFetch: vi.fn() }));
const api = vi.mocked(apiFetch);
const rule = (id: string, type: "copy" | "graphic") => ({ id, workspaceId: "brand-a", type, strength: "WEAK", status: "DRAFT", summary: `Rule ${id}`, value: {}, evidence: [], createdAt: "2026-10-12T00:00:00Z", updatedAt: "2026-10-12T00:00:00Z" });
function harness(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  return { client, ...render(<QueryClientProvider client={client}>{children}</QueryClientProvider>) };
}
beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear(); history.replaceState({}, "", "/studio-brand-knowledge?workspaceId=brand-a&embedded=1");
  api.mockImplementation(async url => {
    if (url === "/api/workspaces/brand-a") return { workspace: { id: "brand-a", name: "Test brand", tags: [] } } as never;
    if (url === "/api/workspaces/brand-a/rules") return [rule("copy", "copy"), rule("graphic", "graphic")] as never;
    if (url.startsWith("/api/studio/brand-knowledge/import-draft?")) return { available: true, draftRevision: 7, importableTypes: ["color", "font"], hasNotes: true } as never;
    if (url.endsWith("/rules/snapshots")) return { snapshots: [] } as never;
    if (url.endsWith("/terms") || url.endsWith("/prohibitions") || url.includes("/assets?")) return [] as never;
    throw new Error(`Unexpected local test request: ${url}`);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("shared knowledge UI (local interaction only, no provider)", () => {
  it("keeps a viewer pinned to the explicit brand and exposes copy/graphic without write controls", async () => {
    document.cookie = "brandai-active-brand=brand-b";
    harness(<BrandKnowledgeEditor wsId="brand-a" userId="user-a" brandName="Test brand" role="VIEWER" embedded />);
    await screen.findAllByText("Rule copy"); await screen.findAllByText("Rule graphic");
    expect((screen.getByRole("checkbox", { name: "应用品牌知识到项目" }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "手动添加规则" })).toBeNull();
    expect(screen.queryByText("规则操作")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "禁用项与词库" }));
    await screen.findByText("暂无词条。");
    expect(screen.queryByRole("button", { name: "添加词条" })).toBeNull();
    expect(api.mock.calls.every(([url, init]) => !url.includes("brand-b") && !init?.method)).toBe(true);
  });
  it("lets an editor manually add a copy draft using the existing workspace API", async () => {
    harness(<BrandKnowledgeEditor wsId="brand-a" userId="user-a" brandName="Test brand" role="EDITOR" />);
    await screen.findAllByText("Rule copy");
    fireEvent.click(screen.getByRole("button", { name: "手动添加规则" }));
    fireEvent.change(screen.getByLabelText("新规则说明"), { target: { value: "Use precise language" } });
    fireEvent.click(screen.getByRole("button", { name: "保存为草稿" }));
    await waitFor(() => expect(api.mock.calls.some(([url, init]) => url === "/api/workspaces/brand-a/rules" && init?.method === "POST" && JSON.parse(String(init.body)).type === "copy")).toBe(true));
  });
  it("keeps image import available after rules exist and cancels a replacement without writing", async () => {
    const confirmed = { ...rule("old-copy", "copy"), status: "CONFIRMED" };
    const original = api.getMockImplementation()!;
    api.mockImplementation(async (url, init) => url === "/api/workspaces/brand-a/rules" && !init?.method
      ? [confirmed, rule("new-copy", "copy")] as never : original(url, init));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    harness(<BrandKnowledgeEditor wsId="brand-a" userId="user-a" brandName="Test brand" role="EDITOR" />);
    await screen.findAllByText("Rule new-copy");
    fireEvent.click(screen.getByRole("button", { name: "上传Logo素材" }));
    expect(await screen.findByRole("dialog", { name: "添加你的品牌 Logo" })).toBeTruthy();
    fireEvent.click(within(screen.getByRole("dialog", { name: "添加你的品牌 Logo" })).getByRole("button", { name: "关闭" }));
    const menu = screen.getAllByText("规则操作")[1]!.closest("details")!;
    menu.open = true;
    fireEvent.click(within(menu).getByRole("button", { name: "启用" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("替换同类别已启用的 1 条规则"));
    expect(api.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });
  it("retries a lost import receipt with the same mutation and original revision after the draft changes", async () => {
    let posted = 0;
    api.mockImplementation(async (_url, init) => {
      if (init?.method === "POST") {
        posted += 1;
        if (posted === 1) throw new ApiFetchError("Receipt unavailable", 0);
        const body = JSON.parse(String(init.body));
        return { mutationId: body.mutationId, draftRevision: body.expectedDraftRevision, ruleIds: ["one", "two"], created: 2, replayed: true, notesPreserved: true } as never;
      }
      return { available: true, draftRevision: posted ? 8 : 7, importableTypes: ["color", "font"], hasNotes: true } as never;
    });
    const onImported = vi.fn(); const { client } = harness(<DraftImportPanel wsId="brand-a" userId="user-a" canEdit onImported={onImported} />);
    await waitFor(() => expect((screen.getByRole("button", { name: "导入为待确认规则" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "导入为待确认规则" }));
    await screen.findByText("Receipt unavailable");
    client.setQueryData(["knowledge-draft-import", "brand-a", "user-a"], { available: true, draftRevision: 8, importableTypes: ["color", "font"], hasNotes: true });
    fireEvent.click(screen.getByRole("button", { name: "重试原导入请求" }));
    await waitFor(() => expect(onImported).toHaveBeenCalledOnce());
    const requests = api.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(requests).toHaveLength(2); expect(requests[1]![1]?.body).toBe(requests[0]![1]?.body);
    expect(JSON.parse(String(requests[1]![1]?.body)).expectedDraftRevision).toBe(7);
  });
});
