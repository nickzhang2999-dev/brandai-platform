import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
vi.mock("@/lib/api", () => ({ ApiException: class extends Error {} }));
vi.mock("@/lib/s3", () => ({ getObjectStream: vi.fn() }));
vi.mock("@/lib/ssrf", () => ({ safeFetch: vi.fn() }));
import { StudioLayerPixelPreserver, createStudioLayerPixelPreserver } from "@/lib/studio-layer-pixels";
import { inspectStudioLayer } from "@/lib/studio-decomposition-images";
import { StudioLayerResolution } from "@brandai/contracts";
const width=32,height=32,signal=()=>AbortSignal.timeout(10000);
function rgba(pixel:(x:number,y:number)=>number[]) {
  const data=Buffer.alloc(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)data.set(pixel(x,y),(y*width+x)*4);
  return data;
}
const png=(data:Buffer,w=width,h=height)=>sharp(data,{raw:{width:w,height:h,channels:4}}).png().toBuffer();
describe("native detail preservation with conservative visibility",()=>{
  it("recovers fine visible source texture from a smaller model layer and records actual provenance",async()=>{
    const original=rgba((x,y)=>[(x+y)%2?155:105,128,128,255]);
    const provider=await sharp(await png(original)).resize(16,16).png().toBuffer();
    const protector=await createStudioLayerPixelPreserver(await png(original),width,height,signal());
    const result=await inspectStudioLayer(provider,width,height,signal(),undefined,undefined,(p,w,h)=>protector!.apply(p,w,h));
    const decoded=await sharp(result.body).raw().toBuffer();
    expect(decoded.subarray((10*width+10)*4,(10*width+11)*4)).toEqual(original.subarray((10*width+10)*4,(10*width+11)*4));
    expect(result.resolution).toMatchObject({rgbSource:"SOURCE_VISIBLE",providerWidth:16,publishedWidth:32,sourcePixelPolicy:"visible-opaque-v1"});
    expect(result.resolution.sourcePixelCount).toBeGreaterThan(500);
    expect(StudioLayerResolution.safeParse(result.resolution).success).toBe(true);
  });
  it("does not paste the foreground into the hidden background, including translucent coverage",async()=>{
    const source=rgba(x=>x>10&&x<21?[130,130,130,255]:[120,120,120,255]);
    const foreground=rgba(x=>x>10&&x<21?[130,130,130,255]:x===10?[120,120,120,40]:[0,0,0,0]);
    const background=rgba(()=>[120,120,120,255]);
    const protection=new StudioLayerPixelPreserver(source,width,height,signal());
    await protection.apply({data:foreground,width,height},width,height);
    await protection.apply({data:background,width,height},width,height);
    expect(background[(15*width+15)*4]).toBe(120);
    expect(foreground[(15*width+10)*4+3]).toBe(40);
    expect(background[(15*width+10)*4]).toBe(120);
  });
  it("leaves changed identities/colors and soft edges in the provider output",async()=>{
    const source=rgba(()=>[10,230,10,255]);
    const provider=rgba(x=>[230,10,10,x<5?120:255]);
    const before=Buffer.from(provider);
    const protection=new StudioLayerPixelPreserver(source,width,height,signal());
    expect(await protection.apply({data:provider,width,height},width,height)).toBe(0);
    expect(provider).toEqual(before);
  });
  it("bounds memory and requires matching source geometry",async()=>{
    expect(await createStudioLayerPixelPreserver(null,width,height,signal())).toBeNull();
    expect(await createStudioLayerPixelPreserver(Buffer.from("unused"),4000,4000,signal())).toBeNull();
    const p=new StudioLayerPixelPreserver(rgba(()=>[1,2,3,255]),width,height,signal());
    await expect(p.apply({data:Buffer.alloc(4),width:1,height:1},1,1)).rejects.toThrow("frame");
    expect(StudioLayerResolution.safeParse({sourceWidth:32,sourceHeight:32,providerWidth:16,providerHeight:16,publishedWidth:32,publishedHeight:32,scaleX:2,scaleY:2,resampling:"LANCZOS3",rgbSource:"SOURCE_VISIBLE"}).success).toBe(false);
  });
});
