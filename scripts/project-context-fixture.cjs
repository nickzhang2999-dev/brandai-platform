/* Synthetic persistence used only by the loopback editor interaction harness. */
'use strict';
exports.createProjectContextFixture=({contracts,json,body,fixture,materials,readOnly})=>{
  const states=new Map(),mutations=new Map(),writes=[];let failRead=false,delayRead=0,conflictNext=false,lostNext=false,reads=0;
  const current=projectId=>{
    if(!states.has(projectId))states.set(projectId,{projectId,revision:0,facts:{goal:'',audience:'',approvedCopy:'',visualRequirements:''},materials:[],master:null,updatedAt:null,issues:[]});
    return states.get(projectId);
  };
  const update=(projectId,fn)=>{states.set(projectId,fn(structuredClone(current(projectId))));};
  return {current,update,writes,get reads(){return reads;},configure(value){({failRead=failRead,delayRead=delayRead,conflictNext=conflictNext,lostNext=lostNext}=value);},
    async handle(req,res,url){
      const match=url.pathname.match(/^\/api\/workspaces\/([^/]+)\/projects\/([^/]+)\/studio-project-context$/);if(!match)return false;
      const projectId=match[2];if(match[1]!==fixture.workspaceId||req.headers['x-novart-user']!==fixture.userId){json(res,{error:'Fixture scope mismatch'},403);return true;}
      if(req.method==='GET') {reads++;const snapshot=structuredClone(current(projectId));if(delayRead)await new Promise(resolve=>setTimeout(resolve,delayRead));json(res,failRead?{error:'项目资料读取失败（测试夹具）'}:contracts().StudioProjectContextView.parse(snapshot),failRead?503:200);return true;}
      const input=contracts().StudioProjectContextSaveInput.parse(JSON.parse((await body(req)).toString()));
      if(readOnly()){json(res,{error:'当前项目只读'},403);return true;}
      const key=projectId+':'+input.mutationId;if(mutations.has(key)){json(res,mutations.get(key));return true;}
      if(conflictNext){conflictNext=false;update(projectId,value=>({...value,revision:value.revision+1,facts:{...value.facts,goal:'同事更新的项目目标'}}));}
      if(input.expectedRevision!==current(projectId).revision){json(res,{error:'项目资料已被其他人更新'},409);return true;}
      const metadata=source=>{const asset=materials().find(item=>item.assetId===source.assetId&&item.assetSha256===source.assetSha256);if(!asset)throw Error('Fixture unknown material');return {name:asset.fileName,width:asset.width,height:asset.height,versionId:asset.versionId??null};};
      const saved=contracts().StudioProjectContextView.parse({projectId,revision:input.expectedRevision+1,facts:input.facts,
        materials:input.materials.map(value=>({...value,...metadata(value)})),master:input.master?{...input.master,...metadata(input.master),shapeId:input.master.shapeId??null}:null,
        updatedAt:new Date().toISOString(),issues:[]});
      states.set(projectId,saved);mutations.set(key,saved);writes.push(structuredClone(input));
      if(lostNext){lostNext=false;json(res,{revision:saved.revision});}else json(res,saved);return true;
    }};
};
