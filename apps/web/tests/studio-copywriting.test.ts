import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
import { StudioCopywritingInput } from "@brandai/contracts";
import { copywritingEnabled, copywritingEndpoint, generateStudioCopywriting, parseCopywritingResponse } from "@/lib/studio-copywriting-provider";
import { placeCopywriting } from "@/components/owned-canvas/owned-copywriting-placement";
import { emptyOwnedDocument } from "@/lib/owned-canvas-model";
const input = { mutationId: "a0c34955-a62b-4428-99a9-99a149bb9401", prompt: "写一份海报文案", mode: "GENERATE" as const, tone: "自然" as const, sourceText: "" };
const envelope = { stop_reason: "end_turn", content: [{ type: "thinking", text: "private reasoning" }, { type: "text", text: JSON.stringify({ candidates: [{ title: "好时光", body: "让相聚更有温度。" }] }) }], usage: { input_tokens: 10, output_tokens: 20 } };
afterEach(()=>{ vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("canvas copywriting provider", () => {
  it("normalizes Anthropic base, v1 and messages paths without leaking credentials", () => {
    for (const suffix of ["", "/", "/v1", "/v1/messages"]) expect(copywritingEndpoint("https://example.test/apps/anthropic"+suffix)).toBe("https://example.test/apps/anthropic/v1/messages");
    expect(()=>copywritingEndpoint("http://example.test")).toThrow();
    expect(()=>copywritingEndpoint("https://user:secret@example.test")).toThrow();
  });
  it("requires source text for rewrite and accepts no URLs or client model overrides",()=>{
    expect(StudioCopywritingInput.safeParse({...input,mode:"REWRITE"}).success).toBe(false);
    expect(StudioCopywritingInput.safeParse({...input,baseUrl:"https://other.test"}).success).toBe(false);
    expect(StudioCopywritingInput.safeParse({...input,image:{url:"https://other.test"}}).success).toBe(false);
  });
  it("uses only text blocks, validates structured candidates and rejects truncated output",()=>{
    expect(parseCopywritingResponse(envelope)).toMatchObject({inputTokens:10,outputTokens:20,candidates:[{title:"好时光"}]});
    expect(()=>parseCopywritingResponse({...envelope,stop_reason:"max_tokens"})).toThrow("不完整");
    expect(()=>parseCopywritingResponse({...envelope,content:[{type:"text",text:'{"candidates":[]}'}]})).toThrow();
  });
  it("fails closed when the dedicated model is not configured",()=>{
    vi.stubEnv("COPYWRITING_API_KEY",""); vi.stubEnv("COPYWRITING_BASE_URL","");expect(copywritingEnabled()).toBe(false);
  });
  it("sends one Anthropic request, with image data and no client-provided URL", async()=>{
    vi.stubEnv("COPYWRITING_API_KEY","unit-secret"); vi.stubEnv("COPYWRITING_BASE_URL","https://example.test/apps/anthropic"); vi.stubEnv("COPYWRITING_MODEL","qwen3.7-plus");
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify(envelope)));vi.stubGlobal("fetch",fetcher);
    const result=await generateStudioCopywriting(input,{brandName:"测试",projectName:"海报",imageBase64:"AA=="},new AbortController().signal);
    expect(result.candidates).toHaveLength(1);expect(fetcher).toHaveBeenCalledTimes(1);
    const [url,init]=fetcher.mock.calls[0];expect(url).toBe("https://example.test/apps/anthropic/v1/messages");
    expect(init.redirect).toBe("error");expect(init.headers["x-api-key"]).toBe("unit-secret");
    expect(JSON.parse(init.body)).toMatchObject({model:"qwen3.7-plus",messages:[{role:"user",content:[{type:"text"},{type:"image"}]}]});
  });
  it("redacts upstream rejection bodies and never automatically retries",async()=>{
    vi.stubEnv("COPYWRITING_API_KEY","unit-secret");vi.stubEnv("COPYWRITING_BASE_URL","https://example.test");
    const fetcher=vi.fn().mockResolvedValue(new Response('secret provider diagnostic',{status:403}));vi.stubGlobal("fetch",fetcher);
    await expect(generateStudioCopywriting(input,{brandName:"测试",projectName:"海报"},new AbortController().signal)).rejects.toThrow("鉴权失败");expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
describe("native copywriting insertion",()=>{
  it("inserts editable text beside an image and de-duplicates one result",()=>{
    const doc=emptyOwnedDocument();doc.items=[{id:"shape:image",kind:"image",x:20,y:30,w:100,h:100,rotation:0,opacity:1}];
    const next=placeCopywriting(doc,"标题\n正文","receipt-0","shape:image");
    expect(next.items[1]).toMatchObject({kind:"text",x:160,y:30,text:"标题\n正文"});
    expect(placeCopywriting(next,"标题\n正文","receipt-0")).toBe(next);expect(doc.items).toHaveLength(1);
  });
  it("wraps long Chinese text for the native SVG renderer",()=>{
    const next=placeCopywriting(emptyOwnedDocument(),"一".repeat(120),"long");expect(next.items[0].text?.split("\n")).toHaveLength(7);expect(next.items[0].h).toBeGreaterThan(200);
  });
});
