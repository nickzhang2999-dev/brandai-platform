import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { StudioWorkflowAssets, StudioWorkflowIssue, StudioWorkflowSaveInput, StudioWorkflowView } from "../src/studio-workflow";
import { workflowAssets, workflowIssues, assertWorkflowSelection } from "../../../apps/web/src/lib/studio-workflow-codec";

const sha = "a".repeat(64), other = "b".repeat(64), url = "/api/workspaces/w/assets/a/raw";
const material = { sha256: sha, url, mimeType: "image/png" };
const ref = { shapeId: "shape:image", assetSha256: sha, purpose: "REFERENCE" as const, participates: true };
const input = { projectId: "p", revision: 0, mode: "generate" as const, target: null, references: [ref] };
const canvas = (store: unknown) => "SHAKKERDATA://" + gzipSync(JSON.stringify({ tldrawSnapshot: { document: { schema: {}, store } } })).toString("base64");
const image = (props = { url, w: 100, h: 50, name: "真实图片" }) => ({ id: "shape:image", typeName: "shape", type: "c-image", props });

describe("workflow wire contracts", () => {
  it("requires explicit reference purpose and exact modify target semantics", () => {
    expect(StudioWorkflowSaveInput.parse(input)).toEqual(input);
    expect(StudioWorkflowSaveInput.safeParse({ ...input, mode: "modify" }).success).toBe(false);
    const target = { shapeId: ref.shapeId, assetSha256: sha };
    expect(StudioWorkflowSaveInput.safeParse({ ...input, target }).success).toBe(false);
    expect(StudioWorkflowSaveInput.safeParse({ ...input, mode: "modify", target }).success).toBe(true);
    expect(StudioWorkflowSaveInput.safeParse({ ...input, references: [{ ...ref, purpose: null }] }).success).toBe(false);
    expect(StudioWorkflowSaveInput.safeParse({ ...input, references: [{ ...ref, shapeId: null, purpose: null, participates: false }] }).success).toBe(true);
  });
  it("rejects duplicate identities, excessive references and unknown transport/identity fields", () => {
    for (const extra of [{ cid: "client" }, { workspaceId: "other" }, { userId: "owner" }, { references: [ref, ref] },
      { references: Array.from({ length: 9 }, (_, i) => ({ ...ref, shapeId: `shape:${i}` })) }]) {
      expect(StudioWorkflowSaveInput.safeParse({ ...input, ...extra }).success).toBe(false);
    }
    expect(StudioWorkflowSaveInput.safeParse({ ...input, references: [ref, { ...ref, shapeId: "shape:other" }] }).success).toBe(true);
  });
  it("bounds canonical shape/hash/project IDs and revision overflow", () => {
    for (const revision of [-1, 0.1, null, "0", true, 2147483647]) expect(StudioWorkflowSaveInput.safeParse({ ...input, revision }).success).toBe(false);
    for (const projectId of ["", "../p", "p\n", "x".repeat(129)]) expect(StudioWorkflowSaveInput.safeParse({ ...input, projectId }).success).toBe(false);
    for (const shapeId of ["shape:", "shape:image\n", "shape:含中文", "shape:two words"]) expect(StudioWorkflowSaveInput.safeParse({ ...input, references: [{ ...ref, shapeId }] }).success).toBe(false);
    for (const assetSha256 of [sha.toUpperCase(), sha + "\n", "not-a-hash"]) expect(StudioWorkflowSaveInput.safeParse({ ...input, references: [{ ...ref, assetSha256 }] }).success).toBe(false);
    expect(StudioWorkflowView.safeParse({ ...input, revision: 2147483647, updatedAt: null, issues: [] }).success).toBe(true);
  });
  it("keeps nullable vs optional boundaries explicit in views and issues", () => {
    const issue = { code: "MISSING", scope: "reference", shapeId: null, assetSha256: sha, message: "图片缺失", blocking: true };
    expect(StudioWorkflowIssue.safeParse(issue).success).toBe(true);
    expect(StudioWorkflowIssue.safeParse({ ...issue, index: null }).success).toBe(false);
    expect(StudioWorkflowIssue.safeParse({ ...issue, index: 8 }).success).toBe(false);
    expect(StudioWorkflowView.safeParse({ ...input, issues: [] }).success).toBe(false);
    const asset = { shapeId: ref.shapeId, assetSha256: sha, name: "图片", width: null, height: 50, valid: true, mime: "image/png" };
    expect(StudioWorkflowAssets.safeParse({ projectId: "p", assets: [asset], issues: [] }).success).toBe(true);
    for (const width of [0, -1, "50", Infinity]) expect(StudioWorkflowAssets.safeParse({ projectId: "p", assets: [{ ...asset, width }], issues: [] }).success).toBe(false);
  });
});

describe("saved native image to workflow association", () => {
  it("uses the exact saved c-image URL and authentic material hash, preserving native shape IDs", () => {
    const result = workflowAssets("p", canvas({ "shape:image": image(), "shape:text": { id: "shape:text", typeName: "shape", type: "text", props: { text: sha } } }), [material]);
    expect(result.assets).toEqual([{ shapeId: ref.shapeId, assetSha256: sha, name: "真实图片", width: 100, height: 50, valid: true, mime: "image/png" }]);
    expect(result.issues).toEqual([]);
  });
  it("does not authorize a matching basename, client hash, other URL or unknown image", () => {
    for (const imageUrl of [`https://untrusted.invalid/${sha}.png`, `${url}?token=x`, "/api/workspaces/other/assets/a/raw"]) {
      const result = workflowAssets("p", canvas({ "shape:image": { ...image(), props: { url: imageUrl, assetSha256: sha } } }), [material]);
      expect(result.assets).toEqual([]); expect(result.issues).toMatchObject([{ code: "UNVERIFIED_MATERIAL", blocking: true }]);
    }
  });
  it("reports malformed c-image records instead of silently dropping them", () => {
    for (const invalid of [{ ...image(), id: "shape:other" }, { ...image(), props: null }, { ...image(), props: [] }]) {
      expect(workflowAssets("p", canvas({ "shape:image": invalid }), [material]).issues).toMatchObject([{ code: "INVALID_IMAGE_SHAPE", shapeId: null, blocking: true }]);
    }
    expect(workflowAssets("p", "", [material])).toEqual({ projectId: "p", assets: [], issues: [] });
  });
  it("does not guess a hash when stored records disagree about the same image URL", () => {
    const result = workflowAssets("p", canvas({ "shape:image": image() }), [material, { ...material, sha256: other }, material]);
    expect(result.assets).toEqual([]);
    expect(result.issues).toMatchObject([{ code: "AMBIGUOUS_MATERIAL", assetSha256: null, blocking: true }]);
  });
  it("retains missing/replaced references with blocking matching participation", () => {
    const asset = workflowAssets("p", canvas({ "shape:image": image() }), [material]).assets[0];
    expect(workflowIssues(input, [asset])).toEqual([]);
    expect(workflowIssues(input, [{ ...asset, assetSha256: other }])).toMatchObject([{ code: "SHAPE_ASSET_CHANGED", index: 0, blocking: true }]);
    expect(workflowIssues({ references: [{ ...ref, participates: false }], target: null }, [])).toMatchObject([{ code: "REFERENCE_MISSING", blocking: false }]);
    expect(workflowIssues({ references: [], target: { shapeId: ref.shapeId, assetSha256: sha } }, [])).toMatchObject([{ scope: "target", blocking: true }]);
  });
  it("allows retaining/disabling old unavailable references but never introducing or re-enabling them", () => {
    expect(assertWorkflowSelection(input, input, [])).toBe(true);
    expect(assertWorkflowSelection(input, { ...input, references: [] }, [])).toBe(false);
    const disabled = { ...input, references: [{ ...ref, participates: false }] };
    expect(assertWorkflowSelection(disabled, input, [])).toBe(true);
    expect(assertWorkflowSelection(input, disabled, [])).toBe(false);
    const modifying = { ...input, mode: "modify" as const, target: { shapeId: ref.shapeId, assetSha256: sha } };
    expect(assertWorkflowSelection(modifying, modifying, [])).toBe(true);
    expect(assertWorkflowSelection(modifying, input, [])).toBe(false);
  });
});
