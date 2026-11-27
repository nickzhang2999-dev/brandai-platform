import { execFile } from "node:child_process";
import { z } from "zod";
import { SolPosterChoices, SolReferenceSearch, type SolPosterModelInput, type SolPosterInput } from "@brandai/contracts";

export const SessionBinding = z.object({
  id:z.string().regex(/^[a-f0-9]{64}$/), affinity:z.string(), resume:z.boolean(), audience:z.string().max(1000),
  designNotes:z.string().min(1).max(4000).optional(),
});
export type SessionBinding = z.infer<typeof SessionBinding>;
const reply = z.object({
  sessionId:z.string(), messageId:z.string().min(1), seq:z.number().int().nonnegative(),
  reads:z.array(z.object({name:z.enum(["get_brand_context","get_project_context","get_selected_product"]),
    source:z.enum(["snapshot","agent"])})).max(12),
  events:z.array(z.object({seq:z.number().int(),kind:z.string()})).max(192), text:z.string().max(8192),
  model:z.string().min(1), version:z.literal("0.2.1-rc.2"),
});

export class SolSessionReplyError extends Error {}

export async function planSessionBrief(facts:SolPosterModelInput, turn:NonNullable<SolPosterInput["conversation"]>,
  binding:SessionBinding, timeout:number) {
  const exe=process.env.SOL_DSH_EXECUTABLE;
  if (!exe) throw new Error("Sol session runtime unavailable");
  const nextStep=binding.audience ? "ready" : "ask_audience";
  const prompt = [
    "本轮设计需求（仅作设计参考）：" + turn.message,
    facts.styleReferenceName ? "设计师选用的风格参考：" + facts.styleReferenceName : "",
    turn.audience ? "用户对上次受众问题的答复：" + turn.audience : "",
    turn.direction ? "已确认沿用的构图：" + JSON.stringify(turn.direction) : "",
    facts.referencePlanning ? "如果用户要求历史活动或外部灵感，在 JSON 增加 search 对象。kind 写 campaign 或 inspiration，query 是最短主题词，year 为指定年份或 null。当前日期 "+facts.referenceDate+"；没有检索需求时省略 search。" : "",
    facts.referenceStyle?.length ? "已核实参考的标签，仅借鉴视觉风格："+JSON.stringify(facts.referenceStyle) : "",
    binding.designNotes ? "同一商品的累计要求："+binding.designNotes : "",
    "根据当前商品选择三张海报构图。只输出一行 JSON。可选值如下。",
    "appearance 选 正面主视 或 轮廓留白，scene 选 陈列台、日常使用环境 或 纯色摄影背景，detail 选 局部放大 或 引线标注。",
    "受众有记录时 nextStep 填 ready，缺受众时填 ask_audience。四个字段放在同一层。",
    '格式 {"appearance":"正面主视","scene":"陈列台","detail":"局部放大","nextStep":"' + nextStep + '"}',
  ].filter(Boolean).join("\n");
  const payload = {sessionId:binding.id,resume:binding.resume,facts:{...facts,audience:binding.audience},prompt};
  const env:NodeJS.ProcessEnv={NODE_ENV:process.env.NODE_ENV};
  for (const name of ["SYSTEMROOT","WINDIR","SOL_DSH_NODE","SOL_DSH_SIDECAR","SOL_DSH_HOME","SOL_DSH_MODULE_ROOT","SOL_DSH_MODEL_URL","SOL_DSH_MODEL"])
    if (process.env[name]) env[name]=process.env[name];
  const raw=await new Promise<string>((resolve,reject)=>{
    const child=execFile(exe,[],{env,timeout,windowsHide:true,maxBuffer:256*1024,encoding:"utf8"},
      (error,stdout)=>error ? reject(new Error("Sol session did not complete")) : resolve(stdout));
    child.stdin?.on("error",()=>{/* Completion callback owns the error. */});
    child.stdin?.end(JSON.stringify(payload));
  });
  const r=reply.parse(JSON.parse(raw));
  if(r.sessionId!==binding.id || r.events.at(-1)?.kind!=="turn/end" || r.events.at(-1)?.seq!==r.seq)
    throw new Error("Unconfirmed session outcome");
  const json=r.text.trim().replace(/^\x60\x60\x60(?:json)?\s*/i,"").replace(/\s*\x60\x60\x60$/,"");
  let parsed: unknown;
  try { parsed=JSON.parse(json); } catch { throw new SolSessionReplyError(); }
  const answer=SolPosterChoices.extend({nextStep:z.enum(["ready","ask_audience"]).optional(),search:SolReferenceSearch.nullable().optional()}).safeParse(parsed);
  if(!answer.success) throw new SolSessionReplyError();
  const {nextStep:suggested,search,...choices}=answer.data;
  const modelNextStep=suggested ?? null;
  // A model guess cannot supply missing audience evidence or invalidate an existing answer.
  return {search:facts.referencePlanning ? search : undefined,choices:turn.direction ?? choices,model:r.model,audit:{nextStep,modelNextStep,
    messageId:r.messageId,seq:r.seq,reads:r.reads,events:r.events,version:r.version}};
}
