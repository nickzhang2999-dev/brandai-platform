import { describe, expect, it, vi } from "vitest";
vi.mock("../../../packages/db/src/index", () => ({ prisma: {} }));
vi.mock("../src/lib/api", () => ({ ApiException: class extends Error {} }));
vi.mock("../src/lib/studio-project-materials", () => ({ listStudioProjectMaterials: vi.fn() }));
vi.mock("../src/lib/studio-generation-base", () => ({ readStudioCleanBase: vi.fn() }));
vi.mock("../src/lib/studio-generation-artifacts-image", () => ({ artifactDeadline: vi.fn(), inspectArtifactImage: vi.fn(), readArtifactImageBytes: vi.fn() }));
import { buildStudioVisualFidelitySnapshot as build, StudioVisualFidelitySnapshot, STUDIO_VISUAL_FIDELITY_PROMPT } from "../src/lib/studio-visual-fidelity";
import type { BrandRule } from "@brandai/contracts";
const source = { assetId: "asset", sha256: "a".repeat(64), width: 100, height: 100, shapeId: "shape:apple", recipeHash: "b".repeat(64) };
const input = { prompt: "背景改红，左侧苹果保持绿色", brandRules: [] as BrandRule[], editSource: null, referenceAudit: [] };
const rule = (id: string, strength: BrandRule["strength"] = "STRONG"): BrandRule => ({ id, workspaceId: "w", type: "color", strength, status: "CONFIRMED", value: { background: "red" }, summary: "背景为品牌红", evidence: [], createdAt: "2026-11-04", updatedAt: "2026-11-04" });
describe("server-owned studio fidelity snapshot", () => {
  it("keeps full user intent and every actual rule, including weak and prohibited", () => {
    const snapshot = build({ ...input, brandRules: [rule("hard"), rule("weak", "WEAK"), rule("ban", "FORBIDDEN")] });
    expect(snapshot.plan?.constraints.map(c => c.id)).toEqual(["user-request", "user-request-001", "user-request-002", "brand-hard", "brand-weak", "brand-ban"]);
    expect(snapshot.plan?.constraints[0]?.expected).toBe(input.prompt);
    expect(snapshot.plan?.constraints.find(c => c.id === "brand-weak")?.strength).toBe("soft");
    expect(snapshot.plan?.constraints.find(c => c.id === "brand-ban")?.expected).toContain("禁止");
    expect(snapshot.plan?.constraints.find(c => c.id === "brand-hard")?.expected).toContain('"background":"red"');
  });
  it("binds prompt, actual rules, source recipe and reference audit with stable canonical hashing", () => {
    const baseline = build({ ...input, editSource: source, brandRules: [rule("a")] });
    const reordered = rule("a"); reordered.value = Object.fromEntries(Object.entries(reordered.value).reverse());
    expect(build({ ...input, editSource: source, brandRules: [reordered] }).inputSha256).toBe(baseline.inputSha256);
    for (const changed of [ { prompt: "苹果改成黄色" }, { editSource: { ...source, recipeHash: "c".repeat(64) } }, { brandRules: [rule("b")] }, { referenceAudit: [{ assetId: "style", sha256: "d".repeat(64) }] } ]) {
      expect(build({ ...input, editSource: source, brandRules: [rule("a")], ...changed }).inputSha256).not.toBe(baseline.inputSha256);
    }
  });
  it("allows explicit recolouring while preserving other source properties", () => {
    const snapshot = build({ ...input, prompt: "苹果改成黄色", editSource: source });
    const preserve = snapshot.plan?.constraints.find(c => c.id === "edit-preservation-colour");
    expect(preserve?.source).toBe("source");
    expect(preserve?.expected).toContain("本次明确改色或修改要求优先");
    expect(preserve?.expected).toContain("unknown");
    expect(preserve?.expected).toContain("不声称蒙版或像素锁定已执行");
  });
  it("does not turn style references into hard subject-copy constraints", () => {
    const snapshot = build({ ...input, referenceAudit: [{ assetId: "style", source: "asset:style", polarity: "positive", mode: "INSPIRATION", sha256: "d".repeat(64) }] });
    expect(snapshot.plan?.constraints.map(c => c.id)).toEqual(["user-request", "user-request-001", "user-request-002", "reference-context"]);
    expect(snapshot.plan?.constraints.find(c => c.id === "reference-context")?.expected).toContain("风格参考只比较明确要求的风格");
  });
  it("marks oversized inventories unknown instead of truncating or failing generation", () => {
    const tooMany = build({ ...input, brandRules: Array.from({ length: 64 }, (_, i) => rule(String(i))) });
    expect(tooMany.plan).toBeNull(); expect(tooMany.unavailableReason).toBeTruthy();
    expect(build({ ...input, prompt: "x".repeat(4001) }).plan).toBeNull();
    expect(build({ ...input, prompt: "x".repeat(4000) }).plan).not.toBeNull();
    expect(build({ ...input, brandRules: [{ ...rule("long"), value: { content: "x".repeat(4001) } }] }).plan).toBeNull();
  });
  it("image tools use user/tool intent and source, never brand or style constraints", () => {
    const snapshot = build({ ...input, brandRules: [rule("brand")], editSource: source, imageTool: { operation: "remove-background" } });
    expect(snapshot.imageTool).toBe(true);
    expect(snapshot.plan?.constraints.map(c => c.id)).toEqual(["user-request", "user-request-001", "user-request-002", "edit-preservation-colour", "edit-preservation-identity", "edit-preservation-shape", "edit-preservation-logo", "edit-preservation-text", "edit-preservation-count", "edit-preservation-region", "image-tool"]);
    expect(build({ ...input, editSource: source, imageTool: { operation: "remove-background" } }).inputSha256).toBe(snapshot.inputSha256);
    const inpaint = build({ ...input, editSource: source, imageTool: { operation: "inpaint", mask: "data:image/png;base64," + "a".repeat(6000) } });
    expect(inpaint.plan).not.toBeNull();
    expect(JSON.stringify(inpaint.plan)).not.toContain("base64");
  });
  it("rejects snapshot/plan binding mismatches and documents instruction-only protection", () => {
    const snapshot = build(input);
    expect(StudioVisualFidelitySnapshot.safeParse({ ...snapshot, inputSha256: "f".repeat(64) }).success).toBe(false);
    expect(StudioVisualFidelitySnapshot.safeParse({ ...snapshot, plan: null }).success).toBe(false);
    expect(STUDIO_VISUAL_FIDELITY_PROMPT).toContain("不表示已执行蒙版或像素锁定");
  });
});


it("keeps independent clauses and each preservation attribute, with overflow becoming unknown", () => {
  const snapshot = build({ ...input, prompt: "苹果绿色，背景红色；数量三个 and 保留logo且文字清晰", editSource: source });
  expect(snapshot.plan?.constraints.filter(c => c.attribute === "user-request-clause").map(c => c.expected)).toEqual(["苹果绿色", "背景红色", "数量三个", "保留logo", "文字清晰"]);
  expect(snapshot.plan?.constraints.filter(c => c.id.startsWith("edit-preservation-")).length).toBe(7);
  expect(snapshot.plan?.constraints.find(c => c.id === "user-request")?.expected).toBe("苹果绿色，背景红色；数量三个 and 保留logo且文字清晰");
  expect(build({ ...input, prompt: Array.from({ length: 65 }, (_, i) => `要求${i}`).join("；") }).plan).toBeNull();
});
it("rejects invalid or excess reference inventories without silently keeping a subset", () => {
  const ref = { assetId: "ref", sha256: "a".repeat(64), source: "asset:ref", polarity: "positive", mode: "INSPIRATION" };
  const good = build({ ...input, referenceAudit: [ref] });
  expect(good.referenceImages).toEqual([ref]);
  expect(good.plan?.constraints.find(c => c.id === "reference-context")?.source).toBe("source");
  const invalid = build({ ...input, referenceAudit: [{ ...ref, sha256: "bad" }] });
  expect(invalid.plan).toBeNull(); expect(invalid.unavailableReason).toBeTruthy();
  const excess = build({ ...input, referenceAudit: Array.from({ length: 9 }, (_, i) => ({ ...ref, assetId: `ref${i}` })) });
  expect(excess.plan).toBeNull(); expect(excess.referenceImages).toEqual([]);
});

it("binds the full effective constraints while keeping image data out of public plans", () => {
  const constraints = { negativePrompt: ["red apple"], promptAdditions: ["gentle lighting is preferred"], hardBlocks: [{ reason: "forbidden logo", source: "project" }], machineRules: { aspect_ratio: "1:1" }, referenceImages: [{ url: "data:image/png;base64,AAAA", source: "asset:ref", polarity: "positive" as const }] };
  const baseline = build({ ...input, effectiveConstraints: constraints });
  for (const changed of [{ negativePrompt: ["blue apple"] }, { promptAdditions: ["hard shadows"] }, { hardBlocks: [] }, { machineRules: { aspect_ratio: "3:2" } }, { referenceImages: [{ ...constraints.referenceImages[0]!, url: "data:image/png;base64,BBBB" }] }])
    expect(build({ ...input, effectiveConstraints: { ...constraints, ...changed } }).inputSha256).not.toBe(baseline.inputSha256);
  expect(baseline.plan?.constraints.find(c => c.id === "compiled-negative-1")?.expected).toContain("需要避免");
  expect(baseline.plan?.constraints.find(c => c.id === "compiled-block-1")?.expected).toContain("forbidden logo");
  expect(baseline.plan?.constraints.find(c => c.id === "compiled-prompt-1")?.expected).toContain("风格偏好不升级为硬要求");
  expect(JSON.stringify(baseline)).not.toContain("base64");
  expect(build({ ...input, effectiveConstraints: { ...constraints, promptAdditions: ["x".repeat(4001)] } }).plan).toBeNull();
});

it("keeps a twelve-rule plan even when the compiled aggregate exceeds 4000 characters", () => {
  const rules = Array.from({length:12}, (_,index)=>({...rule(`large-${index}`),summary:"保留主体颜色与细节".repeat(45)}));
  const result=build({...input,brandRules:rules,effectiveConstraints:{negativePrompt:[],promptAdditions:rules.map(r=>r.summary),hardBlocks:[],machineRules:{}}});
  expect(result.plan).not.toBeNull();expect(result.plan?.constraints.filter(c=>c.id.startsWith("brand-"))).toHaveLength(12);
  expect(result.plan?.constraints.filter(c=>c.id.startsWith("compiled-prompt-"))).toHaveLength(1);
});
