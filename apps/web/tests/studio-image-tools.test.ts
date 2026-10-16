import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { StudioImageToolInput, StudioImageToolSpec } from "../../../packages/contracts/src/studio-image-tools";
vi.mock("../src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("../src/lib/studio-generation-artifacts-image", () => ({ STUDIO_ARTIFACT_MAX_BYTES:32*1024*1024, artifactDeadline:async <T>(work:Promise<T>,signal:AbortSignal)=>{signal.throwIfAborted();return work;} }));
import { requireStudioTransparentForeground } from "../src/lib/studio-image-tool-alpha";
const input = { projectId:"p",mutationId:"831a0280-2cf1-41ba-ac94-621053c4a4c6",documentRevision:1,workflowRevision:0,
  target:{shapeId:"shape:source",assetSha256:"a".repeat(64)},operation:"remove-background" as const };
describe("strict image-tool transport and actual PNG alpha", () => {
  it("accepts an explicit saved target, rejects arbitrary URLs and extra image sources", () => {
    expect(StudioImageToolInput.parse(input)).toEqual(input);
    expect(StudioImageToolInput.safeParse({...input,url:"https://unit.invalid/a.png"}).success).toBe(false);
    expect(StudioImageToolInput.safeParse({...input,documentRevision:-1}).success).toBe(false);
    expect(StudioImageToolInput.safeParse({...input,target:{shapeId:"shape:source",assetSha256:"changed"}}).success).toBe(false);
  });
  it("distinguishes background removal from mask editing; null and remote masks never pass", () => {
    expect(StudioImageToolSpec.safeParse({operation:"inpaint"}).success).toBe(false);
    expect(StudioImageToolSpec.safeParse({operation:"remove-background",mask:null}).success).toBe(false);
    expect(StudioImageToolSpec.safeParse({operation:"remove-background",mask:"data:image/png;base64,AAAA"}).success).toBe(false);
    expect(StudioImageToolSpec.safeParse({operation:"inpaint",mask:"https://unit.invalid/mask.png"}).success).toBe(false);
  });
  it("accepts a decoded PNG with both actual transparent pixels and foreground", async () => {
    const opaque = await sharp({create:{width:16,height:16,channels:4,background:{r:20,g:30,b:40,alpha:1}}}).png().toBuffer();
    const body=await sharp({create:{width:32,height:32,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).composite([{input:opaque,left:8,top:8}]).png().toBuffer();
    await expect(requireStudioTransparentForeground(body,AbortSignal.timeout(3000))).resolves.toBeUndefined();
  });
  it.each([0,1])("rejects all-transparent or opaque-white alpha=%s", async alpha => {
    const body=await sharp({create:{width:32,height:32,channels:4,background:{r:255,g:255,b:255,alpha}}}).png().toBuffer();
    await expect(requireStudioTransparentForeground(body,AbortSignal.timeout(3000))).rejects.toMatchObject({status:422});
  });
  it("rejects JPEG/no alpha and respects an already cancelled operation", async () => {
    const body=await sharp({create:{width:32,height:32,channels:3,background:"white"}}).jpeg().toBuffer();
    await expect(requireStudioTransparentForeground(body,AbortSignal.timeout(3000))).rejects.toMatchObject({status:422});
    const stop=new AbortController();stop.abort(new Error("cancelled"));await expect(requireStudioTransparentForeground(body,stop.signal)).rejects.toThrow("cancelled");
  });
});
