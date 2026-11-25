import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(()=>({ session:vi.fn(), request:vi.fn(),asset:vi.fn() }));
vi.mock("@/auth",()=>({auth:vi.fn()}));
vi.mock("@/lib/studio-session",()=>({studioSession:mocks.session}));
vi.mock("@brandai/db",()=>({prisma:{studioGenerationRequest:{findFirst:mocks.request},studioGeneratedMaterial:{findFirst:mocks.asset}}}));
import { POST } from "../src/app/studio/delivery-observation/route";
const rid="sgr_"+"a".repeat(32);
const post=(body:object)=>POST(new Request("https://preview.example/studio/delivery-observation",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}));
afterEach(()=>{vi.unstubAllEnvs();vi.resetAllMocks();});
it("discards an inactive observation before doing any lookup",async()=>{
 vi.stubEnv("DF_STUDIO_DELIVERY_TRACE","0");
 expect((await post({})).status).toBe(204);expect(mocks.session).not.toHaveBeenCalled();
});
it("rejects unassociated material and never logs a visible event for it",async()=>{
 vi.stubEnv("DF_STUDIO_DELIVERY_TRACE","1");
 mocks.session.mockResolvedValue({workspaceId:"ours",user:{id:"viewer"}});mocks.asset.mockResolvedValue(null);
 const log=vi.spyOn(console,"info");
 expect((await post({stage:"canvas_visible",requestId:rid,assetId:"other",clickAt:100,durationMs:12})).status).toBe(404);
 expect(mocks.asset).toHaveBeenCalledWith({where:{requestId:rid,userId:"viewer",workspaceId:"ours",assetId:"other",status:"SUCCEEDED"},select:{outputId:true}});
 expect(log).not.toHaveBeenCalled();log.mockRestore();
});
