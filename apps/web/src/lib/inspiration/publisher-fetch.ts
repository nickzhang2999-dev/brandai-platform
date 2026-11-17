import {setTimeout as delay} from 'node:timers/promises';
import {boundedBody} from './config';

export type PublisherPhase='withdrawals'|'discovery'|'manifest'|'part'|'object';
export class PublisherReadError extends Error {
  constructor(readonly phase:PublisherPhase,readonly reason:'network'|'timeout'|'http'|'body',readonly attempts:number,readonly status?:number) {
    super('publisher_read_failed');this.name='PublisherReadError';
  }
}
// Object bodies may legitimately take longer than the metadata request budget.
// Progress resets only the idle timer; the attempt deadline always stays fixed.
function attemptBudget(object:boolean, parent:AbortSignal) {
  const controller=new AbortController();
  const expire=()=>controller.abort(new DOMException('Publisher read timed out','TimeoutError'));
  const total=setTimeout(expire,object?120000:15000);
  let idle:ReturnType<typeof setTimeout>|undefined=object?setTimeout(expire,15000):undefined;
  return {
    signal:AbortSignal.any([parent,controller.signal]),
    timedOut:()=>controller.signal.aborted,
    progress:()=>{if(object){clearTimeout(idle);idle=setTimeout(expire,15000);}},
    close:()=>{clearTimeout(total);clearTimeout(idle);},
  };
}
function abortable<T>(promise:Promise<T>,signal:AbortSignal):Promise<T> {
  return new Promise((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason);};
    signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted)abort();
    promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}
async function objectBody(response:Response,max:number,signal:AbortSignal,progress:()=>void):Promise<Buffer> {
  if(!response.body)throw new Error('Upstream body unavailable');
  if(Number(response.headers.get('content-length')||'0')>max){
    void response.body.cancel().catch(()=>undefined);throw new Error('Upstream body too large');
  }
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try {
    while(true){
      signal.throwIfAborted();
      const {done,value}=await abortable(reader.read(),signal);
      signal.throwIfAborted();
      if(done)break;
      size+=value.byteLength;
      if(size>max)throw new Error('Upstream body too large');
      if(value.byteLength){chunks.push(value);progress();}
    }
    return Buffer.concat(chunks);
  } finally {
    // Cancellation must not extend the fixed deadline if an upstream hangs.
    void reader.cancel().catch(()=>undefined);reader.releaseLock();
  }
}
// Read-only requests only. Never include remote URLs, bodies or credentials in
// errors. A retry repeats the same pinned object; validation stays at the caller.
export async function readPublisher(url:string,token:string,max:number,signal:AbortSignal,phase:PublisherPhase):Promise<Buffer> {
  for(let attempt=1;attempt<=3;attempt++) {
    signal.throwIfAborted();
    const budget=attemptBudget(phase==='object',signal),combined=budget.signal;
    let response:Response|undefined,reason:'network'|'timeout'|'http'|'body'='network',retry=false;
    try {
      response=await fetch(url,{headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:combined,cache:'no-store'});
      combined.throwIfAborted();
      budget.progress();
      if(!response.ok) {
        reason='http';retry=[500,502,503,504].includes(response.status);
        void response.body?.cancel().catch(()=>undefined);
        throw new PublisherReadError(phase,reason,attempt,response.status);
      }
      reason='body';
      return phase==='object'
        ? await objectBody(response,max,combined,budget.progress)
        : await boundedBody(response,max);
    } catch(error) {
      signal.throwIfAborted();
      if(budget.timedOut()){reason='timeout';retry=true;}
      else if(error instanceof TypeError){reason='network';retry=true;}
      if(!retry||attempt===3)throw new PublisherReadError(phase,reason,attempt,response?.status);
    } finally {budget.close();}
    await delay(attempt*500,undefined,{signal});
  }
  throw new PublisherReadError(phase,'network',3);
}
