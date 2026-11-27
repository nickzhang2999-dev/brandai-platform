import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  transaction: vi.fn(), find: vi.fn(), create: vi.fn(), update: vi.fn(), rules: vi.fn(),
  accept: vi.fn(), read: vi.fn(), enqueue: vi.fn(), context: vi.fn(),
}));
vi.mock("@brandai/db", async load => ({ ...await load<object>(),
  prisma: { $transaction: f.transaction, asyncTask: { findFirst: f.find } },
}));
vi.mock("../src/lib/api", () => ({ ApiException: class extends Error {
  constructor(public status: number, message: string) { super(message); }
} }));
vi.mock("../src/lib/studio-generation", async load => ({ ...await load<object>(),
  acceptStudioGeneration: f.accept, readStudioGeneration: f.read, expireStudioGenerations: vi.fn(),
}));
vi.mock("../src/lib/studio-generation-policy", async load => ({ ...await load<object>(), requireStudioGenerationServices: vi.fn() }));
vi.mock("../src/lib/studio-materials", () => ({ requireStudioMaterialProject: vi.fn() }));
vi.mock("../src/lib/studio-generation-artifacts", () => ({ requireArtifactWrite: vi.fn() }));
vi.mock("../src/lib/studio-generation-edit", () => ({ resolveStudioSelectedMaterial: async () => ({ assetId: "product" }) }));
vi.mock("../src/lib/studio-brand-materials", () => ({ requireTrustedStudioBrandProjectMaterial: async () => ({ fileName: "shirt", width: 100, height: 100 }) }));
vi.mock("../src/lib/studio-project-context", () => ({ freezeStudioProjectContext: f.context }));
vi.mock("../src/lib/rules", () => ({ getConfirmedRules: f.rules }));
vi.mock("../src/lib/studio-generation-queue", () => ({ enqueueStudioGeneration: f.enqueue }));
vi.mock("../src/lib/studio-copywriting-queue", () => ({ enqueueStudioCopywriting: vi.fn() }));

import { confirmPosterAppearance, confirmPosterSet, createPosterBrief } from "../src/lib/sol-poster-brief";
const input = { mutationId: "11111111-1111-4111-8111-111111111111", documentRevision: 1, contextRevision: 1,
  target: { shapeId: "shape:shirt", assetSha256: "a".repeat(64) }, conversation: { message: "夏季海报" } };
const rules = [{ id: "logo", summary: "固定品牌标志", evidence: [{ assetId: "logo-v1" }] },
  { id: "color", summary: "品牌主色", structured: { hex: "#5177aa" } }];
const imageRequestId = "sgr_" + "b".repeat(32);

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("DEEPFLARE_V2_ENABLED", "1");
  vi.stubEnv("DEEPFLARE_V2_WORKSPACE_IDS", "ws");
  vi.stubEnv("DEEPFLARE_V2_NATIVE_DISPATCH", "1");
  vi.stubEnv("SOL_DSH_ENABLED", "1");
  f.context.mockResolvedValue({ materials: [], facts: { goal: "", audience: "students" } });
  const tx = { $queryRaw: vi.fn(), asyncTask: { count: async () => 0, findUnique: vi.fn(), findFirst: f.find, create: f.create, update: f.update },
    editorDocument: { findUnique: async () => ({ workspaceId: "ws", revision: 1, canvas: "canvas" }) },
    workbenchProjectState: { findUnique: async () => null }, brandWorkspace: { findUniqueOrThrow: async () => ({ name: "brand" }) } };
  f.transaction.mockImplementation(callback => callback(tx));
  f.create.mockImplementation(({ data }) => ({ ...data, status: "PENDING", createdAt: new Date(), error: null }));
  f.rules.mockResolvedValue(rules);
  f.accept.mockResolvedValue({ id: imageRequestId, jobData: {} });
});
afterEach(() => vi.unstubAllEnvs());

async function completedBrief(styleAssetId?: string) {
  const brief = await createPosterBrief("ws", "project", "author", {...input, styleAssetId});
  const row = await f.create.mock.results[0]!.value;
  row.status = "SUCCEEDED";
  row.resultJson = { model: "test", choices: { appearance: "正面主视", scene: "陈列台", detail: "引线标注" } };
  f.find.mockResolvedValue(row);
  const confirmation = { action: "confirm-appearance", briefId: brief.id, target: input.target, contextRevision: 1, documentRevision: 1 };
  return { row, confirm: () => confirmPosterAppearance("ws", "project", "author", confirmation) };
}

describe("Sol approval binds the full rule set before reserving a generation", () => {
  it("binds the configured preview planner and the explicitly selected style as the second image", async () => {
    vi.stubEnv("SOL_DSH_ENABLED", "");
    const style = {role:"STYLE", assetId:"style", assetSha256:"c".repeat(64), name:"夏季构图", width:100, height:100, versionId:null};
    f.context.mockResolvedValue({materials:[style],facts:{goal:"",audience:"students"}});
    const {row, confirm} = await completedBrief(style.assetId);
    expect(row.inputJson.planner).toBe("company");
    await confirm();
    expect(f.accept.mock.lastCall?.[4].references.map((r: {assetId:string}) => r.assetId)).toEqual(["product", "style"]);
    f.context.mockResolvedValue({materials:[],facts:{goal:"",audience:"students"}});
    await expect(confirm()).rejects.toMatchObject({status:409});
    expect(f.accept).toHaveBeenCalledTimes(1);
  });
  it("rejects a submitted reference that is not a saved project style", async () => {
    await expect(completedBrief("other-project-style")).rejects.toMatchObject({status:422});
    expect(f.create).not.toHaveBeenCalled();
  });
  it.each([
    { evidence: [{ assetId: "logo-v2" }] },
    { strength: "REQUIRED" },
    { structured: { hex: "#ffffff" } },
  ])("rejects changed rule details under the same summaries", async change => {
    const { confirm } = await completedBrief();
    f.rules.mockResolvedValue([{ ...rules[0], ...change }, rules[1]]);
    await expect(confirm()).rejects.toMatchObject({ status: 409 });
    expect(f.accept).not.toHaveBeenCalled();
  });
  it("requires a new brief for legacy approvals and still reads a previously accepted receipt", async () => {
    const { row, confirm } = await completedBrief();
    delete row.inputJson.brandRulesHash;
    await expect(confirm()).rejects.toMatchObject({ status: 409 });
    row.resultJson.imageRequestId = imageRequestId;
    await confirm();
    expect(f.read).toHaveBeenCalledWith("ws", "author", { projectId: "project", requestId: imageRequestId });
    expect(f.accept).not.toHaveBeenCalled();
  });
  it("returns the saved image receipt when another confirmation commits before a local conflict", async () => {
    const { row, confirm } = await completedBrief();
    f.accept.mockImplementationOnce(async () => {
      row.resultJson.imageRequestId = imageRequestId;
      throw new Error("confirmation outcome unknown");
    });
    await confirm();
    expect(f.read).toHaveBeenCalledWith("ws", "author", {projectId:"project",requestId:imageRequestId});
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it("accepts three distinct deliverables in one transaction and replays all three saved IDs", async()=>{
    const {row}=await completedBrief();
    const ids=["1","2","3"].map(x=>"sgr_"+x.repeat(32));
    ids.forEach(id=>f.accept.mockResolvedValueOnce({id,jobData:{}}));
    f.update.mockImplementationOnce(async({data})=>Object.assign(row,data));
    const command={action:"confirm-set",briefId:row.id,target:input.target,contextRevision:1,documentRevision:1};
    await confirmPosterSet("ws","project","author",command);
    expect(f.accept.mock.calls.map(call=>call[2].prompt)).toEqual([
      expect.stringContaining("商品外观海报"),expect.stringContaining("商品使用场景海报"),expect.stringContaining("商品卖点细节海报")]);
    expect(row.resultJson.imageSet).toEqual({appearance:ids[0],scene:ids[1],detail:ids[2]});
    await confirmPosterSet("ws","project","author",command);
    expect(f.accept).toHaveBeenCalledTimes(3);expect(f.enqueue).toHaveBeenCalledTimes(3);
    expect(f.read.mock.calls.slice(-3).map(x=>x[2].requestId)).toEqual(ids);
  });
  it("keeps a pre-existing appearance and enqueues nothing when quota rejects the last member",async()=>{
    const {row}=await completedBrief();
    row.resultJson.imageRequestId=imageRequestId;
    f.accept.mockResolvedValueOnce({id:"sgr_"+"1".repeat(32),jobData:{}}).mockRejectedValueOnce(new Error("quota"));
    await expect(confirmPosterSet("ws","project","author",{action:"confirm-set",briefId:row.id,target:input.target,contextRevision:1,documentRevision:1})).rejects.toThrow("quota");
    expect(f.accept.mock.calls[0]![2].prompt).toContain("商品使用场景海报");expect(f.update).not.toHaveBeenCalled();expect(f.enqueue).not.toHaveBeenCalled();
  });
  it("blocks an unchosen past campaign before reserving quota",async()=>{
    const {row,confirm}=await completedBrief();
    row.resultJson.sources={search:{kind:"campaign",year:2025,query:"夏季"},candidates:[],currentOnly:false,selected:null};
    await expect(confirm()).rejects.toMatchObject({status:409});
    expect(f.accept).not.toHaveBeenCalled();
  });
  it("accepts unchanged reordered rules in the serializable quota transaction", async () => {
    const { confirm } = await completedBrief();
    f.rules.mockResolvedValue([...rules].reverse());
    await confirm();
    expect(f.transaction).toHaveBeenLastCalledWith(expect.any(Function), { isolationLevel: "Serializable", timeout: 15000 });
    expect(f.accept).toHaveBeenCalledOnce();
    expect(f.update).toHaveBeenCalledWith(expect.objectContaining({ data: { resultJson: expect.objectContaining({ imageRequestId }) } }));
    expect(f.enqueue).toHaveBeenCalledOnce();
  });
});
