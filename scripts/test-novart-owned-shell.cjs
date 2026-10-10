/* Product archive guard regression with synthetic messages and a read-only API.
 * Does not access a database, worker, user browser or deployed environment. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'export-novart-studio.py'),'utf8');
const start=source.indexOf("    replacement = '''  async function prepareArchive(p) {"),end=source.indexOf("'''\n    return text[:left]",start);
assert.ok(start>=0&&end>start,'Product archive compiler boundary');
const guard=source.slice(start+"    replacement = '''".length,end).trim();
let passed=0;
async function scenario({mounted=true,ready=true,status='saved',revision=7,stored=7,timeout=false}={}) {
  const handlers=new Set(),calls=[],projectId='synthetic-project';let listeners=0;
  const requestId='12345678-1234-1234-1234-123456789abc';
  const win={postMessage(message,origin) {
    assert.equal(message.action,'confirm-save');assert.equal(message.projectId,projectId);assert.equal(origin,'https://owned.invalid');
    queueMicrotask(()=>{
      if(timeout)return;
      const data={type:'nv-studio',action:'confirm-save-result',requestId,projectId,status,revision,error:'合成保存未确认'};
      for(const fn of handlers) {
        fn({origin:'https://other.invalid',source:win,data});fn({origin,source:{},data});
        fn({origin,source:win,data:{...data,requestId:'unrelated'}});assert.equal(listeners,1,'Untrusted receipts cannot release guard');fn({origin,source:win,data});
      }
    });
  }};
  const entry={ready};
  const context={frames:new Map(mounted?[[projectId,entry]]:[]),frameDocument:()=>({win,doc:{querySelector:()=>({})}}),
    crypto:{randomUUID:()=>requestId},location:{origin:'https://owned.invalid'},
    window:{addEventListener(_type,fn){handlers.add(fn);listeners++;},removeEventListener(_type,fn){if(handlers.delete(fn))listeners--; }},
    api:async(route,payload)=>{calls.push(route);assert.equal(payload.projectId,projectId);return{code:0,data:{projectId,version:stored}};},
    setTimeout(fn){if(timeout)queueMicrotask(fn);return 1;},clearTimeout(){},Error,Number};
  const prepare=vm.runInNewContext('('+guard+')',context);let result,error;
  try {result=await prepare({projectId});}catch(e){error=e;}
  assert.equal(listeners,0,'No leftover message listener');return{result,error,calls};
}
(async()=>{
  let value=await scenario();assert.equal(value.result,7);assert.equal(value.calls.length,1);passed++;
  value=await scenario({mounted:false});assert.equal(value.result,7);assert.equal(value.calls.length,1);passed++;
  value=await scenario({ready:false});assert.match(value.error.message,/加载/);assert.equal(value.calls.length,0);passed++;
  value=await scenario({status:'failed'});assert.match(value.error.message,/保存未确认/);assert.equal(value.calls.length,0);passed++;
  value=await scenario({stored:8});assert.match(value.error.message,/更新/);passed++;
  value=await scenario({timeout:true});assert.match(value.error.message,/超时/);assert.equal(value.calls.length,0);passed++;
  console.log(JSON.stringify({passed,scope:'synthetic-product-archive-guard'}));
})().catch(error=>{console.error(error);process.exitCode=1;});
