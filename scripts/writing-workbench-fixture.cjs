/* In-memory HTTP fixtures for browser interaction only. Never a provider-quality test. */
'use strict';
const crypto=require('node:crypto');
exports.createWritingFixture=function({contracts,json,body,onGenerate=()=>{}}){
 const stamp=()=>new Date().toISOString();
 const state={enabled:true,document:{id:'writing-fixture-document',title:'',text:'',revision:0,updatedAt:null},versions:[],messages:[],references:[],style:{revision:0,rules:[],examples:[],confirmedAt:null},tasks:[]};
 const mutations=new Map();
 let posts=0,uploads=0;
 return {state,get posts(){return posts;},get uploads(){return uploads;},async handle(req,res,url){
  const c=contracts();
  if(req.method==='GET'&&url.pathname.endsWith('/studio-writing'))return json(res,c.StudioWritingState.parse(state));
  if(req.method==='GET'&&url.pathname.endsWith('/tasks'))return json(res,{task:state.tasks.find(t=>t.mutationId===url.searchParams.get('mutationId'))||null});
  if(req.method==='GET'&&url.pathname.includes('/tasks/')){const id=decodeURIComponent(url.pathname.slice(url.pathname.lastIndexOf('/')+1)),task=state.tasks.find(item=>item.id===id);return task?json(res,c.StudioWritingTask.parse(task)):json(res,{error:'not-found',code:'NOT_FOUND'},404);}
  if(req.method==='POST'&&url.pathname.endsWith('/references')){
   const raw=await body(req);let input,sha,name,mime='image/png',kind='IMAGE',text='';
   if(String(req.headers['content-type']).includes('application/json')){input=c.StudioWritingAssetReferenceInput.parse(JSON.parse(raw.toString()));sha=input.assetSha256;name=input.name;}
   else {const form=await(new Request('http://127.0.0.1',{method:'POST',headers:{'content-type':req.headers['content-type']},body:raw})).formData();const file=form.get('file');input={mutationId:form.get('mutationId')};const bytes=Buffer.from(await file.arrayBuffer());sha=crypto.createHash('sha256').update(bytes).digest('hex');name=file.name;mime=file.type;kind='DOCUMENT';text=bytes.toString('utf8');}
   if(mutations.has(input.mutationId))return json(res,mutations.get(input.mutationId),202);
   uploads++;
   const reference={id:'writing-reference-'+uploads,name,mimeType:mime,sha256:sha,sizeBytes:100,kind,status:'READY',error:null,segments:kind==='DOCUMENT'?[{id:'text-segment',pageNumber:null,label:'画布所选文字',text}]:[],truncated:false,imageUrl:null,createdAt:stamp()};
   const task={id:'writing-parse-'+uploads,mutationId:input.mutationId,operation:'REFERENCE_PARSE',input:null,status:'SUCCEEDED',progress:100,createdAt:stamp(),expiresAt:new Date(Date.now()+360000).toISOString(),error:null,result:null};
   state.references.push(reference);state.tasks.unshift(task);const value={reference,task};mutations.set(input.mutationId,value);return json(res,c.StudioWritingReferenceAccepted.parse(value),202);
  }
  if(req.method==='POST'&&url.pathname.endsWith('/studio-writing')){
   const input=c.StudioWritingGenerateInput.parse(JSON.parse((await body(req)).toString()));posts++;onGenerate();let task=state.tasks.find(t=>t.mutationId===input.mutationId);
   if(!task){task={id:'writing-task-'+posts,mutationId:input.mutationId,operation:'GENERATE',input,status:'SUCCEEDED',progress:100,createdAt:stamp(),expiresAt:new Date(Date.now()+360000).toISOString(),error:null,result:{text:'交互测试标题\n测试夹具正文，仅用于编辑、撤销和刷新恢复检查。',scope:'DOCUMENT',baseRevision:input.expectedRevision,citations:[],styleDraft:null,model:'synthetic-ui-fixture',inputTokens:0,outputTokens:0,latencyMs:1}};state.tasks.unshift(task);}return json(res,c.StudioWritingTask.parse(task),202);
  }
  if(req.method==='PUT'&&url.pathname.endsWith('/studio-writing')){
   const input=c.StudioWritingSaveInput.parse(JSON.parse((await body(req)).toString()));if(mutations.has(input.mutationId))return json(res,mutations.get(input.mutationId));
   if(input.expectedRevision!==state.document.revision)return json(res,{error:'Fixture revision conflict',code:'CONFLICT'},409);
   if(input.operation!=='SAVE')return json(res,{error:'Fixture supports save only'},422);
   state.document={...state.document,title:input.title,text:input.text,revision:state.document.revision+1,updatedAt:stamp()};const version={id:'writing-version-'+state.document.revision,revision:state.document.revision,title:input.title,text:input.text,operation:'SAVE',createdAt:stamp()};state.versions.unshift(version);const value={document:state.document,version};mutations.set(input.mutationId,value);return json(res,value);
  }
  return json(res,{error:'Unknown writing fixture request'},404);
 }};
};
