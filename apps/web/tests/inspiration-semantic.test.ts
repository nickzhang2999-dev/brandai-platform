import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/ssrf',()=>({assertSafePublicUrl:vi.fn().mockResolvedValue(undefined)}));
import { assertSafePublicUrl } from '@/lib/ssrf';
import { embeddingConfig, embeddingSpace, embeddingCacheKey, embedTexts, validVector, cosineSimilarity, rankEmbeddings, rankHybrid, type EmbeddingConfig, type CachedEmbedding } from '@/lib/inspiration/semantic';
const config:EmbeddingConfig={endpoint:'https://embeddings.example/v1/embeddings',apiKey:'test-secret',model:'explicit-test-model',dimensions:2,version:'1',timeoutMs:100};
const vector=(v:number[],space=embeddingSpace(config)):CachedEmbedding=>({space,dimensions:2,vector:v});
const response=(data:unknown,model=config.model)=>new Response(JSON.stringify({model,data}));
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();vi.mocked(assertSafePublicUrl).mockResolvedValue(undefined);});
describe('explicit embedding configuration',()=>{
  const env={INSPIRATION_EMBEDDING_ENDPOINT:config.endpoint,INSPIRATION_EMBEDDING_API_KEY:config.apiKey,INSPIRATION_EMBEDDING_MODEL:config.model,INSPIRATION_EMBEDDING_DIMENSIONS:'2'};
  it('never infers embedding credentials from copywriting or VLM',()=>{expect(embeddingConfig({COPYWRITING_API_KEY:'x',VLM_PROVIDER_API_KEY:'x'})).toBeNull();expect(embeddingConfig(env)).toMatchObject({model:config.model,dimensions:2});});
  it.each(['http://example.com/v1/embeddings','https://user:pass@example.com/v1/embeddings','https://example.com:1234/v1/embeddings','https://example.com/v1/embeddings?key=secret'])('rejects unsafe configuration %s',endpoint=>{expect(embeddingConfig({...env,INSPIRATION_EMBEDDING_ENDPOINT:endpoint})).toBeNull();});
  it.each(['0','4097','2.5','NaN'])('rejects dimensions %s',dimensions=>expect(embeddingConfig({...env,INSPIRATION_EMBEDDING_DIMENSIONS:dimensions})).toBeNull());
  it('separates model, endpoint, version and dimensions; excludes rotating secret',()=>{
    const space=embeddingSpace(config); for(const change of [{model:'another'},{endpoint:'https://other.example/embeddings'},{version:'2'},{dimensions:3}])expect(embeddingSpace({...config,...change})).not.toBe(space);
    expect(embeddingSpace({...config,apiKey:'new-secret'})).toBe(space);
    expect(embeddingCacheKey('workspace-a',config,'text')).not.toBe(embeddingCacheKey('workspace-b',config,'text'));
  });
});
describe('worker embedding adapter',()=>{
  it('does not call network when absent configuration or invalid input',async()=>{const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);expect(await embedTexts(null,['q'])).toEqual({ok:false,reason:'not-configured'});expect(await embedTexts(config,Array(17).fill('q'))).toEqual({ok:false,reason:'invalid-input'});expect(await embedTexts(config,[' '])).toMatchObject({ok:false});expect(fetcher).not.toHaveBeenCalled();});
  it('maps out-of-order provider indexes and bounds request to explicit endpoint',async()=>{
    const fetcher=vi.fn().mockResolvedValue(response([{index:1,embedding:[0,1]},{index:0,embedding:[1,0]}]));vi.stubGlobal('fetch',fetcher);
    expect(await embedTexts(config,['one','two'])).toEqual({ok:true,space:embeddingSpace(config),vectors:[[1,0],[0,1]]});
    expect(assertSafePublicUrl).toHaveBeenCalledWith(config.endpoint);const [url,init]=fetcher.mock.calls[0];expect(url).toBe(config.endpoint);expect(init.redirect).toBe('error');expect(JSON.parse(init.body)).toEqual({model:config.model,dimensions:2,input:['one','two'],encoding_format:'float'});
  });
  it.each([
    {name:'wrong model',data:[{index:0,embedding:[1,0]}],model:'other'},
    {name:'wrong dimensions',data:[{index:0,embedding:[1,0,0]}]},
    {name:'zero vector',data:[{index:0,embedding:[0,0]}]},
    {name:'non numeric vector',data:[{index:0,embedding:[1,'0']}]},
    {name:'missing index',data:[{embedding:[1,0]}]},
    {name:'out of bounds',data:[{index:1,embedding:[1,0]}]},
  ])('falls back for $name without provider details',async({data,model})=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response(data,model)));expect(await embedTexts(config,['q'])).toEqual({ok:false,reason:'provider-unavailable'});});
  it('rejects duplicated provider indexes',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response([{index:0,embedding:[1,0]},{index:0,embedding:[0,1]}])));expect(await embedTexts(config,['a','b'])).toMatchObject({ok:false});});
  it('rejects private address resolution before credentials leave process',async()=>{vi.mocked(assertSafePublicUrl).mockRejectedValueOnce(new Error('private'));const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);expect(await embedTexts(config,['q'])).toMatchObject({ok:false});expect(fetcher).not.toHaveBeenCalled();});
  it('times out even when an upstream ignores abort, without retry',async()=>{const fetcher=vi.fn(()=>new Promise<Response>(()=>{}));vi.stubGlobal('fetch',fetcher);expect(await embedTexts(config,['q'])).toEqual({ok:false,reason:'timeout'});expect(fetcher).toHaveBeenCalledTimes(1);expect(fetcher.mock.calls[0]![1]!.signal.aborted).toBe(true);});
  it('cancels an in-flight request explicitly',async()=>{const controller=new AbortController();vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(()=>{})));const pending=embedTexts(config,['q'],controller.signal);controller.abort();expect(await pending).toEqual({ok:false,reason:'cancelled'});});
  it('rejects oversized response instead of buffering indefinitely',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('secret-provider-body',{headers:{'content-length':'3000000'}})));expect(await embedTexts(config,['q'])).toEqual({ok:false,reason:'provider-unavailable'});});
  it('reuses persisted query/index cache and isolates invalid cached dimensions',async()=>{
    const map=new Map<string,unknown>();const cache={get:async(k:string)=>map.get(k),put:async(k:string,v:CachedEmbedding)=>{map.set(k,v);}};
    const fetcher=vi.fn().mockImplementation(async()=>response([{index:0,embedding:[1,0]}]));vi.stubGlobal('fetch',fetcher);
    expect((await embedTexts(config,['q'],undefined,{scope:'ws-a',cache})).ok).toBe(true);
    expect((await embedTexts(config,['q'],undefined,{scope:'ws-a',cache})).ok).toBe(true);expect(fetcher).toHaveBeenCalledTimes(1);
    map.set(embeddingCacheKey('ws-a',config,'q'),{space:embeddingSpace(config),dimensions:3,vector:[1,0,0]});
    await embedTexts(config,['q'],undefined,{scope:'ws-a',cache});expect(fetcher).toHaveBeenCalledTimes(2);
    await embedTexts(config,['q'],undefined,{scope:'ws-b',cache});expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
describe('permission-filtered hybrid ranking',()=>{
  it('rejects NaN, infinity, zero and overflow vectors',()=>{for(const v of [[NaN,1],[Infinity,1],[0,0],[1e308,1]])expect(validVector(v,2)).toBe(false);expect(cosineSimilarity([1,0],[0,1])).toBe(0);expect(cosineSimilarity([1,0],[1])).toBeNull();});
  it('cannot revive a withdrawn/unpermitted case or compare another model space',()=>{
    const ranked=rankEmbeddings(vector([1,0]),[{caseId:'permitted',allowed:true,embedding:vector([0,1])},{caseId:'withdrawn',allowed:false,embedding:vector([1,0])},{caseId:'other-model',allowed:true,embedding:vector([1,0],'other')}]);
    expect(ranked).toEqual([{caseId:'permitted',score:0}]);
  });
  it('labels no valid query as keyword-tags and ranks valid semantic matches',()=>{
    const cases=[{caseId:'keyword',allowed:true,keywordScore:2,embedding:vector([0,1])},{caseId:'semantic',allowed:true,keywordScore:0,embedding:vector([1,0])},{caseId:'denied',allowed:false,keywordScore:100,embedding:vector([1,0])}];
    expect(rankHybrid(cases,null).searchMode).toBe('keyword-tags');expect(rankHybrid(cases,null).cases.map(c=>c.caseId)).toEqual(['keyword','semantic']);
    expect(rankHybrid(cases,vector([1,0])).searchMode).toBe('hybrid');expect(rankHybrid(cases,vector([1,0])).cases.some(c=>c.caseId==='denied')).toBe(false);
    expect(rankHybrid(cases,vector([1,0],'other')).searchMode).toBe('keyword-tags');
  });
});
