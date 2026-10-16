import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
const f = vi.hoisted(() => ({ settings:vi.fn(),storage:vi.fn(),auth:vi.fn(),existing:vi.fn(),transaction:vi.fn(),write:vi.fn(),source:vi.fn(),material:vi.fn(),submit:vi.fn(),read:vi.fn(),doc:vi.fn(),state:vi.fn() }));
vi.mock("../../../packages/db/src/index", () => ({ prisma:{$transaction:f.transaction,studioGenerationRequest:{findUnique:f.existing}} }));
vi.mock("../src/lib/api", () => ({ ApiException:class extends Error { constructor(public status:number,message:string){super(message);} } }));
vi.mock("../src/lib/settings", () => ({getEffectiveAiSettings:f.settings,getEffectiveStorage:f.storage}));
vi.mock("../src/lib/studio-materials", () => ({requireStudioMaterialProject:f.auth}));
vi.mock("../src/lib/studio-generation-edit", () => ({resolveStudioEditSource:f.source}));
vi.mock("../src/lib/studio-brand-materials", () => ({requireTrustedStudioBrandProjectMaterial:f.material}));
vi.mock("../src/lib/studio-generation-artifacts", () => ({requireArtifactWrite:f.write}));
vi.mock("../src/lib/studio-generation", () => ({submitStudioGeneration:f.submit,readStudioGeneration:f.read}));
vi.mock("../src/lib/studio-generation-policy", () => ({hashStudioPayload:(input:unknown)=>createHash("sha256").update(JSON.stringify(input)).digest("hex")}));
import { studioImageToolCapabilities, submitStudioImageTool, assertStudioToolMaskHeader } from "../src/lib/studio-image-tools";
import { hashStudioPayload } from "../src/lib/studio-generation-policy";
const input = {projectId:"p",mutationId:"831a0280-2cf1-41ba-ac94-621053c4a4c6",documentRevision:2,workflowRevision:1,target:{shapeId:"shape:source",assetSha256:"a".repeat(64)},operation:"remove-background" as const};
const tx = {editorDocument:{findUnique:f.doc},workbenchProjectState:{findUnique:f.state}};
beforeEach(()=>{
  vi.resetAllMocks();vi.unstubAllEnvs();
  vi.stubEnv("STUDIO_IMAGE_TOOLS_ENABLED","1");vi.stubEnv("STUDIO_BACKGROUND_REMOVAL_ENABLED","1");vi.stubEnv("STUDIO_INPAINT_ENABLED","1");
  f.settings.mockResolvedValue({image:{provider:"openai",model:"gpt-image-2",apiKey:"unit-key-not-real"}});f.storage.mockResolvedValue({configured:true});f.existing.mockResolvedValue(null);f.transaction.mockImplementation(fn=>fn(tx));
  f.doc.mockResolvedValue({workspaceId:"w",revision:2,canvas:"saved-authoritative-canvas"});f.state.mockResolvedValue({workspaceId:"w",workflowRevision:1});
  f.source.mockResolvedValue({snapshot:{assetId:"asset",shapeId:"shape:source",sha256:"a".repeat(64),width:96,height:64}});
  f.material.mockResolvedValue({fileName:"已验证品牌素材"});f.submit.mockResolvedValue({requestId:"accepted",status:"PENDING"});f.read.mockResolvedValue({requestId:"original",status:"RUNNING"});
});
describe("image tool intake (synthetic DB dependency tests, zero provider calls)",()=>{
  it("freezes the authenticated shape and actual pixels into the existing durable generation intake",async()=>{
    await expect(submitStudioImageTool("w","u",input)).resolves.toMatchObject({requestId:"accepted"});
    expect(f.auth).toHaveBeenCalledWith("w","u","p",true);expect(f.write).toHaveBeenCalledWith(tx,"w","p","u");
    expect(f.source).toHaveBeenCalledWith(tx,"w","p",input.target,"saved-authoritative-canvas",true);
    expect(f.material).toHaveBeenCalledWith(tx,"w","p","asset","a".repeat(64));
    const accepted=f.submit.mock.calls[0][3];expect(accepted.imageTool).toEqual({operation:"remove-background"});expect(accepted.intent).toMatchObject({action:"modify",targetReferenceId:"tool-target",requestedSize:{width:96,height:64},referenceIds:[]});
    expect(accepted.imageToolInputHash).toBe(hashStudioPayload(input));
  });
  it("keeps unverified provider capabilities disabled and never exposes key or URL",async()=>{
    vi.stubEnv("STUDIO_BACKGROUND_REMOVAL_ENABLED","");const caps=await studioImageToolCapabilities();expect(caps.removeBackground.available).toBe(false);expect(caps.inpaint.available).toBe(true);expect(JSON.stringify(caps)).not.toMatch(/unit-key|baseUrl|apiKey/);
    await expect(submitStudioImageTool("w","u",input)).rejects.toMatchObject({status:503});expect(f.submit).not.toHaveBeenCalled();
    f.settings.mockResolvedValue({image:{provider:"mock",model:"gpt-image-2",apiKey:"x"}});expect((await studioImageToolCapabilities()).inpaint.available).toBe(false);
  });
  it("does not call a paid service twice after a lost response or a newer canvas",async()=>{
    f.existing.mockResolvedValue({id:"original",jobData:{studioImageToolInputHash:hashStudioPayload(input)}});
    f.doc.mockResolvedValue({workspaceId:"w",revision:999,canvas:"newer"});
    await expect(submitStudioImageTool("w","u",input)).resolves.toMatchObject({requestId:"original"});
    expect(f.submit).not.toHaveBeenCalled();expect(f.transaction).not.toHaveBeenCalled();expect(f.read).toHaveBeenCalledWith("w","u",{projectId:"p",requestId:"original"});
  });
  it("rejects nonce reuse for another operation or a legacy generation request",async()=>{
    f.existing.mockResolvedValue({id:"original",jobData:{studioImageToolInputHash:"different"}});
    await expect(submitStudioImageTool("w","u",input)).rejects.toMatchObject({status:409});expect(f.submit).not.toHaveBeenCalled();
  });
  it("rejects stale revisions, unauthorized sources and foreign project state before intake",async()=>{
    f.doc.mockResolvedValue({workspaceId:"w",revision:3,canvas:"saved"});await expect(submitStudioImageTool("w","u",input)).rejects.toMatchObject({status:409});expect(f.submit).not.toHaveBeenCalled();
    f.doc.mockResolvedValue({workspaceId:"other",revision:2,canvas:"saved"});await expect(submitStudioImageTool("w","u",input)).rejects.toMatchObject({status:409});
    f.doc.mockResolvedValue({workspaceId:"w",revision:2,canvas:"saved"});f.material.mockRejectedValue(Object.assign(new Error("foreign asset"),{status:403}));await expect(submitStudioImageTool("w","u",input)).rejects.toMatchObject({status:403});expect(f.submit).not.toHaveBeenCalled();
  });
  it("rejects malformed or wrong-sized PNG headers without decoding in the HTTP intake",()=>{
    expect(()=>assertStudioToolMaskHeader("data:image/png;base64,AAAA",96,64)).toThrow();
    const bytes=Buffer.alloc(33);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);bytes.writeUInt32BE(13,8);bytes.write("IHDR",12);bytes.writeUInt32BE(96,16);bytes.writeUInt32BE(63,20);
    expect(()=>assertStudioToolMaskHeader("data:image/png;base64,"+bytes.toString("base64"),96,64)).toThrow();
  });
});
