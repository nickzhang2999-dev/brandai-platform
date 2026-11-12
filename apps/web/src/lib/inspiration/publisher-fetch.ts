import {setTimeout as delay} from 'node:timers/promises';
import {boundedBody} from './config';

export type PublisherPhase='withdrawals'|'discovery'|'manifest'|'part'|'object';
export class PublisherReadError extends Error {
  constructor(readonly phase:PublisherPhase,readonly reason:'network'|'timeout'|'http'|'body',readonly attempts:number,readonly status?:number) {
    super('publisher_read_failed');this.name='PublisherReadError';
  }
}
// Read-only requests only. Never include remote URLs, bodies or credentials in
// errors. A retry repeats the same pinned object; validation stays at the caller.
export async function readPublisher(url:string,token:string,max:number,signal:AbortSignal,phase:PublisherPhase):Promise<Buffer> {
  for(let attempt=1;attempt<=3;attempt++) {
    signal.throwIfAborted();
    const timeout=AbortSignal.timeout(15000),combined=AbortSignal.any([signal,timeout]);
    let response:Response|undefined,reason:'network'|'timeout'|'http'|'body'='network',retry=false;
    try {
      response=await fetch(url,{headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:combined,cache:'no-store'});
      if(!response.ok) {
        reason='http';retry=[500,502,503,504].includes(response.status);
        await response.body?.cancel();
        throw new PublisherReadError(phase,reason,attempt,response.status);
      }
      reason='body';
      return await boundedBody(response,max);
    } catch(error) {
      signal.throwIfAborted();
      if(timeout.aborted){reason='timeout';retry=true;}
      else if(error instanceof TypeError){reason='network';retry=true;}
      if(!retry||attempt===3)throw new PublisherReadError(phase,reason,attempt,response?.status);
      await delay(attempt*500,undefined,{signal});
    }
  }
  throw new PublisherReadError(phase,'network',3);
}
