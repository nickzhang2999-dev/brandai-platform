import { afterEach, describe, expect, it, vi } from "vitest";
const settings=vi.hoisted(()=>vi.fn());
vi.mock("@/lib/settings",()=>({getEffectiveAiSettings:settings}));
vi.mock("@/lib/api",()=>({ApiException:class extends Error{constructor(public status:number,message:string){super(message)}}}));
import { copywritingEnabled, resolveCopywritingConfig, generateStudioCopywriting } from "@/lib/studio-copywriting-provider";
import { writingEnvelope, writingRequest } from "@/lib/studio-writing-transport";
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.clearAllMocks()});
function configured(){
  vi.stubEnv("COPYWRITING_API_KEY","");vi.stubEnv("COPYWRITING_BASE_URL","");
  settings.mockResolvedValue({vlm:{provider:"openai",apiKey:"fixture-key",baseUrl:"https://example.invalid/v1",model:"configured-model"}});
}
describe("writing admin model route",()=>{
  it("uses the configured OpenAI protocol including images, JSON, and measured usage",async()=>{
    configured();expect(await copywritingEnabled()).toBe(true);
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({choices:[{finish_reason:"stop",message:{content:JSON.stringify({candidates:[{title:"提示词",body:"绿色苹果的静物摄影"}]})}}],usage:{prompt_tokens:12,completion_tokens:21}})));
    vi.stubGlobal("fetch",fetcher);
    const result=await generateStudioCopywriting({mode:"GENERATE",prompt:"写一份生图提示词"} as never,{brandName:"示例",projectName:"示例",imageBase64:"AA=="},new AbortController().signal);
    expect(result.inputTokens).toBe(12);expect(result.model).toBe("configured-model");expect(fetcher).toHaveBeenCalledOnce();
    const [url,request]=fetcher.mock.calls[0]!;
    expect(url).toBe("https://example.invalid/v1/chat/completions");expect(request.headers.Authorization).toBe("Bearer fixture-key");
    expect(request.headers["x-api-key"]).toBeUndefined();
    expect(JSON.parse(request.body).messages[1].content[1].type).toBe("image_url");
  });
  it("never silently changes a partially configured explicit route",async()=>{
    configured();vi.stubEnv("COPYWRITING_BASE_URL","https://example.invalid/anthropic");
    expect(await copywritingEnabled()).toBe(false);expect(settings).not.toHaveBeenCalled();
  });
  it("rejects unsupported protocols, incomplete usage and filtered output",async()=>{
    configured();settings.mockResolvedValue({vlm:{provider:"mock",apiKey:"",baseUrl:"",model:""}});expect(await copywritingEnabled()).toBe(false);
    configured();const c=await resolveCopywritingConfig();
    expect(()=>writingEnvelope({choices:[{finish_reason:"content_filter",message:{content:null}}]},c)).toThrow();
    expect(()=>writingRequest({...c,baseUrl:"http://unsafe.invalid"},{system:"",messages:[],max_tokens:30})).toThrow();
    const envelope=writingEnvelope({choices:[{finish_reason:"length",message:{content:"partial"}}]},c) as {stop_reason:string;usage:{input_tokens:unknown}};
    expect(envelope.stop_reason).toBe("max_tokens");expect(envelope.usage.input_tokens).toBeUndefined();
  });
});
