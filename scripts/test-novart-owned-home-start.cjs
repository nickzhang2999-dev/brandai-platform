'use strict';
// Runs the real product script against synthetic DOM/IDB/task receipts. These
// protocol boundary tests are not evidence of production upload/save success.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {randomUUID} = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname,'../deploy/novart/studio/novart-owned-home-start.js'),'utf8');
class TestFile extends Blob { constructor(parts,name,options) { super(parts,options); this.name=name; } }
const file = name => new TestFile(['synthetic-test-bytes'],name || 'fixture.png',{type:'image/png'});
const material = {id:'material-fixture',assetId:'asset-fixture',assetSha256:'a'.repeat(64),kind:'image',mimeType:'image/png',fileName:'fixture.png',sizeBytes:20,width:80,height:60,url:'/api/workspaces/workspace-fixture/assets/asset-fixture/raw'};
async function flush(condition = () => true) { for(let i=0;i<150;i++) { await new Promise(resolve => setImmediate(resolve)); if(condition()) return; } throw new Error('Synthetic boundary did not settle'); }
function findControl(fixture,label) {
  const visit = item => item.textContent===label || item['aria-label']===label ? item : (item.children||[]).map(visit).find(Boolean);
  return [...fixture.elements.values()].map(visit).find(Boolean);
}
function harness(options = {}) {
  const elements = new Map(), events = new Map(), timers = new Set(), writes = [], posts = [], requests = [], creates = [], notices = [];
  let stored = options.stored || null, active = false, now = Date.parse('2026-10-10T00:00:00Z'), apiCalls = 0, refreshed = 0, module;
  class Element {
    constructor(tag='div',text='') { this.tag=tag;this.textContent=text;this.children=[];this.listeners={};this.dataset={};this.value='';this.hidden=false;this.inert=false;this.classList={add(){},remove(){}}; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children=children; }
    addEventListener(name,callback) { this.listeners[name]=callback; }
    setAttribute(name,value) { this[name]=value; }
    querySelector() { return this.span ||= new Element('span'); }
    contains() { return false; }
    focus() { this.focused=true; }
    click() { return this.onclick?.(); }
  }
  const get = id => { if(!elements.has(id)) elements.set(id,new Element()); return elements.get(id); };
  function timer(callback,ms) { const token={callback,ms};timers.add(token);return token; }
  function clear(token) { timers.delete(token); }
  // `stored` is this brand's record; `legacy` is the pre-brand shared key.
  let legacy = options.legacy || null; const keys = new Set();
  const isLegacy = k => k === 'owned-home-start-v1';
  const db = {createObjectStore(){}, transaction(_name,mode) {
    const tx={abort(){tx.onabort?.();},objectStore(){return {
      get(k){keys.add(k);const request={};queueMicrotask(()=>{request.result=isLegacy(k)?legacy:stored;tx.oncomplete?.();});return request;},
      put(value,k){keys.add(k);const request={};queueMicrotask(()=>{if(options.failWrites){tx.onerror?.();return;}if(isLegacy(k))legacy=structuredClone(value);else{stored=structuredClone(value);writes.push(stored);}tx.oncomplete?.();});return request;},
      delete(k){keys.add(k);const request={};queueMicrotask(()=>{if(isLegacy(k))legacy=null;else stored=null;tx.oncomplete?.();});return request;},
    };}}; return tx;
  }};
  const indexedDB={open(){const request={result:db};queueMicrotask(()=>{request.onupgradeneeded?.();request.onsuccess?.();});return request;}};
  const entry={id:'project-fixture',ready:true,frame:{inert:false,contentWindow:{postMessage(value,origin){posts.push({value,origin});options.onPost?.(value,fixture);if(options.autoAck!==false)queueMicrotask(()=>ack(value));}}}};
  function dispatch(data,sourceWindow=entry.frame.contentWindow,origin='https://novart.test') { events.get('message')?.({data,source:sourceWindow,origin}); }
  function ack(value,extra={}) { dispatch({type:'nv-studio',action:value.action==='start-creation'?'start-creation-result':'insert-material-result',projectId:entry.id,requestId:value.requestId,status:value.action==='start-creation'?'accepted':'saved',revision:1,...extra}); }
  const task = (mutationId,status='SUCCEEDED') => ({taskId:'task-'+mutationId,projectId:entry.id,mutationId,status,progress:status==='SUCCEEDED'?100:30,expiresAt:new Date(now+360000).toISOString(),...(status==='SUCCEEDED'?{material}:status==='FAILED'?{error:'Synthetic upload failure'}:{})});
  const host={
    async api(url,payload){creates.push({url,payload});apiCalls++;assert.equal(stored?.submitted?.requestId,payload.requestId,'Creation identity must be durable before network');if(options.loseCreateOnce&&apiCalls===1)throw new Error('synthetic lost response');return {projectId:entry.id};},
    node:(tag,_class,text)=>new Element(tag,text),button:(text,_class,action)=>{const value=new Element('button',text);value.onclick=action;return value;},notify:value=>notices.push(value),
    legacyBlocked:()=>false,composing:()=>false,reloadProjects:async()=>{},project:id=>id===entry.id?{projectId:id}:null,
    openProject(){active=true;context.location.hash='#/workspace/'+entry.id;},current:value=>active&&value===entry,goProjects(){active=false;context.location.hash='#/projects';},invalidateAssets(){},showRequirements(){},refreshImportedFrame(){refreshed++;},
  };
  const context={window:null,document:{getElementById:get,querySelectorAll:()=>[entry.frame]},indexedDB,Blob,File:TestFile,FormData,AbortController,Error,TypeError,Number,Promise,Map,Set,Date:class extends Date{static now(){return now;}},
    location:{origin:'https://novart.test',hash:'#/home'},URL:{createObjectURL:()=> 'blob:synthetic',revokeObjectURL(){}},localStorage:{removeItem(){}},crypto:{randomUUID},
    navigator: options.noLocks?{}:{locks:{request:async(_name,_options,callback)=>callback(options.lockUnavailable?null:{})}},
    setTimeout:timer,clearTimeout:clear,__NOVART_PRODUCT__:{workspaceId:'workspace-fixture'},
    addEventListener:(name,callback)=>events.set(name,callback),removeEventListener:name=>events.delete(name),
    async fetch(url,init){requests.push({url,init});const mutationId=init.method==='POST'?init.body.get('mutationId'):url.split('taskId=task-')[1];if(init.method==='POST'){assert(stored.items.some(item=>item.id===mutationId),'Upload mutation must be durable');assert.equal(init.body.get('projectId'),entry.id);}const result=options.respond?await options.respond({url,init,mutationId,task,fixture}):task(mutationId);return {ok:true,status:200,json:async()=>result};},
  };
  context.window=context;
  const fixture={entry,host,elements,events,timers,writes,posts,requests,creates,notices,task,dispatch,ack,get data(){return stored;},get legacy(){return legacy;},get keys(){return [...keys];},get module(){return module;},
    async ready(){await flush(()=>module.snapshot().loaded);},async add(files=[file()]){get('hs-file-input').listeners.change({target:{files,value:'selected'}});await flush(()=>stored?.items?.length===Math.min(files.length,4)||get('hs-draft-note').textContent);},
    async create(){await module.create();},async resume(){return module.resume(entry,true);},activate(){active=true;},get,get refreshed(){return refreshed;},completeInSibling(){stored={version:1,items:[],submitted:null};},replaceInSibling(value){stored=structuredClone(value);},
    fire(ms){const match=[...timers].find(value=>value.ms===ms);assert(match,'Expected bounded timer');clear(match);now+=ms;match.callback();},
  };
  vm.runInNewContext(source,context);module=context.createHomeStart(host);return fixture;
}

(async()=>{
  let count=0;
  {
    const f=harness();await f.ready();await f.add(Array.from({length:5},(_,i)=>file('image'+i+'.png')));
    assert.equal(f.module.snapshot().attachmentCount,4);assert.equal(f.requests.length,0);assert.equal(f.creates.length,0);assert(f.notices.some(value=>value.includes('4')));count++;
  }
  {
    const f=harness({loseCreateOnce:true});await f.ready();await f.add();await f.create();assert(f.module.hasDraft());const identity=f.creates[0].payload.requestId;await f.create();assert.equal(f.creates[1].payload.requestId,identity);assert.equal(f.data.submitted.projectId,f.entry.id);count++;
  }
  {
    const f=harness({failWrites:true});await f.ready();await f.add();await f.create();assert.equal(f.creates.length,0);assert.equal(f.requests.length,0);assert(f.module.hasDraft());count++;
  }
  {
    const f=harness({autoAck:false});await f.ready();await f.add();await f.create();f.entry.ready=false;await f.resume();assert.equal(f.requests.length,0);f.entry.ready=true;
    const run=f.resume();await flush(()=>f.posts.length===1);const post=f.posts[0].value;
    assert.equal(post.action,'insert-material');assert(f.data.items[0].file instanceof Blob);assert.equal(f.data.items[0].material,undefined);assert.equal(f.data.items[0].saved,undefined);
    f.dispatch({type:'nv-studio',action:'insert-material-result',projectId:f.entry.id,requestId:post.requestId,status:'saved',revision:1},{},'https://novart.test');
    f.dispatch({type:'nv-studio',action:'insert-material-result',projectId:f.entry.id,requestId:post.requestId,status:'saved',revision:1},f.entry.frame.contentWindow,'https://other.invalid');
    f.ack(post,{projectId:'wrong'});f.ack(post,{revision:0});await flush();assert(f.module.hasDraft(),'Invalid receipts cannot discard originals');
    f.ack(post);await run;assert.equal(f.module.hasDraft(),false);assert.equal(f.data.items.length,0);assert(f.notices.some(value=>value.includes('已保存')));count++;
  }
  {
    const f=harness({autoAck:false});await f.ready();await f.add();await f.create();const run=f.resume();await flush(()=>f.posts.length===1);const requestId=f.posts[0].value.requestId;
    f.ack(f.posts[0].value,{status:'failed',error:'synthetic save conflict'});await run;assert(f.module.hasDraft());assert(f.data.items[0].file instanceof Blob);
    const retry=f.resume();await flush(()=>f.posts.length===2);assert.equal(f.posts[1].value.requestId,requestId);assert.equal(f.requests.filter(value=>value.init.method==='POST').length,1);
    f.ack(f.posts[1].value);await retry;assert.equal(f.module.hasDraft(),false);count++;
  }
  {
    const f=harness({autoAck:false});await f.ready();await f.add();await f.create();const run=f.resume();await flush(()=>f.posts.length===1);
    f.fire(120000);await run;assert(f.module.hasDraft());assert.equal(f.module.snapshot().running.length,0);assert(f.data.items[0].taskId);assert(f.get('hs-handoff').children.some(value=>String(value.textContent).includes('未确认')));count++;
  }
  {
    const f=harness({respond:({task,mutationId})=>({...task(mutationId),projectId:'another-project'})});await f.ready();await f.add();await f.create();await f.resume();assert.equal(f.posts.length,0);assert(f.module.hasDraft());count++;
  }
  {
    let failed=true;const f=harness({respond:({task,mutationId})=>task(mutationId,failed?'FAILED':'SUCCEEDED')});await f.ready();await f.add();await f.create();await f.resume();const first=f.requests[0].init.body.get('mutationId');assert(f.module.hasDraft());
    const actions=f.get('hs-handoff').children.find(value=>value.children.some(child=>child.textContent==='重新上传失败图片'));assert(actions);
    failed=false;await actions.children.find(value=>value.textContent==='重新上传失败图片').click();await flush(()=>!f.module.hasDraft());
    const mutations=f.requests.filter(value=>value.init.method==='POST').map(value=>value.init.body.get('mutationId'));assert.equal(mutations.length,2);assert.notEqual(mutations[1],first);count++;
  }
  {
    const f=harness({lockUnavailable:true});await f.ready();await f.add();await f.create();await f.resume();assert.equal(f.requests.length,0);assert(f.module.hasDraft());count++;
  }
  {
    const options={lockUnavailable:true};const f=harness(options);await f.ready();await f.add();await f.create();await f.resume();assert.equal(f.entry.frame.inert,true);
    f.completeInSibling();options.lockUnavailable=false;await f.resume();assert.equal(f.requests.length,0);assert.equal(f.refreshed,1);assert.equal(f.module.hasDraft(),false);count++;
  }
  {
    const f=harness({respond:({task,mutationId,init})=>task(mutationId,init.method==='POST'?'PENDING':'SUCCEEDED')});await f.ready();await f.add();await f.create();const run=f.resume();
    await flush(()=>[...f.timers].some(value=>value.ms===1500));assert.equal(f.posts.length,0);assert(f.module.hasDraft());f.fire(1500);await run;
    assert.equal(f.requests.length,2);assert(f.requests[1].url.includes('taskId=task-'));assert.equal(f.posts.length,1);assert.equal(f.module.hasDraft(),false);count++;
  }
  {
    const f=harness();await f.ready();await f.create();assert.equal(f.creates.length,0);assert.equal(f.posts.length,0);assert(f.get('ns-home-brief').focused);count++;
  }
  {
    const f=harness();await f.ready();const text='完整需求'.repeat(1001);f.get('ns-home-brief').value=text;await f.create();assert.equal(f.creates.length,0);assert.equal(f.get('ns-home-brief').value,text);assert(f.get('ns-create-status').textContent.includes('4000'));count++;
  }
  {
    const f=harness();await f.ready();f.get('ns-home-brief').value='日落时分的海边场景';await f.create();const identity=f.data.submitted.requestId;assert.equal(f.data.submitted.startCreation,true);await f.resume();
    assert.equal(f.creates.length,1);assert.equal(f.requests.length,0);assert.equal(f.posts.length,1);assert.equal(f.posts[0].value.action,'start-creation');assert.equal(f.posts[0].value.requestId,identity);assert.deepEqual([...f.posts[0].value.referenceShapeIds],[]);assert.equal(f.module.hasDraft(),false);assert.equal(f.get('ns-home-brief').value,'');count++;
  }
  {
    const f=harness();await f.ready();f.get('ns-home-brief').value='😀'.repeat(2001);await f.create();assert.equal(f.creates.length,0);assert.equal(f.get('ns-home-brief').value,'😀'.repeat(2001));f.get('ns-home-brief').value='😀'.repeat(2000);await f.create();await f.resume();assert.equal(f.posts[0].value.text,'😀'.repeat(2000));count++;
  }
  {
    const f=harness({autoAck:false});await f.ready();f.get('ns-home-brief').value='参考原图创作海报';await f.add();await f.create();const creationId=f.data.submitted.requestId;const run=f.resume();await flush(()=>f.posts.length===1);
    const insert=f.posts[0].value;assert.equal(insert.action,'insert-material');assert.equal(f.data.submitted.creationAccepted,false);assert(f.data.items.length);
    f.ack(insert);await flush(()=>f.posts.length===2);const creation=f.posts[1].value;assert.equal(creation.action,'start-creation');assert.equal(creation.requestId,creationId);assert.deepEqual([...creation.referenceShapeIds],['shape:home-'+insert.requestId]);assert(f.module.hasDraft());
    f.ack(creation,{action:'insert-material-result'});f.ack(creation,{status:'saved'});f.ack(creation,{projectId:'other-project'});await flush();assert(f.module.hasDraft(),'Mismatched creation receipts cannot discard recovery');
    f.ack(creation);await run;assert.equal(f.module.hasDraft(),false);count++;
  }
  {
    const f=harness({autoAck:false});await f.ready();f.get('ns-home-brief').value='月光下的森林';await f.create();const run=f.resume();await flush(()=>f.posts.length===1);const first=f.posts[0].value;
    await f.module.resume(f.entry,true);assert.equal(f.posts.length,1,'Repeated start while waiting must stay in the same run');
    f.fire(30000);await run;assert.equal(f.data.submitted.requestId,first.requestId);assert.equal(f.get('ns-home-brief').value,first.text);
    const retry=f.resume();await flush(()=>f.posts.length===2);assert.deepEqual(f.posts[1].value,first);assert.equal(f.creates.length,1);f.ack(f.posts[1].value);await retry;assert.equal(f.module.hasDraft(),false);count++;
  }
  {
    const f=harness({autoAck:false});await f.ready();f.get('ns-home-brief').value='另一份需求';await f.create();const run=f.resume();await flush(()=>f.posts.length===1);const first=f.posts[0].value;
    f.ack(first,{status:'failed',error:'Synthetic editor save rejected'});await run;assert(f.module.hasDraft());
    const recovered=harness({stored:f.data});await recovered.ready();await recovered.create();await recovered.resume();assert.equal(recovered.creates.length,0);assert.equal(recovered.posts[0].value.requestId,first.requestId);assert.equal(recovered.posts[0].value.text,first.text);count++;
  }
  {
    const requestId=randomUUID(),f=harness({stored:{version:1,items:[],submitted:{requestId,projectId:'project-fixture',brief:'旧版仅保存需求',projectName:'旧项目'}}});await f.ready();await f.create();await f.resume();assert.equal(f.creates.length,0);assert.equal(f.posts.length,0,'Historical records are upload-only, never retrospective paid creation');assert.equal(f.module.hasDraft(),false);count++;
  }
  {
    const requestId=randomUUID(),f=harness({stored:{version:1,items:[],submitted:{requestId,projectId:'project-fixture',brief:'已受理的需求',projectName:'项目',startCreation:true,creationAccepted:true}}});await f.ready();await f.create();await f.resume();assert.equal(f.posts.length,0,'Persisted accepted receipt suppresses even idempotent resubmission');assert.equal(f.module.hasDraft(),false);count++;
  }
  {
    const options={lockUnavailable:true};const f=harness(options);await f.ready();f.get('ns-home-brief').value='同一份跨页需求';await f.create();await f.resume();assert.equal(f.posts.length,0);
    f.completeInSibling();options.lockUnavailable=false;await f.resume();assert.equal(f.posts.length,0);assert.equal(f.refreshed,1);assert.equal(f.module.hasDraft(),false);count++;
  }
  {
    const f=harness({respond:({task,mutationId})=>task(mutationId,'FAILED')});await f.ready();f.get('ns-home-brief').value='保留失败图片的原始需求';await f.add();await f.create();await f.resume();
    const remove=findControl(f,'移除 fixture.png');assert(remove);assert.equal(remove.disabled,false);assert.equal(f.get('hs-attachments').children[0].dataset.state,'error');
    await remove.click();await flush(()=>!f.module.snapshot().recoveryPending);assert.equal(f.module.snapshot().submittedRequestId,null);assert.equal(f.module.snapshot().attachmentCount,0);assert.equal(f.get('ns-create-blank').disabled,false);assert.equal(f.get('ns-home-brief').value,'保留失败图片的原始需求');assert.equal(f.creates.length,1);assert.equal(f.posts.length,0);count++;
  }
  {
    const f=harness({respond:({task,mutationId})=>task(mutationId,'FAILED')});await f.ready();f.get('ns-home-brief').value='结束交接仍保留需求';await f.add();await f.create();await f.resume();const previous=f.data;
    const end=findControl(f,'结束交接并进入项目');assert(end);assert.equal(end.disabled,false);await end.click();await flush(()=>!f.module.snapshot().recoveryPending);
    assert.equal(f.module.snapshot().submittedRequestId,null);assert.equal(f.data.items.length,1);assert(f.data.items[0].file instanceof Blob);assert.notEqual(f.data.items[0].id,previous.items[0].id);assert.equal(f.get('ns-home-brief').value,previous.submitted.brief);assert.equal(f.entry.frame.inert,false);assert.equal(f.creates.length,1);assert.equal(f.posts.length,0);count++;
  }
  {
    const options={respond:({task,mutationId})=>task(mutationId,'FAILED')};const f=harness(options);await f.ready();await f.add();await f.create();await f.resume();const previous=f.data;options.failWrites=true;
    await findControl(f,'移除 fixture.png').click();await flush(()=>Boolean(f.module.snapshot().recoveryError));assert.equal(f.module.snapshot().attachmentCount,1);assert.equal(f.module.snapshot().submittedRequestId,previous.submitted.requestId);assert.equal(f.data.items[0].id,previous.items[0].id);assert.equal(f.data.submitted.requestId,previous.submitted.requestId);assert.equal(f.posts.length,0);
    options.failWrites=false;await findControl(f,'移除 fixture.png').click();await flush(()=>!f.module.snapshot().recoveryPending);assert.equal(f.module.snapshot().attachmentCount,0);assert.equal(f.module.snapshot().submittedRequestId,null);count++;
  }
  {
    const options={respond:({task,mutationId})=>task(mutationId,'FAILED')};const f=harness(options);await f.ready();await f.add();await f.create();await f.resume();const previous=f.data;options.failWrites=true;
    await findControl(f,'重新上传失败图片').click();await flush(()=>Boolean(f.module.snapshot().recoveryError));assert.equal(f.requests.length,1);assert.equal(f.data.items[0].id,previous.items[0].id);assert.equal(f.data.items[0].taskId,previous.items[0].taskId);assert.equal(f.module.snapshot().submittedRequestId,previous.submitted.requestId);
    options.failWrites=false;options.respond=({task,mutationId})=>task(mutationId);await findControl(f,'重新上传失败图片').click();await flush(()=>!f.module.hasDraft());assert.equal(f.requests.filter(r=>r.init.method==='POST').length,2);assert.notEqual(f.requests.at(-1).init.body.get('mutationId'),previous.items[0].id);assert.equal(f.creates.length,1);count++;
  }
  {
    const options={respond:()=>{throw new TypeError('Synthetic lost upload response');}};const f=harness(options);await f.ready();f.get('ns-home-brief').value='未知上传必须先确认';await f.add();await f.create();await f.resume();const previous=f.data;
    assert.equal(findControl(f,'移除 fixture.png').disabled,true);const end=findControl(f,'结束交接并进入项目');assert(!end||end.disabled);assert.equal(previous.items[0].uploadStarted,true);
    options.respond=({task,mutationId})=>task(mutationId);await f.resume();const posts=f.requests.filter(r=>r.init.method==='POST');assert.equal(posts.length,2);assert.equal(posts[0].init.body.get('mutationId'),posts[1].init.body.get('mutationId'));assert.equal(f.creates.length,1);assert.equal(f.posts.filter(p=>p.value.action==='start-creation').length,1);assert.equal(f.module.hasDraft(),false);count++;
  }
  {
    const f=harness({autoAck:false});await f.ready();f.get('ns-home-brief').value='首图结果未知不能结束交接';await f.create();const run=f.resume();await flush(()=>f.posts.length===1);assert.equal(f.data.submitted.creationStarted,true);const original=f.posts[0].value;
    f.fire(30000);await run;const end=findControl(f,'结束交接并进入项目');assert(!end||end.disabled);const restored=harness({stored:f.data});await restored.ready();const homeEnd=findControl(restored,'结束交接，保留项目');assert(!homeEnd||homeEnd.disabled);await restored.create();await restored.resume();assert.equal(restored.posts[0].value.requestId,original.requestId);assert.equal(restored.creates.length,0);assert.equal(restored.module.hasDraft(),false);count++;
  }
  {
    const f=harness({respond:({task,mutationId})=>task(mutationId,'FAILED')});await f.ready();await f.add();await f.create();await f.resume();let release;const held=new Promise(resolve=>{release=resolve;});const restored=harness({stored:f.data,respond:async({task,mutationId})=>{await held;return task(mutationId,'FAILED');}});await restored.ready();assert.equal(findControl(restored,'移除 fixture.png').disabled,true);
    release();await flush(()=>!restored.module.snapshot().checkingRecovery);assert.equal(restored.requests.length,1);assert.notEqual(restored.requests[0].init.method,'POST');assert.equal(findControl(restored,'移除 fixture.png').disabled,false);assert.equal(restored.creates.length,0);count++;
  }
  {
    const f=harness({respond:({task,mutationId})=>task(mutationId,'FAILED')});await f.ready();await f.add();await f.create();await f.resume();const previous=f.data;
    f.replaceInSibling({...previous,submitted:{...previous.submitted,creationStarted:true}});await findControl(f,'结束交接并进入项目').click();await flush();assert.equal(f.module.snapshot().submittedRequestId,previous.submitted.requestId);assert.equal(f.module.snapshot().attachmentCount,1);assert.equal(f.data.submitted.creationStarted,true);assert.equal(f.module.snapshot().canEndHandoff,false);assert.equal(f.requests.length,1);count++;
  }
  {
    const f=harness({respond:({task,mutationId})=>task(mutationId,'FAILED')});await f.ready();await f.add();await f.create();await f.resume();const draft={...f.data.items[0],id:randomUUID(),taskId:null,uploadStarted:false};f.replaceInSibling({version:1,items:[draft],submitted:null});await f.resume();assert.equal(f.module.snapshot().submittedRequestId,null);assert.equal(f.module.snapshot().attachmentCount,1);assert.equal(f.data.items[0].id,draft.id);assert(f.data.items[0].file instanceof Blob);assert.equal(f.requests.length,1);assert.equal(f.entry.frame.inert,false);count++;
  }
  {
    const options={respond:({task,mutationId})=>task(mutationId,'FAILED')};const f=harness(options);await f.ready();await f.add();await f.create();await f.resume();const previous=f.data;options.lockUnavailable=true;await findControl(f,'结束交接并进入项目').click();await flush();assert.equal(f.module.snapshot().submittedRequestId,previous.submitted.requestId);assert.equal(f.data.items[0].id,previous.items[0].id);assert.equal(f.requests.length,1);assert(f.notices.some(text=>text.includes('另一页面')));count++;
  }
  {
    const f=harness({respond:({task,mutationId})=>({...task(mutationId,'FAILED'),error:'图片损坏或格式不受支持。请上传 4000 万像素以内的静态 PNG、JPEG 或 WebP。'})});await f.ready();await f.add();await f.create();await f.resume();assert(findControl(f,'更换失败图片'));assert.equal(findControl(f,'重新上传失败图片'),undefined);assert.equal(findControl(f,'移除 fixture.png').disabled,false);assert.equal(f.requests.length,1);count++;
  }
  {
    const raw='INTERNAL STORAGE ERROR https://secret.invalid/?token=not-a-real-secret';const f=harness({respond:({task,mutationId})=>({...task(mutationId,'FAILED'),error:raw})});await f.ready();await f.add();await f.create();await f.resume();const text=node=>[node.textContent,...(node.children||[]).map(text)].join(' ');assert(![...f.elements.values()].map(text).join(' ').includes(raw));assert(findControl(f,'重新上传失败图片'));assert.equal(f.module.snapshot().failedCount,1);count++;
  }
  {
    const options={respond:({task,mutationId})=>task(mutationId,'FAILED')};const f=harness(options);await f.ready();await f.add([file('first.png'),file('second.png')]);await f.create();await f.resume();options.failWrites=true;await findControl(f,'移除失败图片').click();await flush(()=>Boolean(f.module.snapshot().recoveryError));assert.equal(f.module.snapshot().attachmentCount,2);assert.equal(findControl(f,'失败图片已移除'),undefined);options.failWrites=false;await findControl(f,'移除失败图片').click();await flush(()=>!f.module.snapshot().recoveryPending);assert.equal(f.module.snapshot().attachmentCount,1);assert.equal(f.data.items[0].name,'second.png');assert(findControl(f,'失败图片已移除'));assert.equal(f.posts.length,0);assert.equal(f.requests.length,1);count++;
  }
  {
    // Recovery is stored per brand, never under the shared key.
    const f=harness();await f.ready();f.get('ns-home-brief').value='品牌隔离';await f.create();
    assert(f.keys.includes('owned-home-start-v1:workspace-fixture'));assert(!f.keys.some(k=>k==='owned-home-start-v1'&&f.legacy));count++;
  }
  {
    // A pre-brand record for a project of this brand is adopted and the shared copy removed.
    const requestId=randomUUID(),record={version:1,items:[],submitted:{requestId,projectId:'project-fixture',brief:'旧记录',projectName:'旧项目'}};
    const f=harness({legacy:record});await f.ready();assert.equal(f.data?.submitted?.requestId,requestId);assert.equal(f.legacy,null);count++;
  }
  {
    // A pre-brand record for another brand's project is left untouched for that brand.
    const requestId=randomUUID(),record={version:1,items:[],submitted:{requestId,projectId:'project-other-brand',brief:'别的品牌',projectName:'别家'}};
    const f=harness({legacy:record});await f.ready();assert.equal(f.data,null);assert.equal(f.legacy?.submitted?.requestId,requestId);assert.equal(f.module.hasDraft(),false);count++;
  }
  {
    // A pre-brand record with no project yet has nothing tying it elsewhere and is adopted.
    const requestId=randomUUID(),record={version:1,items:[],submitted:{requestId,projectId:null,brief:'未建项目',projectName:'新项目'}};
    const f=harness({legacy:record});await f.ready();assert.equal(f.data?.submitted?.requestId,requestId);assert.equal(f.legacy,null);count++;
  }
  assert(!source.includes('/studio/start/'));assert(!source.includes('webpack'));assert(!source.includes('/studio/generation'));
  console.log(`Owned homepage protocol boundary checks: ${count} passed; production services were not exercised.`);
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
