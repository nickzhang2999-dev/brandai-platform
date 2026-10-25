import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InspirationCaseCard } from '@brandai/contracts';
const settings = vi.hoisted(()=>({read:vi.fn()}));
vi.mock('../src/lib/settings',()=>({getEffectiveAiSettings:settings.read}));
vi.mock('../src/lib/studio-copywriting-provider',()=>({copywritingConfig:()=>({apiKey:'private-key',baseUrl:'https://provider.test',model:'anthropic-model'}),copywritingEndpoint:()=> 'https://provider.test/v1/messages'}));
import { openAiTokenOptions } from '../src/lib/openai-model-options';
import { answerEvidence } from '../src/lib/inspiration/provider';
import { InspirationFailure, inspirationFailureDiagnostic, readInspirationResponse } from '../src/lib/inspiration/failure';

const card:InspirationCaseCard={caseId:'case-a',revision:1,title:'案例',summary:'测试说明',brandOrTeam:'Test',analysisAllowed:true,tags:{industry:['测试']},images:[],sources:[],claims:[{claimId:'claim-a',kind:'analysis_inference',text:'设计观察',sourceIds:[],imageIds:[]}]};
const answer={sections:[{text:'设计分析',caseId:'case-a',claimIds:['claim-a']}],limitations:'单例证据'};
const response=(content:unknown=JSON.stringify(answer),finish_reason='stop')=>new Response(JSON.stringify({choices:[{finish_reason,message:{content}}],usage:{prompt_tokens:3,completion_tokens:4}}));
const execute=()=>answerEvidence('private-user-question',[card],[],new AbortController().signal);
beforeEach(()=>{settings.read.mockResolvedValue({vlm:{provider:'openai',model:'gpt-5.6-sol',apiKey:'private-key',baseUrl:'https://provider.test/v1'}});});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();vi.clearAllMocks();});

describe('shared OpenAI token options',()=>{
  it.each(['gpt-5.6-sol','gpt-5','gpt-5-mini','o1','o3-mini','o4-mini','OpenAI/O4-mini'])('uses explicit reasoning budget without temperature for %s',model=>{
    expect(openAiTokenOptions(model,3000,0.2)).toEqual({max_completion_tokens:3000,reasoning_effort:'low'});
  });
  it.each(['gpt-4o','vendor/gpt-50-vision','configured-model'])('keeps legacy temperature opt-in for %s',model=>{
    expect(openAiTokenOptions(model,3000)).toEqual({max_tokens:3000});
    expect(openAiTokenOptions(model,4000,0.2)).toEqual({max_tokens:4000,temperature:0.2});
  });
});

describe('inspiration request wire format',()=>{
  it('uses the configured GPT-5 model, reasoning budget and JSON mode in one request',async()=>{
    const fetcher=vi.fn().mockResolvedValue(response());vi.stubGlobal('fetch',fetcher);
    const result=await execute();
    expect(fetcher).toHaveBeenCalledOnce();expect(result.model).toBe('gpt-5.6-sol');
    const [url,init]=fetcher.mock.calls[0]!;const body=JSON.parse(init.body);
    expect(url).toBe('https://provider.test/v1/chat/completions');expect(init.redirect).toBe('error');
    expect(body).toMatchObject({model:'gpt-5.6-sol',stream:false,max_completion_tokens:3000,reasoning_effort:'low',response_format:{type:'json_object'}});
    expect(body).not.toHaveProperty('max_tokens');expect(body).not.toHaveProperty('temperature');
    expect(result.citations[0]?.caseId).toBe('case-a');expect(result.answer).toContain('[case-a:claim-a]');
  });
  it('does not introduce temperature into the legacy chat path',async()=>{
    settings.read.mockResolvedValue({vlm:{provider:'openai',model:'gpt-4o',apiKey:'private-key',baseUrl:'https://provider.test/v1'}});
    const fetcher=vi.fn().mockResolvedValue(response());vi.stubGlobal('fetch',fetcher);await execute();
    const body=JSON.parse(fetcher.mock.calls[0]![1].body);
    expect(body).toMatchObject({max_tokens:3000,response_format:{type:'json_object'}});
    expect(body).not.toHaveProperty('temperature');expect(body).not.toHaveProperty('max_completion_tokens');
  });
  it('preserves the explicit Anthropic protocol without OpenAI-only fields',async()=>{
    vi.stubEnv('INSPIRATION_CHAT_PROVIDER','copywriting');
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({content:[{type:'text',text:JSON.stringify(answer)}]})));vi.stubGlobal('fetch',fetcher);await execute();
    const body=JSON.parse(fetcher.mock.calls[0]![1].body);
    expect(body).toMatchObject({model:'anthropic-model',max_tokens:3000,stream:false});
    expect(body).not.toHaveProperty('response_format');expect(body).not.toHaveProperty('max_completion_tokens');expect(settings.read).not.toHaveBeenCalled();
  });
});

describe('bounded provider failure diagnostics without paid retry',()=>{
  it.each([
    ['HTTP',()=>new Response('private-key/private-response',{status:400}),{code:'provider_http_error',status:400}],
    ['response JSON',()=>new Response('private-response'),{code:'provider_response_json_invalid'}],
    ['missing content',()=>response(null),{code:'provider_content_missing'}],
    ['output JSON',()=>response('private-response'),{code:'provider_output_json_invalid'}],
    ['schema',()=>response(JSON.stringify({private:'private-response'})),{code:'provider_schema_invalid'}],
    ['citation',()=>response(JSON.stringify({...answer,sections:[{text:'private-response',caseId:'other-case',claimIds:['secret-claim']}]})),{code:'provider_citation_invalid'}],
    ['truncated',()=>response('private-response','length'),{code:'provider_output_truncated'}],
    ['filtered',()=>response('private-response','content_filter'),{code:'provider_content_filtered'}],
    ['oversized',()=>new Response('x'.repeat(256*1024+1)),{code:'provider_response_too_large'}],
  ])('classifies %s without exposing provider text',async(_name,makeResponse,expected)=>{
    const fetcher=vi.fn().mockResolvedValue((makeResponse as ()=>Response)());vi.stubGlobal('fetch',fetcher);
    let caught:unknown;try{await execute();}catch(error){caught=error;}
    expect(inspirationFailureDiagnostic(caught)).toEqual(expected);
    expect(fetcher).toHaveBeenCalledOnce();expect(JSON.stringify(caught)).not.toContain('private-');expect(String(caught)).not.toContain('private-');
  });
  it('discards transport exceptions and their causes',async()=>{
    const fetcher=vi.fn().mockRejectedValue(new Error('private-key/endpoint',{cause:'private-user-question'}));vi.stubGlobal('fetch',fetcher);
    let caught:unknown;try{await execute();}catch(error){caught=error;}
    expect(inspirationFailureDiagnostic(caught)).toEqual({code:'provider_request_failed'});expect(caught).not.toHaveProperty('cause');expect(fetcher).toHaveBeenCalledOnce();
  });
  it('cancels non-success bodies instead of parsing or logging their contents',async()=>{
    const cancel=vi.fn();const stream=new ReadableStream<Uint8Array>({cancel});
    await expect(readInspirationResponse(new Response(stream,{status:429}))).rejects.toMatchObject({code:'provider_http_error',status:429});
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('bounds declared bodies and discards stream exceptions',async()=>{
    await expect(readInspirationResponse(new Response('private-body',{headers:{'content-length':String(256*1024+1)}}))).rejects.toMatchObject({code:'provider_response_too_large'});
    const stream=new ReadableStream<Uint8Array>({start(controller){controller.error(new Error('private-stream-error'));}});
    await expect(readInspirationResponse(new Response(stream))).rejects.toMatchObject({code:'provider_response_read_failed'});
  });
  it('logs only allowlisted codes and integer HTTP status, never arbitrary exceptions',()=>{
    expect(inspirationFailureDiagnostic(new Error('private-key'))).toEqual({code:'task_failed'});
    expect(inspirationFailureDiagnostic(new InspirationFailure('provider_http_error',NaN))).toEqual({code:'provider_http_error'});
    expect(inspirationFailureDiagnostic(new InspirationFailure('provider_http_error',999))).toEqual({code:'provider_http_error'});
    expect(inspirationFailureDiagnostic(new InspirationFailure('provider_request_failed'),true)).toEqual({code:'task_aborted'});
  });
});
