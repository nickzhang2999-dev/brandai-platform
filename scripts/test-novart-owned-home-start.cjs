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
    click() { return this.onclick?.(); }
  }
  const get = id => { if(!elements.has(id)) elements.set(id,new Element()); return elements.get(id); };
  function timer(callback,ms) { const token={callback,ms};timers.add(token);return token; }
  function clear(token) { timers.delete(token); }
  const db = {createObjectStore(){}, transaction(_name,mode) {
    const tx={abort(){tx.onabort?.();},objectStore(){return {
      get(){const request={};queueMicrotask(()=>{request.result=stored;tx.oncomplete?.();});return request;},
      put(value){const request={};queueMicrotask(()=>{if(options.failWrites){tx.onerror?.();return;}stored=structuredClone(value);writes.push(stored);tx.oncomplete?.();});return request;},
    };}}; return tx;
  }};
  const indexedDB={open(){const request={result:db};queueMicrotask(()=>{request.onupgradeneeded?.();request.onsuccess?.();});return request;}};
  const entry={id:'project-fixture',ready:true,frame:{inert:false,contentWindow:{postMessage(value,origin){posts.push({value,origin});options.onPost?.(value,fixture);if(options.autoAck!==false)queueMicrotask(()=>ack(value));}}}};
  function dispatch(data,sourceWindow=entry.frame.contentWindow,origin='https://novart.test') { events.get('message')?.({data,source:sourceWindow,origin}); }
  function ack(value,extra={}) { dispatch({type:'nv-studio',action:'insert-material-result',projectId:entry.id,requestId:value.requestId,status:'saved',revision:1,...extra}); }
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
  const fixture={entry,host,elements,events,timers,writes,posts,requests,creates,notices,task,dispatch,ack,get data(){return stored;},get module(){return module;},
    async ready(){await flush(()=>module.snapshot().loaded);},async add(files=[file()]){get('hs-file-input').listeners.change({target:{files,value:'selected'}});await flush(()=>stored?.items?.length===Math.min(files.length,4)||get('hs-draft-note').textContent);},
    async create(){await module.create();},async resume(){return module.resume(entry,true);},get,get refreshed(){return refreshed;},completeInSibling(){stored={version:1,items:[],submitted:null};},
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
  assert(!source.includes('/studio/start/'));assert(!source.includes('webpack'));assert(!source.includes('/studio/generation'));
  console.log(`Owned homepage protocol boundary checks: ${count} passed; production services were not exercised.`);
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
