import { describe, expect, it } from "vitest";
import { WorkbenchArchiveInput, WorkbenchBrandDraft, WorkbenchContextSaveInput, WorkbenchDraftSaveInput, WorkbenchDraftView,
  WorkbenchProfile, WorkbenchProjectCreateInput, WorkbenchShellSaveInput, WorkbenchShellState } from "../src/workbench-shell";
import { NativeProjectQueryInput } from "../src/native-project";

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
    for (const inputForm of [undefined, [], "draft", 1, {}, { prompt: "unrestorable" }, { text: null }, { text: 1 }]) expect(WorkbenchDraftSaveInput.safeParse({ projectId: "p", revision: 0, inputForm }).success).toBe(false);
    const inputForm = { text: "中文", resolution: "2K", ratio: "1:1", lexicalJSONState: { root: { children: [] } } };
    expect(WorkbenchDraftSaveInput.parse({ projectId: "p", revision: 0, inputForm }).inputForm).toEqual(inputForm);
    expect(WorkbenchDraftSaveInput.parse({ projectId: "p", revision: 0, inputForm: { text: "" } }).inputForm?.text).toBe("");
  });

  it("keeps cid at the native boundary and rejects it on each shell save", () => {
    expect(NativeProjectQueryInput.parse({ projectId: "p", cid: "native-request" }).cid).toBe("native-request");
    for (const [schema, value] of [
      [WorkbenchContextSaveInput, { projectId: "p", revision: 0, brief: "", notes: "" }],
      [WorkbenchArchiveInput, { projectId: "p", revision: 0, archived: true, projectVersion: "novart-0" }],
      [WorkbenchDraftSaveInput, { projectId: "p", revision: 0, inputForm: null }],
    ] as const) for (const cid of ["native-request", null]) expect(schema.safeParse({ ...value, cid }).success).toBe(false);
  });

  it("requires the same complete receipt for empty, saved and cleared drafts", () => {
    const empty = { projectId: "p", revision: 0, inputForm: null, updatedAt: null, referenceIssues: [] };
    expect(WorkbenchDraftView.parse(empty)).toEqual(empty);
    const saved = { ...empty, revision: 1, inputForm: { text: "中文\n草稿", model: "preferred" }, updatedAt: 1791417600000 };
    expect(WorkbenchDraftView.parse(saved)).toEqual(saved);
    expect(WorkbenchDraftView.parse({ ...saved, revision: 2147483647, inputForm: null }).revision).toBe(2147483647);
    for (const field of Object.keys(empty)) {
      const missing: Record<string, unknown> = { ...empty }; delete missing[field];
      expect(WorkbenchDraftView.safeParse(missing).success).toBe(false);
    }
    for (const patch of [
      { referenceIssues: null }, { referenceIssues: {} }, { referenceIssues: [null] }, { referenceIssues: [{}] },
      { revision: true }, { revision: 2147483648 }, { updatedAt: -1 }, { updatedAt: "1791417600000" },
      { updatedAt: Number.MAX_SAFE_INTEGER + 1 }, { inputForm: { prompt: "wrong field" } }, { cid: "unexpected" },
    ]) expect(WorkbenchDraftView.safeParse({ ...saved, ...patch }).success).toBe(false);
  });

  it("validates reference issue identities and hashes without silently defaulting missing fields", () => {
    const issue = { code: "UNAVAILABLE_REFERENCE", message: "引用无法读取", label: "图片引用", assetSha256: "a".repeat(64), identity: null };
    const view = { projectId: "p", revision: 1, inputForm: { text: "引用" }, updatedAt: 1, referenceIssues: [issue] };
    expect(WorkbenchDraftView.parse(view).referenceIssues).toEqual([issue]);
    for (const identity of [{ kind: "key", value: "mention-1" }, { kind: "elementId", value: "shape-1" }]) {
      expect(WorkbenchDraftView.parse({ ...view, referenceIssues: [{ ...issue, identity }] }).referenceIssues[0].identity).toEqual(identity);
    }
    for (const patch of [
      { identity: undefined }, { identity: { kind: "assetId", value: "a" } }, { identity: { kind: "key", value: 1 } },
      { assetSha256: "a".repeat(63) }, { assetSha256: "a".repeat(64) + "\n" }, { message: 1 }, { extra: true },
    ]) expect(WorkbenchDraftView.safeParse({ ...view, referenceIssues: [{ ...issue, ...patch }] }).success).toBe(false);
  });
});
