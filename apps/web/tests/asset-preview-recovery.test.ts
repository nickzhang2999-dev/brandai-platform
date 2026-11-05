import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
const f=vi.hoisted(()=>({find:vi.fn(),update:vi.fn(),object:vi.fn(),enqueue:vi.fn()}));
vi.mock("@brandai/db",()=>({prisma:{asset:{findUnique:f.find,updateMany:f.update}}}));
vi.mock("@/lib/api",()=>({requireUser:async()=>({id:"user"}),ApiException:class extends Error{constructor(public status:number,message:string){super(message)}},handleError:(e:{status?:number})=>Response.json({error:"unavailable"},{status:e.status??500})}));
vi.mock("@/lib/workspace",()=>({requireOwnedWorkspace:async()=>({})}));
vi.mock("@/lib/ssrf",()=>({safeFetch:vi.fn()}));
vi.mock("@/lib/s3",()=>({getObjectStream:f.object}));
vi.mock("@/lib/settings",()=>({getEffectiveStorage:async()=>({configured:true})}));
vi.mock("@/lib/queue",()=>({enqueueImagePreview:f.enqueue}));
vi.mock("@/lib/studio-decomposition",()=>({readStudioLayerAsset:vi.fn()}));
import { GET } from "../src/app/api/workspaces/[wsId]/assets/[assetId]/raw/route";
const asset={id:"asset",workspaceId:"brand",storageKey:"brand/source.png",previewStorageKey:"previews/brand/missing.webp",url:"",mimeType:"image/png"};
const request=(query="?w=320")=>GET(new Request(`https://example.invalid/raw${query}`),{params:Promise.resolve({wsId:"brand",assetId:"asset"})});
beforeEach(()=>{vi.clearAllMocks();f.find.mockResolvedValue(asset);f.update.mockResolvedValue({count:1});f.enqueue.mockResolvedValue(true)});
describe("derived preview loss recovery",()=>{
  it("invalidates only the missing version and queues a bounded rebuild",async()=>{
    f.object.mockRejectedValue(Object.assign(new Error("private-location"),{name:"NoSuchKey"}));
    const result=await request();expect(result.status).toBe(202);
    expect(f.update).toHaveBeenCalledWith({where:{id:"asset",workspaceId:"brand",previewStorageKey:asset.previewStorageKey},data:{previewStorageKey:null}});
    expect(f.enqueue).toHaveBeenCalledOnce();
  });
  it("never clears metadata or rebuilds for access denial or transport failure",async()=>{
    for(const name of ["AccessDenied","TimeoutError","NoSuchBucket"]){f.object.mockRejectedValue({name});expect((await request()).status).toBe(500)}
    expect(f.update).not.toHaveBeenCalled();expect(f.enqueue).not.toHaveBeenCalled();
  });
  it("reads existing thumbnail bytes and reports a missing original as 404",async()=>{
    f.object.mockResolvedValue({body:Readable.from([Buffer.from("image")])});const response=await request();expect(response.status).toBe(200);expect(await response.text()).toBe("image");
    f.object.mockRejectedValue({name:"NoSuchKey"});expect((await request("")).status).toBe(404);
    expect(f.update).not.toHaveBeenCalled();expect(f.enqueue).not.toHaveBeenCalled();
  });
});
