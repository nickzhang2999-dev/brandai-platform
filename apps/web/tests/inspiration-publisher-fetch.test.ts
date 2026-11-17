import {afterEach,describe,expect,it,vi} from 'vitest';
import {PublisherReadError,readPublisher} from '../src/lib/inspiration/publisher-fetch';
// timers/promises uses Node's internal timer, which Vitest's clock cannot drive.
// Keep backoff durations/cancellation, using the same controllable test clock.
vi.mock('node:timers/promises',()=>({setTimeout:(ms:number,value:unknown,options:{signal:AbortSignal})=>new Promise((resolve,reject)=>{
  const signal=options.signal;
  const abort=()=>{clearTimeout(timer);reject(signal.reason);};
  const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve(value);},ms);
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
})}));
const url='https://publisher.invalid/private-path',token='private-token';
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
describe('bounded publisher reads',()=>{
  it('recovers a transient read using the same URL and authorization',async()=>{
    const fetch=vi.fn().mockRejectedValueOnce(new TypeError('private-network-data')).mockResolvedValueOnce(new Response('ok'));
    vi.stubGlobal('fetch',fetch);
    expect((await readPublisher(url,token,20,new AbortController().signal,'part')).toString()).toBe('ok');
    expect(fetch).toHaveBeenCalledTimes(2);expect(fetch.mock.calls[0]![0]).toBe(fetch.mock.calls[1]![0]);
    expect(fetch.mock.calls[1]![1].headers.Authorization).toBe(`Bearer ${token}`);
  });
  it('caps transient HTTP failures and exposes only safe fields',async()=>{
    const fetch=vi.fn().mockImplementation(()=>Promise.resolve(new Response('private-body',{status:503})));vi.stubGlobal('fetch',fetch);
    const error=await readPublisher(url,token,100,new AbortController().signal,'withdrawals').catch(e=>e);
    expect(error).toBeInstanceOf(PublisherReadError);expect(error).toMatchObject({phase:'withdrawals',reason:'http',attempts:3,status:503});
    expect(fetch).toHaveBeenCalledTimes(3);expect(JSON.stringify(error)).not.toContain('private');
  });
  it.each([401,403,404,429])('does not retry HTTP %s',async status=>{
    const fetch=vi.fn().mockResolvedValue(new Response('',{status}));vi.stubGlobal('fetch',fetch);
    await expect(readPublisher(url,token,20,new AbortController().signal,'part')).rejects.toMatchObject({status,attempts:1});expect(fetch).toHaveBeenCalledOnce();
  });
  it('rejects an oversized body without retry',async()=>{
    const fetch=vi.fn().mockResolvedValue(new Response('oversized'));vi.stubGlobal('fetch',fetch);
    await expect(readPublisher(url,token,2,new AbortController().signal,'object')).rejects.toMatchObject({reason:'body',attempts:1});expect(fetch).toHaveBeenCalledOnce();
  });
  it('aborts before requests and while backing off',async()=>{
    const controller=new AbortController();const fetch=vi.fn().mockImplementation(()=>{controller.abort();throw new TypeError('private');});vi.stubGlobal('fetch',fetch);
    await expect(readPublisher(url,token,20,controller.signal,'part')).rejects.toMatchObject({name:'AbortError'});expect(fetch).toHaveBeenCalledOnce();
    await expect(readPublisher(url,token,20,controller.signal,'part')).rejects.toMatchObject({name:'AbortError'});expect(fetch).toHaveBeenCalledOnce();
  });
});

describe('object transfer budgets',()=>{
  function timedBody(interval:number,count:number,chunkSize=1){
    let timer:ReturnType<typeof setInterval>;
    const cancel=vi.fn(()=>clearInterval(timer));
    const body=new ReadableStream<Uint8Array>({start(controller){
      let sent=0;timer=setInterval(()=>{controller.enqueue(new Uint8Array(chunkSize));
        if(++sent===count){clearInterval(timer);controller.close();}
      },interval);
    },cancel});
    return {response:new Response(body),cancel};
  }
  it('accepts a progressing 10 MiB object that takes 20 seconds',async()=>{
    vi.useFakeTimers();const body=timedBody(5000,4,2560*1024);
    const fetch=vi.fn().mockResolvedValue(body.response);vi.stubGlobal('fetch',fetch);
    const result=readPublisher(url,token,10*1024*1024,new AbortController().signal,'object');
    await vi.advanceTimersByTimeAsync(20000);
    expect((await result).length).toBe(10*1024*1024);expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels stalled body reads after 15 seconds, at most three times',async()=>{
    vi.useFakeTimers();const bodies:ReturnType<typeof timedBody>[]=[];
    const fetch=vi.fn().mockImplementation(()=>{const body=timedBody(20000,1);bodies.push(body);return Promise.resolve(body.response);});
    vi.stubGlobal('fetch',fetch);
    const result=readPublisher(url,token,20,new AbortController().signal,'object').catch(e=>e);
    await vi.advanceTimersByTimeAsync(46500);
    expect(await result).toMatchObject({phase:'object',reason:'timeout',attempts:3,status:200});
    expect(fetch).toHaveBeenCalledTimes(3);expect(bodies.every(b=>b.cancel.mock.calls.length===1)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not extend the 120 second total deadline with continuing progress',async()=>{
    vi.useFakeTimers();const fetch=vi.fn().mockImplementation(()=>Promise.resolve(timedBody(10000,100).response));
    vi.stubGlobal('fetch',fetch);
    const result=readPublisher(url,token,100,new AbortController().signal,'object').catch(e=>e);
    await vi.advanceTimersByTimeAsync(361500);
    expect(await result).toMatchObject({reason:'timeout',attempts:3});expect(fetch).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('still bounds response headers to 15 seconds',async()=>{
    vi.useFakeTimers();const fetch=vi.fn().mockImplementation((_url,{signal})=>new Promise((_resolve,reject)=>{
      signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
    }));vi.stubGlobal('fetch',fetch);
    const result=readPublisher(url,token,100,new AbortController().signal,'object').catch(e=>e);
    await vi.advanceTimersByTimeAsync(46500);
    expect(await result).toMatchObject({reason:'timeout',attempts:3});expect(fetch).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('external cancellation stops a progressing object without retry',async()=>{
    vi.useFakeTimers();const controller=new AbortController(),body=timedBody(5000,10);
    const fetch=vi.fn().mockResolvedValue(body.response);vi.stubGlobal('fetch',fetch);
    const result=readPublisher(url,token,100,controller.signal,'object').catch(e=>e);
    await vi.advanceTimersByTimeAsync(6000);controller.abort();await vi.advanceTimersByTimeAsync(0);
    expect(await result).toMatchObject({name:'AbortError'});expect(fetch).toHaveBeenCalledOnce();
    expect(body.cancel).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
  });
  it('does not let empty chunks refresh the idle deadline',async()=>{
    vi.useFakeTimers();const fetch=vi.fn().mockImplementation(()=>Promise.resolve(timedBody(5000,100,0).response));
    vi.stubGlobal('fetch',fetch);
    const result=readPublisher(url,token,100,new AbortController().signal,'object').catch(e=>e);
    await vi.advanceTimersByTimeAsync(46500);
    expect(await result).toMatchObject({reason:'timeout',attempts:3});expect(vi.getTimerCount()).toBe(0);
  });
});
