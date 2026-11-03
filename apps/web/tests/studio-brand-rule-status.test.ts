import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StudioBrandRuleStatus, StudioBrandRuleReceipt } from "../../../packages/contracts/src/studio-brand-rule-status";
const f = vi.hoisted(() => ({ gate: vi.fn(), workspace: vi.fn() }));
vi.mock("../../../packages/db/src/index", () => ({ prisma: { brandWorkspace: { findUnique: f.workspace } } }));
vi.mock("../src/lib/workspace", () => ({ requireWorkspaceRole: f.gate }));
vi.mock("../src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
import { readStudioBrandRuleStatus } from "../src/lib/studio-brand-rule-status";
import { projectBrandRuleReceipt } from "../src/lib/studio-brand-rule-receipt";
import { BrandRuleStatus, brandRuleStatusMessage } from "../src/components/owned-canvas/BrandRuleStatus";
import { GenerationBrandRuleReceipt } from "../src/components/owned-canvas/GenerationBrandRuleReceipt";

beforeEach(() => { vi.resetAllMocks(); f.workspace.mockResolvedValue({ id: "w", name: "品牌甲", tags: [], rules: [{ status: "CONFIRMED" }, { status: "DRAFT" }, { status: "DRAFT" }], workbenchBrand: { revision: 1 } }); });

describe("read-only brand status", () => {
  it("authorizes before querying and keeps draft/confirmed/application state separate", async () => {
    const status = await readStudioBrandRuleStatus("w", "u");
    expect(f.gate).toHaveBeenCalledWith("w", "u", "VIEWER");
    expect(f.workspace.mock.invocationCallOrder[0]).toBeGreaterThan(f.gate.mock.invocationCallOrder[0]);
    expect(f.workspace).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "w" }, select: expect.objectContaining({ rules: { where: { status: { in: ["CONFIRMED", "DRAFT"] } }, select: { status: true } } }) }));
    expect(StudioBrandRuleStatus.parse(status)).toEqual({ workspaceId: "w", brandName: "品牌甲", applicationEnabled: true, confirmedCount: 1, draftCount: 2, savedDraftAvailable: true });
    expect(brandRuleStatusMessage(status)).toContain("1 条已启用");
    expect(brandRuleStatusMessage({ ...status, applicationEnabled: false })).toContain("应用到项目已关闭");
    expect(brandRuleStatusMessage({ ...status, confirmedCount: 0 })).toContain("核对草稿并启用");
    expect(brandRuleStatusMessage({ ...status, confirmedCount: 0, draftCount: 0 })).toContain("导入草稿");
  });
  it("does not read inaccessible brand data or count disabled rules as a deleted library", async () => {
    f.gate.mockRejectedValueOnce({ status: 403 });
    await expect(readStudioBrandRuleStatus("foreign", "u")).rejects.toMatchObject({ status: 403 });
    expect(f.workspace).not.toHaveBeenCalled();
    f.workspace.mockResolvedValueOnce({ id: "w", name: "品牌甲", tags: ["__kb_disabled"], rules: [{ status: "CONFIRMED" }], workbenchBrand: null });
    expect(await readStudioBrandRuleStatus("w", "u")).toMatchObject({ applicationEnabled: false, confirmedCount: 1 });
    f.workspace.mockResolvedValueOnce(null);
    await expect(readStudioBrandRuleStatus("missing", "u")).rejects.toMatchObject({ status: 404 });
  });
  it("offers a workspace-pinned knowledge link without guessing empty state during loading", () => {
    const html = renderToStaticMarkup(React.createElement(BrandRuleStatus, { workspaceId: "a&b", userId: "u" }));
    expect(html).toContain("workspaceId=a%26b"); expect(html).toContain('target="_blank"');
    expect(html).toContain("正在读取"); expect(html).not.toContain("已启用 0");
  });
});

describe("frozen generation evidence", () => {
  const snapshot = { id: "r1", workspaceId: "w", status: "CONFIRMED", type: "color", strength: "STRONG", summary: "生成时的紫色规则", value: { privateEvidence: "never exposed" } };
  const params = () => ({ appliedBrandRuleCount: 1, appliedRuleIds: ["r1"], brandConstraintMode: "BRANDED", brandRuleApplicationReason: "APPLIED", appliedPromptAdditions: ["one", "two"], studioPostprocess: { brandRules: [snapshot] }, privateProviderBody: "secret" });
  it("projects only applied IDs and same-brand frozen summaries, never current library or private params", () => {
    const receipt = projectBrandRuleReceipt({ id: "output", params: params() }, "w");
    expect(StudioBrandRuleReceipt.parse(receipt)).toMatchObject({ appliedRuleCount: 1, detailsComplete: true, promptAdditionCount: 2, rules: [{ id: "r1", summary: snapshot.summary }] });
    expect(JSON.stringify(receipt)).not.toMatch(/never exposed|secret/);
    expect(f.workspace).not.toHaveBeenCalled();
    const foreign = projectBrandRuleReceipt({ id: "output", params: params() }, "other");
    expect(foreign.rules).toEqual([]); expect(foreign.detailsComplete).toBe(false);
    expect(projectBrandRuleReceipt({ id: "output", params: { ...params(), appliedRuleIds: ["missing"] } }, "w")).toMatchObject({ rules: [], detailsComplete: false });
  });
  it("distinguishes unknown historical fields from zero and rejects guessed counts", () => {
    for (const value of [undefined, null, "1", -1, 0.5, true]) {
      expect(projectBrandRuleReceipt({ id: "o", params: { appliedBrandRuleCount: value } }, "w").appliedRuleCount).toBeNull();
    }
    expect(projectBrandRuleReceipt({ id: "o", params: null }, "w")).toMatchObject({ appliedRuleCount: null, rules: [], detailsComplete: false, reason: null, promptAdditionCount: null });
    expect(projectBrandRuleReceipt({ id: "o", params: { appliedBrandRuleCount: 0, appliedRuleIds: [], studioPostprocess: { brandRules: [snapshot] }, brandRuleApplicationReason: "IMAGE_TOOL" } }, "w")).toMatchObject({ appliedRuleCount: 0, rules: [], detailsComplete: true, reason: "IMAGE_TOOL" });
  });
  it("renders historical summaries and explicit uncertainty, with no implied visual compliance", () => {
    const receipt = projectBrandRuleReceipt({ id: "o", params: params() }, "w");
    const html = renderToStaticMarkup(React.createElement(GenerationBrandRuleReceipt, { task: { status: "SUCCEEDED", appliedBrandRuleCount: 1, brandRuleReceipts: [receipt] } }));
    expect(html).toContain(snapshot.summary); expect(html).toContain("图片是否遵守规范仍需检查");
    const old = renderToStaticMarkup(React.createElement(GenerationBrandRuleReceipt, { task: { status: "SUCCEEDED", appliedBrandRuleCount: null } }));
    expect(old).toContain("未记录"); expect(old).not.toContain("未应用");
    const zero = renderToStaticMarkup(React.createElement(GenerationBrandRuleReceipt, { task: { status: "SUCCEEDED", appliedBrandRuleCount: 0, brandRuleReceipts: [projectBrandRuleReceipt({ id: "o", params: { appliedBrandRuleCount: 0 } }, "w")] } }));
    expect(zero).toContain("未记录未应用原因");
  });
});
