import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const f=vi.hoisted(()=>({user:vi.fn(),list:vi.fn(),submit:vi.fn()}));
vi.mock("@/lib/api",()=>({requireUser:f.user,ApiException:class extends Error {constructor(public status:number,message:string){super(message)}}}));
vi.mock("@/lib/studio-copywriting",()=>({listCopywriting:f.list,submitCopywriting:f.submit}));
import { GET,POST } from "../src/app/api/workspaces/[wsId]/projects/[projectId]/studio-copywriting/route";
const context={params:Promise.resolve({wsId:"w",projectId:"p"})};
const request=(method:string,origin="http://local",user="u")=>new Request("http://local/api/copywriting",{method,headers:{Origin:origin,"X-Novart-User":user,"content-type":"application/json"},...(method==="POST"?{body:JSON.stringify({prompt:"写文案"})}:{})});
beforeEach(()=>{vi.resetAllMocks();vi.stubEnv("AUTH_URL","http://local");f.user.mockResolvedValue({id:"u"});f.list.mockResolvedValue({enabled:true,tasks:[]});f.submit.mockResolvedValue({id:"t",status:"PENDING"});});
afterEach(() => vi.unstubAllEnvs());
describe("copywriting HTTP boundary",()=>{
  it("returns 202 using the authenticated user and URL scope",async()=>{expect((await POST(request("POST"),context)).status).toBe(202);expect(f.submit).toHaveBeenCalledWith("w","p","u",{prompt:"写文案"});});
  it("rejects cross-origin writes before queuing",async()=>{expect((await POST(request("POST","http://foreign"),context)).status).toBe(403);expect(f.submit).not.toHaveBeenCalled();});
  it("rejects a changed account on reads and writes",async()=>{expect((await POST(request("POST","http://local","other"),context)).status).toBe(409);expect((await GET(request("GET","http://local","other"),context)).status).toBe(409);expect(f.submit).not.toHaveBeenCalled();expect(f.list).not.toHaveBeenCalled();});
  it("reads server receipts without a provider call",async()=>{const response=await GET(request("GET"),context);expect(response.headers.get("cache-control")).toBe("no-store");expect(await response.json()).toEqual({enabled:true,tasks:[]});expect(f.submit).not.toHaveBeenCalled();});
});
