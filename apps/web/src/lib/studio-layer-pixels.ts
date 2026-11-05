import sharp from "sharp";
import { artifactDeadline } from "./studio-generation-artifacts-image";

/** Recover visible source detail only. Never transplant foreground RGB into
 * an occluded lower layer, a generated completion, a shadow or a soft edge. */
export class StudioLayerPixelPreserver {
  private readonly covered: Uint8Array;
  private low: Buffer | null = null;
  private frame = "";
  constructor(private readonly source: Buffer, private readonly width: number, private readonly height: number, private readonly signal: AbortSignal) {
    this.covered = new Uint8Array(width * height);
  }
  async apply(pixels: {data:Buffer; width:number; height:number}, providerWidth:number, providerHeight:number):Promise<number> {
    this.signal.throwIfAborted();
    const {data,width,height}=pixels;
    if(width!==this.width||height!==this.height||data.length!==this.source.length)throw new Error("Source pixel frame mismatch");
    const frame=`${providerWidth}x${providerHeight}`;
    if(this.frame!==frame) {
      // Compare at provider bandwidth, so native fine texture alone does not
      // disqualify a correctly aligned visible surface.
      const small=await artifactDeadline(sharp(this.source,{raw:{width,height,channels:4}})
        .resize(providerWidth,providerHeight,{fit:"fill"}).raw().toBuffer(),this.signal);
      this.low=await artifactDeadline(sharp(small,{raw:{width:providerWidth,height:providerHeight,channels:4}})
        .resize(width,height,{fit:"fill"}).raw().toBuffer(),this.signal);
      this.frame=frame;
    }
    const candidates=new Uint8Array(width*height);
    for(let n=0;n<candidates.length;n++) {
      const i=n*4;
      if(!this.covered[n]&&data[i+3]===255&&this.source[i+3]===255
        &&Math.abs(data[i]!-this.low![i]!)<=20&&Math.abs(data[i+1]!-this.low![i+1]!)<=20
        &&Math.abs(data[i+2]!-this.low![i+2]!)<=20)candidates[n]=1;
    }
    let restored=0;
    for(let y=1;y<height-1;y++) {
      this.signal.throwIfAborted();
      for(let x=1;x<width-1;x++) {
        const n=y*width+x;
        // One-pixel interior guard keeps uncertain alpha/color boundaries.
        if(!candidates[n]||!candidates[n-1]||!candidates[n+1]||!candidates[n-width]||!candidates[n+width]
          ||!candidates[n-width-1]||!candidates[n-width+1]||!candidates[n+width-1]||!candidates[n+width+1])continue;
        const i=n*4;
        data[i]=this.source[i]!;data[i+1]=this.source[i+1]!;data[i+2]=this.source[i+2]!;restored++;
      }
    }
    for(let n=0;n<candidates.length;n++)if(data[n*4+3]!>0)this.covered[n]=1;
    return restored;
  }
}

export async function createStudioLayerPixelPreserver(body:Buffer|null,width:number,height:number,signal:AbortSignal) {
  // Bound extra buffers independently of the existing whole-group limit.
  if(!body||width*height>8_000_000)return null;
  const image=sharp(body,{limitInputPixels:8_000_000});
  const abort=()=>image.destroy();signal.addEventListener("abort",abort,{once:true});
  try {
    const raw=await artifactDeadline(image.rotate().toColourspace("srgb").ensureAlpha().raw().toBuffer({resolveWithObject:true}),signal);
    if(raw.info.width!==width||raw.info.height!==height||raw.info.channels!==4)return null;
    return new StudioLayerPixelPreserver(raw.data,width,height,signal);
  } finally { signal.removeEventListener("abort",abort);image.destroy(); }
}
