import {afterEach,describe,expect,it,vi} from 'vitest';
import {PublisherReadError,readPublisher} from '../src/lib/inspiration/publisher-fetch';
const url='https://publisher.invalid/private-path',token='private-token';
afterEach(()=>vi.unstubAllGlobals());
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
