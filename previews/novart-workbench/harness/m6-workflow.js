/* Optional local workflow settings. Original editor/mentions/history stay untouched. */
(() => {
  'use strict';
  if(document.querySelector('#compare-app')){
    const label=document.querySelector('.nv-wordmark i');if(label)label.textContent='素材比较版';
    return;
  }
  if(new URLSearchParams(location.search).get('ui')!=='novart')return;
  const bar=document.querySelector('#novart-bar');if(!bar)return;
  const svg=content=>'<svg viewBox="0 0 24 24" aria-hidden="true">'+content+'</svg>';
  const closeIcon=svg('<path d="m6 6 12 12M18 6 6 18"/>');
  const imageIcon=svg('<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m4 18 5-5 4 4 4-6 4 5"/>');
  const plusIcon=svg('<path d="M12 5v14M5 12h14"/>');
  const choices=[{id:'EXACT',name:'锁定使用',hint:'保留主体身份与原像素，允许旋转、缩放、裁切。'},
    {id:'ADAPTIVE',name:'智能融合',hint:'允许 AI 改变外观并融入画面。'},
    {id:'REFERENCE',name:'仅参考',hint:'参考风格，不保证主体出现在结果中。'}];
  const element=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;};
  const local={get(key){try{return localStorage.getItem(key);}catch(_){return null;}},set(key,value){try{localStorage.setItem(key,value);return true;}catch(_){return false;}},remove(key){try{localStorage.removeItem(key);}catch(_){}}};
  async function api(url,payload){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
    try{
      const response=await fetch(url,payload===undefined?{signal:controller.signal}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:controller.signal});
      const value=await response.json();if(!response.ok){const e=new Error(value.error||value.msg||'本地设置暂不可读');e.status=response.status;throw e;}return value;
    }catch(e){if(e.name==='AbortError')throw new Error('读取超时，当前设置仍保留，请稍后重试。');throw e;}
    finally{clearTimeout(timer);}
  }
  const toggle=element('button');toggle.id='nv-workflow-toggle';toggle.innerHTML=imageIcon+'<span>素材</span>';toggle.setAttribute('aria-controls','novart-workflow');toggle.setAttribute('aria-expanded','false');bar.append(toggle);
  const panel=element('aside');panel.id='novart-workflow';panel.hidden=true;panel.setAttribute('aria-label','创作素材');
  panel.innerHTML=`<header class="nw-heading"><h2>创作素材</h2><button id="nv-workflow-close" aria-label="收起创作素材">${closeIcon}</button></header><div class="nw-mode" aria-label="创作方式"><button id="nv-mode-generate" aria-pressed="true" disabled>生成新图</button><button id="nv-mode-modify" aria-pressed="false" disabled>修改图片</button></div><p class="nw-mode-note">选择画布对象不会改变这里的创作方式。</p><div id="nv-workflow-target"></div><div class="nw-section-title"><span>本次素材</span><span id="nv-workflow-count">0 张参与</span></div><div id="nv-workflow-references"></div><button class="nw-gallery-toggle" id="nv-workflow-gallery-toggle" disabled>${plusIcon}添加画布图片</button><div id="nv-workflow-gallery" hidden></div><div id="nv-workflow-issues" class="nw-issues" role="status"></div><footer class="nw-footer"><div class="nw-save-row"><span id="nv-workflow-status" role="status">正在读取设置…</span><button id="nv-workflow-save" disabled>保存设置</button></div><button id="nv-workflow-latest" hidden title="采用已保存设置，替换当前草稿">采用最新设置</button><p class="nw-service-note">当前保存输入设置，尚未提交生成任务。AI 服务接入后再验证用途是否实际生效。</p></footer>`;
  const scrollBody=element('div');scrollBody.id='nv-workflow-body';
  const heading=panel.querySelector('.nw-heading'),footer=panel.querySelector('.nw-footer');
  while(heading.nextElementSibling&&heading.nextElementSibling!==footer)scrollBody.append(heading.nextElementSibling);
  heading.after(scrollBody);footer.querySelector('.nw-service-note').textContent='仅保存素材设置，AI 尚未接入。';
  const summary=element('button');summary.id='nv-workflow-summary';summary.hidden=true;summary.setAttribute('aria-label','查看本地创作设置');
  document.body.append(panel,summary);
  const refsNode=document.getElementById('nv-workflow-references'), targetNode=document.getElementById('nv-workflow-target'), galleryNode=document.getElementById('nv-workflow-gallery');
  const status=document.getElementById('nv-workflow-status'),saveButton=document.getElementById('nv-workflow-save'),latestButton=document.getElementById('nv-workflow-latest');
  let state=null,assets=[],projectId='',loaded=false,busy=false,dirty=false,stale=false,galleryOpen=false,assetError='',assetWarnings=[],refreshBusy=false,loadBusy=false,disposed=false,scheduled=false,lastLayerVisible=false;
  const payload=()=>({projectId,revision:state.revision,mode:state.mode,target:state.target,references:state.references});
  const draftKey=()=> 'novart-m6-workflow:'+projectId;
  const clone=value=>JSON.parse(JSON.stringify(value));
  const pair=(a,b)=>a?.shapeId===b?.shapeId&&a?.assetSha256===b?.assetSha256;
  const findAsset=ref=>ref?assets.find(a=>ref.shapeId?pair(a,ref):a.assetSha256===ref.assetSha256):undefined;
  const validAsset=ref=>Boolean(findAsset(ref)&&findAsset(ref).valid!==false);
  const visible=node=>{if(!node)return false;const r=node.getBoundingClientRect(),s=getComputedStyle(node);return r.width>1&&r.height>1&&r.right>0&&r.bottom>0&&r.left<innerWidth&&s.visibility!=='hidden'&&s.display!=='none';};
  function validDraft(value){
    if(!value||value.projectId!==projectId||!Number.isInteger(value.revision)||value.revision<0||!['generate','modify'].includes(value.mode)||!Array.isArray(value.references)||value.references.length>8)return false;
    const reference=r=>r&&typeof r.assetSha256==='string'&&/^[a-f0-9]{64}$/.test(r.assetSha256)&&(r.shapeId===null||typeof r.shapeId==='string')&&(r.purpose===null||choices.some(c=>c.id===r.purpose))&&typeof r.participates==='boolean';
    return value.references.every(reference)&&(value.target===null||(typeof value.target?.shapeId==='string'&&/^[a-f0-9]{64}$/.test(value.target?.assetSha256)));
  }
  function problems(){
    if(!state)return [];
    const messages=[];
    if(assetError)messages.push(assetError);
    messages.push(...assetWarnings);
    if(state.mode==='modify'&&!state.target)messages.push('先从画布图片中明确选择改图目标。');
    else if(state.mode==='modify'&&!validAsset(state.target))messages.push('改图目标已不在当前画布或图片不可读，请重新选择。');
    state.references.forEach(ref=>{if(!validAsset(ref))messages.push('参考图片已失效，可移除该参考；原素材文件仍保留。');if(ref.participates&&!ref.purpose)messages.push('参与的图片需要先选择用途。');});
    if(state.mode==='modify'&&state.references.some(r=>pair(r,state.target)&&r.participates&&r.purpose==='EXACT'))messages.push('改图目标同时设为锁定使用。若要重画主体，请先调整用途。');
    return [...new Set(messages)];
  }
  function image(ref,size){
    const img=element('img');img.width=size;img.height=size;img.alt='素材原图';
    if(ref.assetSha256)img.src='/workflow/image/'+encodeURIComponent(ref.assetSha256)+'?projectId='+encodeURIComponent(projectId);
    img.addEventListener('error',()=>{img.alt='图片暂不可读';});return img;
  }
  function assetName(ref){
    const item=findAsset(ref);if(!item)return '原图片已不在画布中';
    const same=assets.filter(a=>a.name===item.name);
    return (item.name||'画布图片')+(same.length>1?' · '+(assets.indexOf(item)+1):'');
  }
  function focusToken(){
    const node=document.activeElement;if(!panel.contains(node))return null;
    return {id:node.id,shape:node.closest('[data-ref-shape-id],[data-shape-id]')?.getAttribute('data-ref-shape-id')||node.closest('[data-shape-id]')?.getAttribute('data-shape-id'),action:node.dataset.action};
  }
  function restoreFocus(token){
    if(!token)return;let node=token.id?document.getElementById(token.id):null;
    if(!node&&token.shape&&token.action)node=panel.querySelector('[data-ref-shape-id="'+CSS.escape(token.shape)+'"] [data-action="'+token.action+'"],[data-shape-id="'+CSS.escape(token.shape)+'"] [data-action="'+token.action+'"]');
    if(node&&!node.disabled)node.focus({preventScroll:true});
  }
  function remember(){
    dirty=true;
    const stored=local.set(draftKey(),JSON.stringify(payload()));
    status.textContent=stored?(stale?'其他页面更新了设置；当前草稿保留。':'有未保存修改'):'无法暂存，请保存设置后离开';
    render();
  }
  function render(){
    if(!state)return;
    const focused=focusToken();
    document.getElementById('nv-mode-generate').setAttribute('aria-pressed',String(state.mode==='generate'));
    document.getElementById('nv-mode-modify').setAttribute('aria-pressed',String(state.mode==='modify'));
    document.getElementById('nv-mode-generate').disabled=!loaded||busy;
    document.getElementById('nv-mode-modify').disabled=!loaded||busy;
    targetNode.replaceChildren();
    if(state.mode==='modify'){
      if(state.target){
        const card=element('div','nw-target'+(validAsset(state.target)?'':' nw-invalid'));card.dataset.targetShapeId=state.target.shapeId;
        const info=element('div');info.append(element('strong',null,assetName(state.target)),element('p',null,validAsset(state.target)?'明确的改图目标':'目标已失效，未自动更换'));
        const clear=element('button');clear.id='nv-workflow-clear-target';clear.title='取消改图，返回生成新图';clear.setAttribute('aria-label','取消改图');clear.innerHTML=closeIcon;clear.disabled=busy;
        clear.addEventListener('click',()=>{state.mode='generate';state.target=null;remember();});card.append(image(state.target,48),info,clear);targetNode.append(card);
      }else targetNode.append(element('div','nw-empty','还没有改图目标，请在下方选择一张画布图片。'));
    }
    refsNode.replaceChildren();
    if(!state.references.length)refsNode.append(element('div','nw-empty','添加图片后，明确用途并勾选是否参与。画布上的图片不会自动加入这里。'));
    for(const ref of state.references){
      const card=element('article','nw-reference'+(validAsset(ref)?'':' nw-invalid'));card.dataset.refShapeId=ref.shapeId||'';card.dataset.refAssetSha256=ref.assetSha256;
      const header=element('div','nw-reference-head');header.append(image(ref,42),element('span','nw-reference-name',assetName(ref)));
      const remove=element('button','nw-remove');remove.dataset.action='remove';remove.title='从本次素材移除，保留画布和源图片';remove.setAttribute('aria-label','移除本次素材');remove.innerHTML=closeIcon;remove.disabled=busy;
      remove.addEventListener('click',()=>{state.references=state.references.filter(r=>r!==ref);remember();});header.append(remove);
      const controls=element('div','nw-ref-controls'),select=element('select');select.dataset.action='purpose';select.setAttribute('aria-label','图片用途');
      select.append(new Option('选择用途',''));choices.forEach(choice=>select.append(new Option(choice.name,choice.id)));select.value=ref.purpose||'';select.disabled=busy||!loaded;
      select.addEventListener('change',()=>{ref.purpose=select.value||null;if(!ref.purpose)ref.participates=false;remember();});
      const label=element('label','nw-participates'),check=element('input');check.type='checkbox';check.dataset.action='participates';check.checked=ref.participates;check.disabled=busy||!ref.purpose||(!validAsset(ref)&&!ref.participates);check.title=!ref.purpose?'先选择图片用途':!validAsset(ref)?'图片失效，可取消参与或移除参考':'参与本次输入';
      check.addEventListener('change',()=>{ref.participates=check.checked;remember();});label.append(check,element('span',null,'参与'));
      controls.append(select,label);card.append(header,controls,element('p','nw-purpose-hint',choices.find(c=>c.id===ref.purpose)?.hint||'先选择用途，再决定是否参与本次创作。'));refsNode.append(card);
    }
    const count=state.references.filter(r=>r.participates).length;
    document.getElementById('nv-workflow-count').textContent=count+' 张参与 / '+state.references.length+' 张已添加';
    toggle.querySelector('span').textContent=count?'素材 · '+count:'素材';
    galleryNode.hidden=!galleryOpen;galleryNode.replaceChildren();
    if(galleryOpen){
      if(!assets.length)galleryNode.append(element('p','nw-empty',assetError||'画布还没有可用图片。先用底部上传工具添加图片，保存后会出现在这里。'));
      for(const asset of assets){
        const row=element('div','nw-gallery-item');row.dataset.shapeId=asset.shapeId;row.append(image(asset,62));
        const info=element('div');info.append(element('strong',null,assetName(asset)));const actions=element('div','nw-actions');
        const add=element('button',null,state.references.some(r=>pair(r,asset))?'已加入':'加入素材');add.dataset.action='add-reference';add.disabled=busy||asset.valid===false||state.references.some(r=>pair(r,asset))||state.references.length>=8;
        add.addEventListener('click',()=>{if(state.references.length<8&&!state.references.some(r=>pair(r,asset))){state.references.push({shapeId:asset.shapeId,assetSha256:asset.assetSha256,purpose:null,participates:false});remember();}});
        const target=element('button',null,pair(state.target,asset)&&state.mode==='modify'?'当前目标':'设为改图目标');target.dataset.action='set-target';target.disabled=busy||asset.valid===false;
        target.addEventListener('click',()=>{state.mode='modify';state.target={shapeId:asset.shapeId,assetSha256:asset.assetSha256};remember();});actions.append(add,target);info.append(actions);row.append(info);galleryNode.append(row);
      }
    }
    const messages=problems();document.getElementById('nv-workflow-issues').textContent=messages.join(' ');
    saveButton.disabled=!loaded||busy||(state.mode==='modify'&&!state.target)||state.references.some(r=>r.participates&&!r.purpose);
    latestButton.hidden=!stale;latestButton.disabled=busy;
    document.getElementById('nv-workflow-gallery-toggle').disabled=!loaded||busy;
    const summaryText=state.mode==='modify'?(validAsset(state.target)?'修改指定图片':'改图目标待确认'):'生成新图';
    summary.replaceChildren(element('strong',null,summaryText+' · '+count+' 张参与素材'),element('small',null,(dirty?'未保存 · ':'')+'未提交任务'));
    summary.dataset.error=String(state.mode==='modify'&&!validAsset(state.target));
    restoreFocus(focused);scheduleLayout();
  }
  function close(){panel.hidden=true;toggle.dataset.active='false';toggle.setAttribute('aria-expanded','false');}
  function open(){
    if(visible(document.getElementById('novart-context')))document.getElementById('nv-context-close')?.click();
    const switcher=document.getElementById('novart-switcher');if(switcher&&!switcher.hidden)document.getElementById('nv-project-switch')?.click();
    lastLayerVisible=visible(document.querySelector('[data-testid="layer-panel"]'));
    if(visible(document.querySelector('[data-testid="layer-panel"]')))document.querySelector('[data-testid="layer-panel-collapse-button"]')?.click();
    panel.hidden=false;toggle.dataset.active='true';toggle.setAttribute('aria-expanded','true');refreshAssets();scheduleLayout();
  }
  toggle.addEventListener('click',()=>panel.hidden?open():close());summary.addEventListener('click',open);document.getElementById('nv-workflow-close').addEventListener('click',close);
  document.getElementById('nv-context-toggle')?.addEventListener('click',close);document.getElementById('nv-project-switch')?.addEventListener('click',close);
  document.getElementById('nv-workflow-gallery-toggle').addEventListener('click',()=>{galleryOpen=!galleryOpen;render();});
  document.getElementById('nv-mode-generate').addEventListener('click',()=>{state.mode='generate';state.target=null;remember();});
  document.getElementById('nv-mode-modify').addEventListener('click',()=>{state.mode='modify';if(!state.target)galleryOpen=true;remember();});
  panel.addEventListener('keydown',event=>{if(event.key==='Escape'){close();toggle.focus();event.preventDefault();}event.stopPropagation();});
  saveButton.addEventListener('click',async()=>{
    if(!loaded||busy||saveButton.disabled)return;
    const sent=clone(payload());busy=true;status.textContent='正在保存…';render();
    try{
      const saved=await api('/workflow',sent);state=clone(saved);dirty=false;stale=false;local.remove(draftKey());status.textContent='设置已保存';
    }catch(error){status.textContent=error.message;if(error.status===409)stale=true;}
    finally{busy=false;render();}
  });
  latestButton.addEventListener('click',async()=>{
    if(busy||!state)return;busy=true;status.textContent='正在读取最新设置…';render();
    try{
      const saved=await api('/workflow?projectId='+encodeURIComponent(projectId));
      if(!local.set('novart-m6-replaced:'+projectId,JSON.stringify(payload()))){status.textContent='无法备份当前草稿，草稿仍保留。';return;}
      state=clone(saved);dirty=false;stale=false;local.remove(draftKey());status.textContent='已采用最新设置';
    }catch(error){status.textContent=error.message;}
    finally{busy=false;render();}
  });
  async function refreshAssets(){
    if(refreshBusy||!projectId||disposed)return;refreshBusy=true;
    try{const value=await api('/workflow/assets?projectId='+encodeURIComponent(projectId));const warnings=(value.issues||[]).map(issue=>issue.message).filter(Boolean);const changed=assetError||JSON.stringify(assets)!==JSON.stringify(value.assets)||JSON.stringify(assetWarnings)!==JSON.stringify(warnings);assets=value.assets;assetWarnings=warnings;assetError='';if(changed)render();}
    catch(error){assetError='画布图片暂不可读：'+error.message;render();}
    finally{refreshBusy=false;}
  }
  async function load(){
    if(loadBusy)return;
    const id=new URLSearchParams(location.search).get('projectId');if(!id||disposed)return;
    if(projectId===id&&loaded)return;
    loadBusy=true;projectId=id;loaded=false;saveButton.disabled=true;
    try{
      const value=await api('/workflow?projectId='+encodeURIComponent(projectId));state=clone(value);
      let draft=null;try{draft=JSON.parse(local.get(draftKey())||'null');}catch(_){}
      if(validDraft(draft)){state=clone(draft);dirty=true;stale=draft.revision!==value.revision;status.textContent=stale?'其他页面更新了设置；当前草稿保留。':'已恢复未保存设置';}
      else status.textContent=draft?'浏览器草稿格式无法读取，显示已保存设置。':'设置已保存';
      loaded=true;render();await refreshAssets();
    }catch(error){status.textContent=error.message;projectId='';}
    finally{loadBusy=false;}
  }
  function layout(){
    scheduled=false;if(disposed)return;
    const canvas=document.querySelector('.tl-container');if(!canvas)return;const c=canvas.getBoundingClientRect();
    const layer=document.querySelector('[data-testid="layer-panel"]');
    const layerVisible=visible(layer);
    if(layerVisible&&!lastLayerVisible&&!panel.hidden)close();
    lastLayerVisible=layerVisible;
    const available=c.width-(layerVisible?layer.getBoundingClientRect().width:0);
    const width=Math.min(innerWidth<=1000?330:360,Math.max(240,available-24)),left=c.right-12-width;
    let top=58;for(const toast of document.querySelectorAll('li[data-sonner-toast][data-visible="true"][data-y-position="top"]')){const r=toast.getBoundingClientRect();if(r.right>left&&r.left<c.right-12&&r.top<220&&r.bottom>58)top=Math.max(top,r.bottom+10);}
    const style=(node,key,value)=>{if(node.style[key]!==value)node.style[key]=value;};
    style(panel,'right',Math.round(innerWidth-c.right+12)+'px');style(panel,'width',Math.round(width)+'px');style(panel,'top',Math.round(top)+'px');style(panel,'maxHeight',Math.max(180,innerHeight-top-80)+'px');
    const chat=document.querySelector('[data-testid="agent-panel-container"]');
    if(loaded&&visible(chat)){const r=chat.getBoundingClientRect();if(summary.hidden)summary.hidden=false;style(summary,'left',Math.round(r.left+16)+'px');style(summary,'width',Math.max(0,r.width-32)+'px');}else if(!summary.hidden)summary.hidden=true;
  }
  function scheduleLayout(){if(!scheduled&&!disposed){scheduled=true;requestAnimationFrame(layout);}}
  const observer=new MutationObserver(records=>{if(records.some(r=>!panel.contains(r.target)&&!summary.contains(r.target)&&!toggle.contains(r.target)))scheduleLayout();});
  observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','style','data-visible','hidden']});
  window.addEventListener('resize',scheduleLayout);
  load();const timer=setInterval(()=>{if(!document.hidden){if(!loaded)load();else refreshAssets();}},2000);
  window.addEventListener('pagehide',()=>{disposed=true;clearInterval(timer);observer.disconnect();},{once:true});
})();
