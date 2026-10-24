import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
const db=vi.hoisted(()=>({user:{findFirst:vi.fn()},brandWorkspace:{findFirst:vi.fn()},membership:{findUnique:vi.fn()},asyncTask:{findFirst:vi.fn(),findMany:vi.fn(),count:vi.fn(),create:vi.fn(),updateMany:vi.fn()},$executeRaw:vi.fn(),$transaction:vi.fn()}));
const settings=vi.hoisted(()=>vi.fn());
vi.mock('@brandai/db',()=>({prisma:db}));
vi.mock('@/lib/settings',()=>({getEffectiveAiSettings:settings}));
import { OmniAnalysisInput, OmniAnalysisResult } from '@brandai/contracts';
import { checkToken, checkedInput, jobView, payloadHash, providerReady, readInput, requestRef, serviceConfig } from '@/lib/omni-analysis/policy';
import { activeScope, authenticate, configuration, getJob, getJobByRequest, submit } from '@/lib/omni-analysis/service';
import { analyzeImage, visionTokenOptions } from '@/lib/omni-analysis/provider';
import { AnalysisFailure, safeAnalysisFailure } from '@/lib/omni-analysis/failure';
import { processAnalysis, sweepAnalysis } from '@/lib/omni-analysis/worker';
import { POST } from '@/app/api/internal/inspiration-analysis/jobs/route';

const token='unit-test-service-token-1234567890';
const vlm={provider:'openai',model:'configured-model',apiKey:'unit-provider-secret',baseUrl:'https://model.example.test/v1'};
const input={request_id:'1234567890abcdef',source_image_id:'image-1',revision:1,image_sha256:'a'.repeat(64),image_base64:'/9j/AA==',title:'素材',description:'项目说明'};
const suggestion={kind:'reference',purposes:[],reason:'【图像观察】包装',description:'【图像观察】蓝色',ocr_text:'',brand:'',design:{palette:'【图像观察】蓝色',typography:'不确定',composition:'居中',hierarchy:'标题突出',imagery:'摄影',reusable_ideas:'【分析推断】色彩分组',applicability:'包装',limitations:'单图无法核验来源说明'}};
const task=()=>({id:'job1',workspaceId:'workspace1',kind:'OMNI_INSPIRATION_ANALYSIS',status:'PENDING',error:null,resultJson:null,expiresAt:new Date(Date.now()+300000),inputJson:{payload_hash:payloadHash(input),user_id:'user1',request:input}});
beforeEach(()=>{
  vi.resetAllMocks();
  vi.stubEnv('OMNI_ANALYSIS_TOKEN_SHA256',createHash('sha256').update(token).digest('hex'));
  vi.stubEnv('OMNI_ANALYSIS_WORKSPACE_ID','workspace1');vi.stubEnv('OMNI_ANALYSIS_USER_ID','user1');vi.stubEnv('OMNI_ANALYSIS_DAILY_LIMIT','5');
  db.user.findFirst.mockResolvedValue({id:'user1'});db.brandWorkspace.findFirst.mockResolvedValue({ownerId:'user1'});db.membership.findUnique.mockResolvedValue(null);
  db.$transaction.mockImplementation((fn:(db:unknown)=>unknown)=>fn(db));db.$executeRaw.mockResolvedValue(1);
  db.asyncTask.findFirst.mockResolvedValue(null);db.asyncTask.findMany.mockResolvedValue([]);db.asyncTask.count.mockResolvedValue(0);db.asyncTask.create.mockResolvedValue(task());db.asyncTask.updateMany.mockResolvedValue({count:1});
  settings.mockResolvedValue({vlm});
});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
describe('Omni service auth and contracts',()=>{
  it('requires a separate bearer and fails closed without service binding',()=>{
    expect(()=>checkToken(new Headers())).toThrow('unauthorized');expect(()=>checkToken(new Headers({Authorization:'Bearer '+token+'wrong'}))).toThrow('unauthorized');
    expect(checkToken(new Headers({Authorization:'Bearer '+token})).workspaceId).toBe('workspace1');
    vi.stubEnv('OMNI_ANALYSIS_TOKEN_SHA256','');expect(()=>checkToken(new Headers())).toThrow('service_not_configured');
  });
  it('rejects disabled user, removed membership and viewer even with correct token',async()=>{
    db.brandWorkspace.findFirst.mockResolvedValue({ownerId:'owner'});db.membership.findUnique.mockResolvedValue({role:'VIEWER'});
    await expect(authenticate(new Request('https://nova.test',{headers:{Authorization:'Bearer '+token}}))).rejects.toThrow('scope_forbidden');
    db.membership.findUnique.mockResolvedValue({role:'EDITOR'});expect((await activeScope()).workspaceId).toBe('workspace1');
    db.user.findFirst.mockResolvedValue(null);await expect(activeScope()).rejects.toThrow('scope_forbidden');
  });
  it('reports exact configured model without endpoint or credentials; defaults quota to off',async()=>{
    expect(await configuration()).toEqual({ready:true,state:'ready',model:'configured-model',daily_limit:5});
    vi.stubEnv('OMNI_ANALYSIS_DAILY_LIMIT','');expect(serviceConfig().dailyLimit).toBe(0);expect((await configuration()).ready).toBe(false);
    expect(providerReady({...vlm,provider:'mock'})).toBe(false);expect(providerReady({...vlm,baseUrl:'http://model.test'})).toBe(false);expect(providerReady({...vlm,baseUrl:'https://a:b@model.test'})).toBe(false);
  });
  it('rejects URLs, client model overrides, unknown rights, invalid JPEG and oversized data',()=>{
    for(const change of [{image_url:'https://image.test/a.jpg'},{model:'other'},{rights:'allowed'},{revision:0},{image_sha256:'x'}])expect(OmniAnalysisInput.safeParse({...input,...change}).success).toBe(false);
    expect(()=>checkedInput({...input,image_base64:'AAAA'})).toThrow('invalid_jpeg');
    expect(()=>checkedInput({...input,image_base64:Buffer.alloc(1024*1024+1).toString('base64')})).toThrow();
    expect(OmniAnalysisResult.safeParse({...suggestion,model_version:'configured-model',permissions:{analysis:'allowed'}}).success).toBe(false);
  });
  it('matches Omni reason, advertisement purpose, brand and model length constraints',()=>{
    for(const change of [{reason:''},{reason:' \n '},{kind:'advertisement',purposes:[]},{brand:'b'.repeat(201)},{model_version:'m'.repeat(201)},{model_version:' '}]) {
      expect(OmniAnalysisResult.safeParse({...suggestion,model_version:vlm.model,...change}).success).toBe(false);
    }
    expect(OmniAnalysisResult.safeParse({...suggestion,kind:'advertisement',purposes:['brand'],model_version:vlm.model}).success).toBe(true);
    expect(providerReady({...vlm,model:'m'.repeat(201)})).toBe(false);
    expect(providerReady({...vlm,model:' '})).toBe(false);
  });
  it('bounds incoming body and never parses unauthenticated input',async()=>{
    await expect(readInput(new Request('https://nova.test',{method:'POST',headers:{'content-length':'3000000'},body:'{}'}))).rejects.toThrow('request_too_large');
    const response=await POST(new Request('https://nova.test',{method:'POST',body:'not json'}));expect(response.status).toBe(401);expect(db.asyncTask.create).not.toHaveBeenCalled();
  });
  it('never includes original image in polling response and validates stored completed output',()=>{
    expect(JSON.stringify(jobView(task()))).not.toContain('image_base64');
    expect(jobView({...task(),status:'SUCCEEDED',resultJson:{invalid:true}})).toMatchObject({status:'failed',reason:'invalid_stored_result'});
  });
});
describe('Omni durable admission',()=>{
  it('creates bounded durable pending task without executing model',async()=>{
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    expect(await submit(input)).toMatchObject({created:true,job:{status:'queued'}});
    expect(db.$executeRaw).toHaveBeenCalledOnce();expect(db.asyncTask.create.mock.calls[0][0].data.expiresAt.getTime()-Date.now()).toBeLessThanOrEqual(360000);expect(fetcher).not.toHaveBeenCalled();
  });
  it('returns duplicate across retries and rejects changed idempotency payload',async()=>{
    db.asyncTask.findFirst.mockResolvedValue(task());expect((await submit(input)).created).toBe(false);expect(db.asyncTask.create).not.toHaveBeenCalled();
    await expect(submit({...input,title:'changed'})).rejects.toThrow('request_id_conflict');
    expect(requestRef('workspace1','user1',input.request_id)).not.toBe(requestRef('workspace2','user1',input.request_id));
  });
  it('counts failed and queued admissions against daily cap',async()=>{
    db.asyncTask.count.mockResolvedValueOnce(5).mockResolvedValueOnce(0);await expect(submit(input)).rejects.toThrow('daily_limit_reached');expect(db.asyncTask.create).not.toHaveBeenCalled();
    expect(db.asyncTask.count.mock.calls[0][0].where.status).toBeUndefined();
  });
  it('limits pending jobs independently and fails closed if quota disabled',async()=>{
    db.asyncTask.count.mockResolvedValueOnce(0).mockResolvedValueOnce(20);await expect(submit(input)).rejects.toThrow('queue_full');
    vi.stubEnv('OMNI_ANALYSIS_DAILY_LIMIT','0');await expect(submit(input)).rejects.toThrow('daily_limit_disabled');
  });
  it('does not disclose a job owned by another fixed service actor',async()=>{
    db.asyncTask.findFirst.mockResolvedValue({...task(),inputJson:{user_id:'other'}});await expect(getJob('job1')).rejects.toThrow('job_not_found');
    expect(db.asyncTask.findFirst.mock.calls[0][0].where).toEqual({id:'job1',workspaceId:'workspace1',kind:'OMNI_INSPIRATION_ANALYSIS'});
  });
  it('closes expired jobs from polling even if worker is down',async()=>{
    db.asyncTask.findFirst.mockResolvedValue({...task(),expiresAt:new Date(0)});
    expect(await getJob('job1')).toMatchObject({status:'failed',reason:'analysis_expired_no_retry'});
    expect(db.asyncTask.updateMany.mock.calls[0][0].data.inputJson).not.toHaveProperty('request');
  });
  it('recovers accepted request receipt without creating, charging or calling the model',async()=>{
    db.asyncTask.findFirst.mockResolvedValue(task());
    expect(await getJobByRequest(input.request_id)).toMatchObject({id:'job1',status:'queued'});
    expect(db.asyncTask.findFirst.mock.calls[0][0].where).toEqual({workspaceId:'workspace1',kind:'OMNI_INSPIRATION_ANALYSIS',refId:requestRef('workspace1','user1',input.request_id)});
    expect(db.asyncTask.create).not.toHaveBeenCalled();expect(db.asyncTask.count).not.toHaveBeenCalled();expect(settings).not.toHaveBeenCalled();
  });
  it('returns not found for unaccepted requests or another service actor receipt',async()=>{
    await expect(getJobByRequest(input.request_id)).rejects.toThrow('job_not_found');
    db.asyncTask.findFirst.mockResolvedValue({...task(),inputJson:{user_id:'other'}});await expect(getJobByRequest(input.request_id)).rejects.toThrow('job_not_found');
    await expect(getJobByRequest('../../bad')).rejects.toThrow('job_not_found');expect(db.asyncTask.create).not.toHaveBeenCalled();
  });
});
describe('Omni paid execution',()=>{
  async function realJpeg(){return {...input,image_base64:(await sharp({create:{width:8,height:8,channels:3,background:'#777'}}).jpeg().toBuffer()).toString('base64')};}
  const success=()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(suggestion)}}]}));
  it.each(['gpt-5.6-sol','gpt-5','gpt-5-mini','o3','o4-mini','openai/gpt-5.6-sol','OpenAI/O4-mini'])('uses existing VLM reasoning token wire shape for %s',model=>{
    expect(visionTokenOptions(model)).toEqual({max_completion_tokens:4000,reasoning_effort:'low'});
  });
  it.each(['custom-vision','openai/gpt-4o','vendor/gpt-50-vision'])('preserves nonreasoning wire shape for %s',model=>{
    expect(visionTokenOptions(model)).toEqual({max_tokens:4000,temperature:0.2});
  });
  it('validates actual JPEG bytes before any provider request',async()=>{
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);await expect(analyzeImage(input,vlm,new AbortController().signal)).rejects.toThrow('invalid_jpeg');expect(fetcher).not.toHaveBeenCalled();
  });
  it('uses shared model exactly once with inline image, no redirects and validated design result',async()=>{
    const fetcher=vi.fn().mockResolvedValue(success());vi.stubGlobal('fetch',fetcher);
    const result=await analyzeImage(await realJpeg(),vlm,new AbortController().signal);expect(result.model_version).toBe('configured-model');expect(result.design.palette).toContain('图像观察');
    const [url,init]=fetcher.mock.calls[0];expect(String(url)).toBe('https://model.example.test/v1/chat/completions');expect(init.redirect).toBe('error');expect(JSON.parse(init.body).model).toBe('configured-model');expect(fetcher).toHaveBeenCalledOnce();
  });
  it('fails malformed or oversized upstream responses without fallback paid retry',async()=>{
    const fetcher=vi.fn().mockResolvedValue(new Response('x'.repeat(256*1024+1)));vi.stubGlobal('fetch',fetcher);
    await expect(analyzeImage(await realJpeg(),vlm,new AbortController().signal)).rejects.toThrow('provider_response_too_large');expect(fetcher).toHaveBeenCalledOnce();
  });
  it('sends reasoning parameters and JSON output mode in one request without paid probing',async()=>{
    const fetcher=vi.fn().mockResolvedValue(success());vi.stubGlobal('fetch',fetcher);
    await analyzeImage(await realJpeg(),{...vlm,model:'openai/gpt-5.6-sol'},new AbortController().signal);
    const body=JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body).toMatchObject({model:'openai/gpt-5.6-sol',max_completion_tokens:4000,reasoning_effort:'low',response_format:{type:'json_object'}});
    expect(body).not.toHaveProperty('max_tokens');expect(body).not.toHaveProperty('temperature');expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([
    ['response-json',()=>new Response('<html>private-upstream-body</html>'),'provider_response_json_invalid'],
    ['output-json',()=>new Response(JSON.stringify({choices:[{message:{content:'private-upstream-body'}}]})),'provider_output_json_invalid'],
    ['missing-content',()=>new Response(JSON.stringify({private:'upstream-body'})),'provider_content_missing'],
    ['truncated',()=>new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:'private-upstream-body'}}]})),'provider_output_truncated'],
    ['schema',()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({...suggestion,design:{...suggestion.design,palette:null},'private-secret-key':'private-secret-value'})}}]})),'provider_schema_invalid:design.palette,root'],
  ])('reports safe %s failure without raw values or diagnostics',async(_name,makeResponse,expected)=>{
    const fetcher=vi.fn().mockResolvedValue((makeResponse as ()=>Response)());vi.stubGlobal('fetch',fetcher);
    let failure;try{await analyzeImage(await realJpeg(),vlm,new AbortController().signal);}catch(error){failure=error;}
    expect(safeAnalysisFailure(failure)).toBe(expected);expect(JSON.stringify(failure)).not.toContain('private-');expect(fetcher).toHaveBeenCalledOnce();
  });
  it('persists only HTTP status when provider rejects and strips image bytes',async()=>{
    const current=task();current.inputJson.request=await realJpeg();db.asyncTask.findFirst.mockResolvedValue(current);
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('private-key/prompt/provider error',{status:400})));
    await processAnalysis('job1');const data=db.asyncTask.updateMany.mock.calls.at(-1)?.[0].data;
    expect(data.error).toBe('provider_http_400');expect(data.inputJson).not.toHaveProperty('request');expect(JSON.stringify(data)).not.toContain('private-key');
  });
  it('never serializes unexpected exception messages or arbitrary schema paths',()=>{
    expect(safeAnalysisFailure(new Error('private-url-key'))).toBe('analysis_failed');
    expect(safeAnalysisFailure(new AnalysisFailure('provider_schema_invalid',undefined,[['private-key'],['design','palette']]))).toBe('provider_schema_invalid:root,design.palette');
    expect(safeAnalysisFailure(new AnalysisFailure('provider_request_failed'),true)).toBe('analysis_timeout');
  });
  it('does not rerun an already claimed job',async()=>{
    db.asyncTask.findFirst.mockResolvedValue({...task(),status:'RUNNING'});const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);await processAnalysis('job1');expect(fetcher).not.toHaveBeenCalled();expect(db.asyncTask.updateMany).not.toHaveBeenCalled();
  });
  it('strips image input on failure and does not persist provider diagnostics',async()=>{
    const current=task();current.inputJson.request=await realJpeg();db.asyncTask.findFirst.mockResolvedValue(current);
    vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('unit-provider-secret diagnostic')));await processAnalysis('job1');
    const update=db.asyncTask.updateMany.mock.calls.at(-1)?.[0];expect(update.data.status).toBe('FAILED');expect(update.data.inputJson).not.toHaveProperty('request');expect(JSON.stringify(update)).not.toContain('unit-provider-secret');
  });
  it('checks permission after model and discards results if access revoked',async()=>{
    const current=task();current.inputJson.request=await realJpeg();db.asyncTask.findFirst.mockResolvedValue(current);
    vi.stubGlobal('fetch',vi.fn().mockImplementation(async()=>{db.user.findFirst.mockResolvedValue(null);return success();}));
    await processAnalysis('job1');expect(db.asyncTask.updateMany.mock.calls.at(-1)?.[0].data.status).toBe('FAILED');
  });
  it('persists result with real model identifier and clears input bytes',async()=>{
    const current=task();current.inputJson.request=await realJpeg();db.asyncTask.findFirst.mockResolvedValue(current);vi.stubGlobal('fetch',vi.fn().mockResolvedValue(success()));
    await processAnalysis('job1');const data=db.asyncTask.updateMany.mock.calls.at(-1)?.[0].data;
    expect(data.status).toBe('SUCCEEDED');expect(data.resultJson.model_version).toBe(vlm.model);expect(data.inputJson).not.toHaveProperty('request');
  });
  it('expires abandoned jobs without retrying and strips retained image bytes',async()=>{
    db.asyncTask.findMany.mockResolvedValue([task()]);await sweepAnalysis();const data=db.asyncTask.updateMany.mock.calls.at(-1)?.[0].data;expect(data.error).toBe('analysis_expired_no_retry');expect(data.inputJson).not.toHaveProperty('request');
  });
});
