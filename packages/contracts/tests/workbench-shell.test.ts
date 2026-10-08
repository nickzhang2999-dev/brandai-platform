import { describe, expect, it } from "vitest";
import { WorkbenchArchiveInput, WorkbenchBrandDraft, WorkbenchContextSaveInput, WorkbenchDraftSaveInput,
  WorkbenchProfile, WorkbenchProjectCreateInput, WorkbenchShellSaveInput, WorkbenchShellState } from "../src/workbench-shell";

const profile = { nickname: "真实用户", density: "comfortable", motion: "system" };
const brand = { name: "品牌", colors: ["#7C5CFF", "#171717", "#F4F0FF"], font: "system", notes: "尚未确认的品牌草稿" };
const state = { revision: 0, profile, brand, favorites: ["project_1"] };
const requestId = "ea98d4b7-4898-477f-b1a3-487427b6b14a";

describe("workbench shell wire contracts", () => {
  it("preserves Chinese drafts, explicit null drafts, and maximum supported revisions", () => {
    expect(WorkbenchShellState.parse(state)).toEqual(state);
    expect(WorkbenchProjectCreateInput.parse({ projectName: "  新项目  ", brief: "中文\n需求", requestId }))
      .toEqual({ projectName: "新项目", brief: "中文\n需求", requestId });
    expect(WorkbenchDraftSaveInput.parse({ projectId: "p", revision: 2147483646, inputForm: null }).inputForm).toBeNull();
    expect(WorkbenchContextSaveInput.parse({ projectId: "p", revision: 0, brief: "文".repeat(6000), notes: "注".repeat(4000) }).notes).toHaveLength(4000);
    expect(WorkbenchBrandDraft.parse({ ...brand, name: "  品牌  " }).name).toBe("品牌");
  });

  it.each(["profile", "brand", "favorites"])("requires an explicit %s save group", group => {
    expect(WorkbenchShellSaveInput.parse({ ...state, group }).group).toBe(group);
  });

  it.each([undefined, null, "all", "", 1])("rejects ambiguous save group %j", group => {
    expect(WorkbenchShellSaveInput.safeParse({ ...state, group }).success).toBe(false);
  });

  it.each([-1, 0.5, 2147483647, "1", true, null])("rejects a coerced or invalid revision %j", revision => {
    for (const [schema, value] of [
      [WorkbenchShellSaveInput, { ...state, group: "profile", revision }],
      [WorkbenchContextSaveInput, { projectId: "p", revision, brief: "", notes: "" }],
      [WorkbenchArchiveInput, { projectId: "p", revision, archived: true, projectVersion: "novart-0" }],
      [WorkbenchDraftSaveInput, { projectId: "p", revision, inputForm: null }],
    ] as const) expect(schema.safeParse(value).success).toBe(false);
  });

  it.each([
    { name: " " }, { name: "b".repeat(61) }, { colors: ["#ffffff"] },
    { colors: ["#ffffff", "#000000", "#abc"] }, { colors: ["#ffffff", "#000000", "red"] },
    { colors: ["#ffffff", "#000000", "#abcdef\n"] },
    { font: "remote-font" }, { notes: "n".repeat(2001) }, { verified: true },
  ])("rejects malformed brand input %j", patch => {
    expect(WorkbenchBrandDraft.safeParse({ ...brand, ...patch }).success).toBe(false);
  });

  it("rejects unknown metadata, path-like project ids and missing idempotency keys", () => {
    expect(WorkbenchShellSaveInput.safeParse({ ...state, group: "profile", workspaceId: "other" }).success).toBe(false);
    expect(WorkbenchShellState.safeParse({ ...state, favorites: ["../foreign"] }).success).toBe(false);
    expect(WorkbenchShellState.safeParse({ ...state, favorites: Array(101).fill("p") }).success).toBe(false);
    expect(WorkbenchProfile.safeParse({ ...profile, role: "OWNER" }).success).toBe(false);
    for (const value of [undefined, null, "", "1234", requestId + "\n"]) {
      expect(WorkbenchProjectCreateInput.safeParse({ projectName: "p", brief: "", requestId: value }).success).toBe(false);
    }
    expect(WorkbenchProjectCreateInput.safeParse({ projectName: "p", brief: "x".repeat(6001), requestId }).success).toBe(false);
  });

  it.each(["local-1", "novart-01", "novart--1", "novart-2147483647", "novart-1\n"])("rejects foreign/stale-format archive version %j", projectVersion => {
    expect(WorkbenchArchiveInput.safeParse({ projectId: "p", revision: 0, archived: true, projectVersion }).success).toBe(false);
  });

  it("requires a strict archive boolean and an explicit draft object or null", () => {
    for (const archived of ["true", 1, null]) expect(WorkbenchArchiveInput.safeParse({ projectId: "p", revision: 0, archived, projectVersion: "novart-0" }).success).toBe(false);
    for (const inputForm of [undefined, [], "draft", 1]) expect(WorkbenchDraftSaveInput.safeParse({ projectId: "p", revision: 0, inputForm }).success).toBe(false);
    expect(WorkbenchDraftSaveInput.parse({ projectId: "p", revision: 0, inputForm: { prompt: "中文", resolution: "2K", ratio: "1:1" } }).inputForm?.prompt).toBe("中文");
  });
});
