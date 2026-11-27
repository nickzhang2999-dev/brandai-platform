"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { SolPosterChoices, SolPosterConfirm, SolPosterInput, SolPosterReceipt, StudioGenerationView } from "@brandai/contracts";

type Props = {
  workspaceId: string; projectId: string; userId: string; readOnly: boolean;
  name?: string; selectionId?: string; prepare: () => Promise<Omit<SolPosterInput, "mutationId">>;
  styleOptions: {assetId: string; name: string}[];
  onOpenProjectMaterials: () => void;
  onGeneration: (task: z.infer<typeof StudioGenerationView>) => void;
  onOpenTask: (requestId: string) => void;
};
const list = z.array(SolPosterReceipt);
const active = (r: SolPosterReceipt) => r.status === "PENDING" || r.status === "RUNNING";
const errorText = (e: unknown) => e instanceof Error ? e.message : "暂时无法读取简报。";
class HistoryError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function SolPosterBriefPanel(props: Props) {
  const endpoint = `/api/workspaces/${encodeURIComponent(props.workspaceId)}/projects/${encodeURIComponent(props.projectId)}/sol-poster-brief`;
  const journal = "sol-brief/v1/" + JSON.stringify([props.userId, props.workspaceId, props.projectId]);
  const [open,setOpen] = useState(false), [rows,setRows] = useState<SolPosterReceipt[]>([]);
  const [error,setError] = useState(""), [ready,setReady] = useState(false), [busy,setBusy] = useState(false);
  const [pending,setPending] = useState<SolPosterInput | null>(null);
  const lifetime = useRef<AbortController | null>(null), locked = useRef(false);
  const revision = useRef(0);
  const [sessionMode,setSessionMode] = useState(false), [message,setMessage]=useState(""), [audience,setAudience]=useState("");
  const [direction,setDirection]=useState<z.infer<typeof SolPosterChoices> | null>(null);
  const [reuse,setReuse]=useState(false);
  const [startFresh,setStartFresh]=useState(false), [canGenerate,setCanGenerate]=useState(false);
  const [styleChoice, setStyleChoice] = useState<string | null>(null);
  const lastForProduct = rows[0]?.target.shapeId === props.selectionId ? rows[0] : undefined;
  const selectedStyleId = styleChoice ?? (startFresh ? "" : lastForProduct?.styleReference?.assetId ?? "");
  const question=rows[0]?.target.shapeId===props.selectionId ? rows[0]?.conversation?.question : null;
  useEffect(()=>{setAudience(""); setStyleChoice(null);},[props.selectionId]);
  const styleKey="sol-composition/v1/"+props.userId;
  useEffect(()=>{
    try {const saved=SolPosterChoices.safeParse(JSON.parse(sessionStorage.getItem(styleKey) ?? "null"));
      setDirection(saved.success ? saved.data : null);} catch {setDirection(null);}
  },[styleKey]);
  const [refresh,setRefresh] = useState(0);
  const read = useCallback(async (signal: AbortSignal) => {
    const token = ++revision.current;
    const res = await fetch(endpoint, { headers: { "X-Novart-User": props.userId }, cache:"no-store",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
    const data = await res.json();
    if (!res.ok) throw new HistoryError(res.status, data.error || "暂时无法读取简报。");
    const values = list.parse(data);
    if (signal.aborted || revision.current !== token) return false;
    setSessionMode(res.headers.get("X-Sol-Conversation")==="1");
    setCanGenerate(res.headers.get("X-Sol-Appearance")==="1");
    const saved = localStorage.getItem(journal);
    let item: SolPosterInput | null = null;
    if (saved) {
      try { item = SolPosterInput.parse(JSON.parse(saved)); }
      catch { localStorage.removeItem(journal); }
    }
    if (item && values.some(r=>r.mutationId === item.mutationId)) localStorage.removeItem(journal);
    setPending(item && !values.some(r=>r.mutationId === item.mutationId) ? item : null);
    setRows(values); setReady(true); setError("");
    return values.some(active);
  },[endpoint,journal,props.userId]);
  useEffect(() => {
    const ctrl = new AbortController(); lifetime.current = ctrl;
    return () => { ctrl.abort(); };
  },[]);
  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout>, failures = 0;
    async function poll() {
      try { if (await read(ctrl.signal)) { failures = 0; if (!ctrl.signal.aborted) timer = setTimeout(poll,2500); } }
      catch (e) {
        if (ctrl.signal.aborted) return;
        setReady(false);
        setError(errorText(e));
        if (e instanceof HistoryError && [401,403,404,409].includes(e.status)) {
          setRows([]);
          setPending(null);
          return;
        }
        if (++failures < 4) timer = setTimeout(poll,1500 * 2 ** failures);
      }
    }
    void poll();
    return () => { ctrl.abort(); clearTimeout(timer); };
  },[read,open,refresh]);

  async function submit() {
    const scope = lifetime.current;
    if (!scope || scope.signal.aborted || locked.current || props.readOnly || !ready) return;
    locked.current = true; setBusy(true); setError("");
    try {
      const last=rows[0];
      const prior=direction ?? last?.result?.choices;
      const carry=(reuse || /沿用|按刚才的方案|按上次的构图/.test(message)) && prior ? prior : undefined;
      const request = pending ?? SolPosterInput.parse({ ...await props.prepare(), mutationId: crypto.randomUUID(),
        ...(selectedStyleId && {styleAssetId: selectedStyleId}),
        ...(sessionMode && {conversation:{message:message.trim() || "为选中的商品规划一张推广海报。",
          parentId:startFresh ? undefined : last?.id, direction:carry, audience:question && !startFresh ? audience.trim() || undefined : undefined}}) });
      if (scope.signal.aborted) return;
      localStorage.setItem(journal,JSON.stringify(request)); setPending(request);
      const res = await fetch(endpoint, { method:"POST", headers:{ "Content-Type":"application/json","X-Novart-User":props.userId },
        body: JSON.stringify(request), signal: AbortSignal.any([scope.signal,AbortSignal.timeout(12000)]) });
      const data = await res.json();
      if (scope.signal.aborted) return;
      if (!res.ok) {
        if ([400,401,403,404,409,422,429].includes(res.status)) { localStorage.removeItem(journal); setPending(null); }
        throw new Error(data.error || "提交结果未知，可刷新核对。");
      }
      const row = SolPosterReceipt.parse(data);
      revision.current++; setRows(old=>[row,...old.filter(r=>r.id!==row.id)]);
      localStorage.removeItem(journal); setPending(null); setMessage(""); setAudience(""); setReuse(false); setStartFresh(false); setRefresh(v=>v+1);
    } catch(e) { if (!scope.signal.aborted) setError(errorText(e)); }
    finally { locked.current=false; if (!scope.signal.aborted) setBusy(false); }
  }
  async function confirmAppearance(row: SolPosterReceipt) {
    const scope = lifetime.current;
    if (!scope || scope.signal.aborted || locked.current || props.readOnly || !ready) return;
    locked.current = true; setBusy(true); setError("");
    try {
      const input = SolPosterConfirm.parse({ ...await props.prepare(), action: "confirm-appearance", briefId: row.id });
      if (scope.signal.aborted) return;
      const response = await fetch(endpoint, { method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json", "X-Novart-User": props.userId },
        body: JSON.stringify(input), signal: AbortSignal.any([scope.signal, AbortSignal.timeout(20000)]) });
      const data = await response.json();
      if (scope.signal.aborted) return;
      if (!response.ok) throw new Error(data.error || "暂时无法确认，请刷新简报记录。");
      const task = StudioGenerationView.parse(data);
      revision.current++;
      setRows(current => current.map(item => item.id === row.id ? { ...item, imageRequestId: task.requestId } : item));
      props.onGeneration(task);
    } catch (e) {
      if (!scope.signal.aborted) setError(e instanceof Error && e.name === "TimeoutError" ? "确认回执超时，请刷新记录核对。" : errorText(e));
    } finally { locked.current = false; if (!scope.signal.aborted) setBusy(false); }
  }
  return <details className="max-h-72 shrink-0 overflow-auto rounded-xl border border-border p-2 text-xs" onToggle={e=>setOpen(e.currentTarget.open)}>
    <summary className="cursor-pointer font-medium">Sol 海报简报</summary>
    {open && <div className="space-y-2 pt-2">
      <p>{props.name ? "当前选中 · "+props.name : "在画布上选一张已保存的商品图。"}</p>
      {sessionMode ? <>
        <label className="block">风格参考
          <select className="block w-full rounded border p-2" value={selectedStyleId} onChange={e => setStyleChoice(e.target.value)}>
            <option value="">仅使用商品图</option>
            {props.styleOptions.map(item => <option key={item.assetId} value={item.assetId}>{item.name}</option>)}
          </select>
        </label>
        <button type="button" className="underline" onClick={props.onOpenProjectMaterials}>在项目资料中添加风格参考</button>
        <label className="block">设计需求<textarea className="block w-full rounded border p-2" maxLength={600}
          value={message} onChange={e=>setMessage(e.target.value)} placeholder="例如，为新品设计一张夏季海报，保留标志和商品颜色" /></label>
        {rows.length > 0 && <label className="flex items-center gap-2"><input type="checkbox" checked={startFresh}
          onChange={e=>setStartFresh(e.target.checked)}/>从新需求开始</label>}
        {question && !startFresh && <label className="block">{question}
          <input className="block w-full rounded border p-2" value={audience} maxLength={160} onChange={e=>setAudience(e.target.value)}/></label>}
        {(direction || rows[0]?.result) && <label className="flex items-center gap-2"><input type="checkbox" checked={reuse}
          onChange={e=>setReuse(e.target.checked)}/>沿用{direction ? "已记住" : "上一份"}的构图</label>}
      </> : <p className="text-muted-foreground">使用素材名称和已保存的项目、品牌资料，规划三张海报。</p>}
      <button type="button" className="rounded-xl bg-primary px-3 py-2 text-primary-foreground disabled:opacity-40"
        disabled={props.readOnly || !ready || busy || (!pending && (!props.name || rows.some(active)))} onClick={()=>void submit()}>
        {busy ? "提交中…" : pending ? "确认上次提交" : "生成海报简报"}</button>
      <button type="button" className="ml-2 underline" onClick={()=>setRefresh(v=>v+1)}>刷新记录</button>
      {error && <p role="alert">{error}</p>}
      {rows.map(row=><article key={row.id} data-brief-id={row.id} className="space-y-1 border-t border-border pt-2">
        <h4 className="font-semibold">{row.product} · {row.brand}</h4>
        {row.styleReference && <p>风格参考 · {row.styleReference.name}</p>}
        {row.conversation?.designNotes && row.conversation.designNotes !== row.conversation.message &&
          <details><summary className="cursor-pointer">查看累计设计需求</summary><p className="whitespace-pre-wrap">{row.conversation.designNotes}</p></details>}
        {row.conversation && <p>{row.conversation.message}{row.conversation.audience && " · 受众："+row.conversation.audience}</p>}
        <p className="text-muted-foreground">画布版本 {row.documentRevision} · 项目资料版本 {row.contextRevision}</p>
        {row.result ? <><ol className="list-decimal pl-4">
          <li>外观图 · {row.result.choices.appearance}</li><li>场景图 · {row.result.choices.scene}</li>
          <li>卖点图 · {row.result.choices.detail}</li></ol>
          {sessionMode && <button type="button" className="underline" onClick={()=>{
            const choices=row.result!.choices;
            sessionStorage.setItem(styleKey,JSON.stringify(choices));setDirection(choices);
          }}>记住这组构图</button>}
          <p className="whitespace-pre-wrap">{row.result.approvedCopy
            ? "商品已确认文案 · " + row.result.approvedCopy
            : "商品卖点待确认。可在项目资料中指定一张商品素材并保存对应文案。"}</p>
          {row.result.visualRequirements && <p>视觉要求 · {row.result.visualRequirements}</p>}
          {row.conversation?.reusedDirection && <p>已沿用构图，商品与品牌资料取自本次选区。</p>}
          {row.result.rules.map((rule,i)=><p key={i}>品牌规范 · {rule}</p>)}
          {row.imageRequestId ? <button type="button" className="underline" onClick={() => props.onOpenTask(row.imageRequestId!)}>已提交外观图 · 查看任务记录</button>
            : canGenerate && row.id === rows[0]?.id && row.conversation?.audience && !row.conversation.question && <button type="button"
              className="rounded-xl bg-primary px-3 py-2 text-primary-foreground disabled:opacity-40"
              disabled={props.readOnly || !ready || busy || !!pending || !!message.trim() || reuse || startFresh || props.selectionId !== row.target.shapeId || selectedStyleId !== (row.styleReference?.assetId ?? "")}
              onClick={()=>void confirmAppearance(row)}>确认简报，生成一张外观图（1:1）</button>}</>
        : <p role="status">{row.error ?? (row.status==="RUNNING" ? "正在规划…" : "已排队")}</p>}
      </article>)}
    </div>}
  </details>;
}
