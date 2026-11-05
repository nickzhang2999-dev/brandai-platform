import { describe, expect, it } from "vitest";
import { assertRuntimeDataScope, scopedObjectKey } from "../runtime-data-scope.mjs";
const scope="novart_preview_layer_quality_v1";
const env={NOVART_DATA_SCOPE:scope,DATABASE_URL:`postgresql://fixture:fixture@127.0.0.1/fixture?schema=${scope}`,BRANDAI_QUEUE_PREFIX:"preview-v1"};
describe("database and storage deployment boundary",()=>{
  it("requires the chosen isolated schema and an independent queue before startup",()=>{
    expect(()=>assertRuntimeDataScope(env)).not.toThrow();
    for(const patch of [{DATABASE_URL:"postgresql://fixture@127.0.0.1/fixture?schema=public"},{BRANDAI_QUEUE_PREFIX:"main"},{BRANDAI_QUEUE_PREFIX:""},{NOVART_DATA_SCOPE:"public"}])expect(()=>assertRuntimeDataScope({...env,...patch})).toThrow();
  });
  it("routes inherited logical keys and new stored keys to only this scope",()=>{
    const physical=`deployments/${scope}/brand/original.png`;
    expect(scopedObjectKey("brand/original.png",env)).toBe(physical);
    expect(scopedObjectKey(physical,env)).toBe(physical);
    for(const key of ["../original.png","deployments/another/original.png","brand//original.png"])expect(()=>scopedObjectKey(key,env)).toThrow();
    expect(scopedObjectKey("brand/original.png",{})).toBe("brand/original.png");
  });
});
