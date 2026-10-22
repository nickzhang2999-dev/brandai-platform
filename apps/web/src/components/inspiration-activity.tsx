'use client';
import {useEffect,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {InspirationActivity as ActivitySchema} from '@brandai/contracts';
import {apiFetch} from '@/lib/client';
import {useBrand} from '@/app/(brandai)/brand-context';

const labels={PENDING:'排队中',RUNNING:'处理中',SUCCEEDED:'已完成',FAILED:'未完成'};
export function InspirationActivity() {
  const {wsId,user}=useBrand(),[open,setOpen]=useState(false),[now,setNow]=useState(Date.now());
  const activity=useQuery({queryKey:['inspiration-activity',wsId,user.id],queryFn:async({signal})=>ActivitySchema.parse(await apiFetch(`/api/workspaces/${encodeURIComponent(wsId)}/inspiration/activity`,{cache:'no-store',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(12000)]),headers:{'X-Novart-User':user.id}})),refetchInterval:5000,retry:false});
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
  const items=activity.isError?[]:(activity.data?.items??[]),active=items.filter(item=>['PENDING','RUNNING'].includes(item.status)&&Date.parse(item.expiresAt)>now);
  if(!items.length&&!activity.isError)return null;
  return <aside aria-label="灵感任务" data-testid="inspiration-activity" className="fixed bottom-5 right-5 z-40 max-w-[calc(100vw-2.5rem)] rounded-2xl border border-border bg-card p-3 text-sm shadow-lg">
    <button type="button" aria-expanded={open} aria-controls="inspiration-activity-panel" className="rounded-lg px-2 py-1 text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" onClick={()=>setOpen(!open)}>灵感任务{active.length?` · ${active.length} 项处理中`:activity.isError?' · 暂未更新':' · 查看结果'}</button>
    {open&&<section id="inspiration-activity-panel" className="mt-2 max-h-72 w-72 max-w-full overflow-auto" aria-label="灵感任务状态">
      {activity.isError?<p role="status" className="text-muted-foreground">状态暂不可用或权限已变化。<button className="ml-2 text-primary" onClick={()=>void activity.refetch()}>重新读取</button></p>:items.map(item=>{
        const pending=['PENDING','RUNNING'].includes(item.status),expired=item.expired||(pending&&Date.parse(item.expiresAt)<=now),elapsed=Math.max(0,Math.floor(((item.expired?Date.parse(item.expiresAt):pending?Math.min(now,Date.parse(item.expiresAt)):Date.parse(item.updatedAt))-Date.parse(item.createdAt))/1000));
        const href=`/inspiration?${new URLSearchParams({workspaceId:wsId,conversationId:item.conversationId})}`;
        return <div key={item.id} className="border-t border-border py-2"><p className="font-medium">灵感问答 · {expired?'已超时':labels[item.status]}</p><p className="mt-1 text-xs text-muted-foreground">{Math.floor(elapsed/60)} 分 {elapsed%60} 秒{pending&&!expired?' · 后台继续处理':''}</p><a className="mt-1 inline-block text-primary underline" href={href}>{expired||item.status==='FAILED'?'返回对话查看并重试':'返回对话'}</a></div>;
      })}
    </section>}
  </aside>;
}
