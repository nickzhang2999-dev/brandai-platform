/* Independent Novart comparison layer. No editor store, bundle, or history access. */
(() => {
  'use strict';
  const icons = {
    back:'<path d="m12 5-7 7 7 7M5 12h15"/>',
    arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>',
    chevron:'<path d="m5 9 7 7 7-7"/>',
    document:'<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5"/>',
    chat:'<path d="M21 11a8 8 0 0 1-8 8H6l-4 3 1-7a8 8 0 0 1-1-4 9 9 0 0 1 19 0Z"/>',
    close:'<path d="m6 6 12 12M18 6 6 18"/>'
  };
  const icon = name => '<svg viewBox="0 0 24 24" aria-hidden="true">'+icons[name]+'</svg>';
  const request = async (url, data) => {
    const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),8000);
    try{
      const response = await fetch(url, data === undefined ? {signal:controller.signal} : {signal:controller.signal,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
      const result = await response.json();
      if (!response.ok) { const error = new Error(result.error || '本地服务暂不可用'); error.result = result; throw error; }
      return result;
    }catch(e){if(e.name==='AbortError'){const error=new Error('本地服务响应超时，请保留当前输入。');error.timedOut=true;throw error;}throw e;}
    finally{clearTimeout(timer);}
  };
  const el = (tag, cls, text) => { const node = document.createElement(tag); if(cls)node.className=cls; if(text!==undefined)node.textContent=text; return node; };
  const canvasURL = id => '/canvas?projectId='+encodeURIComponent(id)+'&v=1&ui=novart';
  const storage = {
    get(key){try{return localStorage.getItem(key)||'';}catch(_){return '';}},
    set(key,value){try{localStorage.setItem(key,value);}catch(_){return false;}return true;},
    remove(key){try{localStorage.removeItem(key);}catch(_){}}
  };
  const relativeDate = value => { const d=new Date(value); return Number.isNaN(+d)?'':d.toLocaleDateString('zh-CN',{month:'numeric',day:'numeric'}); };

  async function home() {
    document.getElementById('compare-app').innerHTML = `
      <header class="nv-home-header"><a class="nv-wordmark" href="/compare">NovartLab<i>比较版</i></a><span class="nv-local">保存在这台电脑</span></header>
      <main class="nv-home-main"><section class="nv-hero"><h1>从一个想法开始</h1><p>写下需求，进入项目继续创作。</p>
      <form class="nv-create-form"><textarea id="nv-home-brief" maxlength="6000" aria-label="创作需求" placeholder="例如，为夏日海岸活动设计一张海报，保留品牌角色，画面轻松明亮。"></textarea>
      <div class="nv-create-footer"><small>Enter 创建项目 · Shift + Enter 换行</small><button class="nv-primary" id="nv-create" type="submit">创建项目 ${icon('arrow')}</button></div></form>
      <p class="nv-error" id="nv-home-error" role="status"></p><button class="nv-blank" id="nv-create-blank">进入空白项目</button></section>
      <section><div class="nv-project-head"><h2>继续创作</h2><span>项目与画布保存在同一处</span></div><div class="nv-project-grid" id="nv-projects" aria-live="polite"><div class="nv-empty">正在读取项目…</div></div></section>
      <footer class="nv-home-foot">本地比较版 · 可编辑、保存和导出画布 · AI 生成与团队服务尚未连接</footer></main>`;
    const brief=document.getElementById('nv-home-brief'), error=document.getElementById('nv-home-error');
    brief.value=storage.get('novart-compare-home-brief');
    brief.addEventListener('input',()=>{if(!storage.set('novart-compare-home-brief',brief.value))error.textContent='浏览器无法暂存输入，请保留当前页面。';});
    let busy=false,recoveredProjectId='';
    async function create(blank=false){
      if(busy)return;
      if(recoveredProjectId){location.href=canvasURL(recoveredProjectId);return;}
      const value=blank?'':brief.value;
      if(!blank && !value.trim()){brief.focus();error.textContent='先写一句需求，或选择进入空白项目。';return;}
      busy=true; error.textContent='';
      document.querySelectorAll('.nv-hero button').forEach(b=>b.disabled=true);
      try{
        const result=await request('/compare/api/create',{projectName:value.trim()?Array.from(value.trim().split('\n')[0]).slice(0,26).join(''):'未命名项目',brief:value});
        if(!blank)storage.remove('novart-compare-home-brief');
        location.href=canvasURL(result.projectId);
      }catch(e){
        error.textContent=e.message;
        if(e.result?.projectId){recoveredProjectId=e.result.projectId;storage.set('novart-compare-draft:'+recoveredProjectId,JSON.stringify({brief:value,notes:'',revision:0}));const a=el('a',null,' 打开已创建项目');a.href=canvasURL(recoveredProjectId);error.append(a);document.getElementById('nv-create').textContent='继续已创建项目';}
        if(e.timedOut){error.textContent='尚未确认创建结果，先到项目列表查看。当前输入已保留。';const a=el('a',null,' 查看项目列表');a.href='/compare';a.target='_blank';a.rel='noopener';error.append(a);return;}
        busy=false;document.querySelectorAll('.nv-hero button').forEach(b=>b.disabled=false);
        if(recoveredProjectId)document.getElementById('nv-create-blank').disabled=true;
      }
    }
    document.querySelector('.nv-create-form').addEventListener('submit',e=>{e.preventDefault();create();});
    brief.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&e.keyCode!==229){e.preventDefault();create();}});
    document.getElementById('nv-create-blank').addEventListener('click',()=>create(true));
    try{
      const {projects}=await request('/compare/api/projects'), grid=document.getElementById('nv-projects');grid.replaceChildren();
      projects.sort((a,b)=>new Date(b.updatedAt)-new Date(a.updatedAt));
      if(!projects.length)grid.append(el('div','nv-empty','还没有项目。写下需求，开始第一张画布。'));
      for(const p of projects){
        const a=el('a','nv-project-card');a.href=canvasURL(p.projectId);a.dataset.projectId=p.projectId;
        const top=el('div','nv-project-card-top');top.innerHTML=icon('document');top.append(el('small',null,p.hasCanvas?'已有画布':'空白画布'));
        const body=el('div');body.append(el('strong',null,p.projectName||'未命名项目'));
        const meta=el('p');meta.append(el('span',null,relativeDate(p.updatedAt)+' 编辑'),el('span',null,'继续 →'));body.append(meta);a.append(top,body);grid.append(a);
      }
    }catch(e){document.getElementById('nv-projects').replaceChildren(el('div','nv-empty','读取失败：'+e.message+'。请刷新重试。'));}
  }

  function editor() {
    document.title='NovartLab · 比较画布';
    const bar=el('nav');bar.id='novart-bar';bar.setAttribute('aria-label','当前项目');
    bar.innerHTML=`<a class="nv-back" href="/compare" target="_blank" rel="noopener" aria-label="在新标签返回项目" title="打开项目页，保留当前编辑会话">${icon('back')}</a><button class="nv-title" id="nv-project-switch" aria-haspopup="true" aria-expanded="false"><span>正在读取项目</span>${icon('chevron')}</button><div class="nv-spacer"></div><span class="nv-save" title="最近一次确认落盘的时间，不包含尚未发送的编辑">正在读取保存状态</span><button id="nv-chat-toggle" hidden title="展开创作对话">${icon('chat')}<span>对话</span></button><button class="nv-brief-toggle" id="nv-context-toggle" aria-controls="novart-context" aria-expanded="false">${icon('document')}<span>需求</span></button>`;
    const switcher=el('div');switcher.id='novart-switcher';switcher.hidden=true;
    const panel=el('aside');panel.id='novart-context';panel.hidden=true;panel.setAttribute('aria-label','项目需求');
    panel.innerHTML=`<header><h2>项目需求</h2><button id="nv-context-close" aria-label="收起项目需求">${icon('close')}</button></header><label for="nv-brief">原始需求</label><textarea id="nv-brief" maxlength="6000" disabled placeholder="记录这次创作的用途、主体与约束"></textarea><label for="nv-notes">补充说明</label><textarea id="nv-notes" maxlength="4000" disabled placeholder="例如，角色外观必须保留"></textarea><div class="nv-context-footer"><span class="nv-context-status" id="nv-context-status" role="status">正在读取…</span><button class="nv-context-save" id="nv-context-save" disabled>保存需求</button></div><button id="nv-context-latest" class="nv-context-latest" hidden title="采用其他页面保存的内容，替换上面的草稿">采用最新内容</button><p class="nv-context-note">需求单独保存在本项目中。当前不会发起 AI 任务；它也不会改动画布。</p>`;
    const availability=el('div',null,'AI 服务尚未连接');availability.id='novart-availability';
    document.body.append(bar,switcher,panel,availability);
    const toggle=document.getElementById('nv-context-toggle'), switchButton=document.getElementById('nv-project-switch');
    const chatToggle=document.getElementById('nv-chat-toggle');
    const nativeChatRestore=()=>[...document.querySelectorAll('[data-novart-native-header] button')].find(b=>b.textContent.trim()==='对话');
    chatToggle.addEventListener('click',()=>{nativeChatRestore()?.click();schedule();});
    const brief=document.getElementById('nv-brief'), notes=document.getElementById('nv-notes'), contextStatus=document.getElementById('nv-context-status'), save=document.getElementById('nv-context-save');
    const latest=document.getElementById('nv-context-latest');
    let projectId='',revision=0,contextLoaded=false,contextBusy=false,lastLayerOpen=false,scheduled=false,disposed=false,updateBusy=false;
    const draftKey=()=> 'novart-compare-draft:'+projectId;
    function remember(){
      if(!contextLoaded)return;
      if(!storage.set(draftKey(),JSON.stringify({brief:brief.value,notes:notes.value,revision})))contextStatus.textContent='无法暂存，请保存需求后离开';
      else contextStatus.textContent='有未保存修改';
    }
    brief.addEventListener('input',remember);notes.addEventListener('input',remember);
    function closeContext(){panel.hidden=true;toggle.setAttribute('aria-expanded','false');}
    toggle.addEventListener('click',()=>{
      if(!panel.hidden){closeContext();return;}
      switcher.hidden=true;switchButton.setAttribute('aria-expanded','false');
      const layer=document.querySelector('[data-testid="layer-panel"]');
      if(layer&&layer.getBoundingClientRect().width&&getComputedStyle(layer).visibility!=='hidden')document.querySelector('[data-testid="float-layer-button"]')?.click();
      panel.hidden=false;toggle.setAttribute('aria-expanded','true');schedule();
    });
    document.getElementById('nv-context-close').addEventListener('click',closeContext);
    save.addEventListener('click',async()=>{
      if(!contextLoaded||contextBusy)return;
      contextBusy=true;save.disabled=true;contextStatus.textContent='正在保存…';
      const submitted={projectId,brief:brief.value,notes:notes.value,revision};
      try{
        const result=await request('/compare/api/context',submitted);revision=result.revision;
        if(brief.value===submitted.brief&&notes.value===submitted.notes){storage.remove(draftKey());contextStatus.textContent='需求已保存';}
        else remember();
      }catch(e){contextStatus.textContent=e.message;if(e.result?.error?.includes('其他页面'))latest.hidden=false;}
      finally{contextBusy=false;save.disabled=false;}
    });
    latest.addEventListener('click',async()=>{
      if(contextBusy)return;
      contextBusy=true;latest.disabled=true;save.disabled=true;brief.disabled=true;notes.disabled=true;
      try{
        const value=await request('/compare/api/context?projectId='+encodeURIComponent(projectId));
        if(!storage.set('novart-compare-replaced:'+projectId,JSON.stringify({brief:brief.value,notes:notes.value,revision}))){contextStatus.textContent='无法备份当前草稿，请先复制内容；草稿仍保留。';return;}
        brief.value=value.brief;notes.value=value.notes;revision=value.revision;storage.remove(draftKey());
        contextStatus.textContent='已采用最新内容';latest.hidden=true;
      }catch(e){contextStatus.textContent=e.message;}
      finally{contextBusy=false;latest.disabled=false;save.disabled=false;brief.disabled=false;notes.disabled=false;}
    });
    switchButton.addEventListener('click',async()=>{
      switcher.hidden=!switcher.hidden;switchButton.setAttribute('aria-expanded',String(!switcher.hidden));
      if(switcher.hidden)return;
      closeContext();switcher.replaceChildren(el('p',null,'在新标签打开，保留当前会话'));
      try{
        const {projects}=await request('/compare/api/projects');
        for(const p of projects){const a=el('a',null,p.projectName||'未命名项目');a.href=canvasURL(p.projectId);a.target='_blank';a.rel='noopener';a.setAttribute('aria-current',String(p.projectId===projectId));switcher.append(a);}
        const a=el('a','nv-all','全部项目 / 创建项目');a.href='/compare';a.target='_blank';a.rel='noopener';switcher.append(a);
      }catch(e){switcher.append(el('p',null,e.message));}
      schedule();
    });
    document.addEventListener('pointerdown',e=>{if(!switcher.hidden&&!switcher.contains(e.target)&&!switchButton.contains(e.target)){switcher.hidden=true;switchButton.setAttribute('aria-expanded','false');}});
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&(!panel.hidden||!switcher.hidden)){closeContext();switcher.hidden=true;switchButton.setAttribute('aria-expanded','false');e.stopPropagation();}},true);
    function markHeader(testId){
      const control=document.querySelector('[data-testid="'+testId+'"]');
      if(!control)return;
      let node=control;
      while(node&&node!==document.body){if(getComputedStyle(node).position==='fixed'&&node.getBoundingClientRect().top<8){node.setAttribute('data-novart-native-header','');return;}node=node.parentElement;}
    }
    function layout(){
      scheduled=false;if(disposed)return;
      markHeader('brand-menu-button');markHeader('user-profile-trigger');
      const canvas=document.querySelector('.tl-container'), chat=document.querySelector('[data-testid="agent-panel-container"]');
      if(!canvas)return;
      const c=canvas.getBoundingClientRect();
      let left=c.left;
      const layer=document.querySelector('[data-testid="layer-panel"]'), lr=layer?.getBoundingClientRect();
      const layerOpen=Boolean(lr&&lr.width>1&&lr.height>1&&getComputedStyle(layer).visibility!=='hidden'&&getComputedStyle(layer).display!=='none'&&lr.right>c.left+1);
      if(layerOpen)left=Math.max(left,lr.right);
      if(layerOpen&&!lastLayerOpen&&!panel.hidden)closeContext();lastLayerOpen=layerOpen;
      const available=Math.max(0,c.right-left);
      const px=v=>Math.round(v)+'px';
      if(bar.style.left!==px(left))bar.style.left=px(left);
      if(bar.style.width!==px(available))bar.style.width=px(available);
      const pw=Math.min(340,Math.max(240,available-24));
      panel.style.right=px(innerWidth-c.right+12);panel.style.width=px(pw);
      const panelLeft=c.right-12-pw;
      let panelTop=58;
      for(const toast of document.querySelectorAll('li[data-sonner-toast][data-visible="true"][data-y-position="top"]')){
        const r=toast.getBoundingClientRect();
        if(r.width>1&&r.height>1&&r.right>panelLeft&&r.left<c.right-12&&r.bottom>58&&r.top<220)panelTop=Math.max(panelTop,r.bottom+10);
      }
      panel.style.top=px(panelTop);panel.style.maxHeight=px(Math.max(180,innerHeight-panelTop-80));
      switcher.style.left=px(left+48);
      let chatOpen=false;
      if(chat){const r=chat.getBoundingClientRect();chatOpen=r.width>1&&r.left<innerWidth&&r.right>0;availability.hidden=!chatOpen;availability.style.left=px(r.left);availability.style.width=px(r.width);}else availability.hidden=true;
      chatToggle.hidden=chatOpen||!nativeChatRestore();
    }
    function schedule(){if(!scheduled&&!disposed){scheduled=true;requestAnimationFrame(layout);}}
    const observer=new MutationObserver(records=>{if(records.some(r=>!bar.contains(r.target)&&!panel.contains(r.target)&&!switcher.contains(r.target)&&r.target!==availability))schedule();});
    observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','style','data-state','data-visible','data-removed','data-expanded']});
    window.addEventListener('resize',schedule);schedule();
    function showSaveReceipt(kind){
      const receipt=bar.querySelector('.nv-save');
      const savedAt=Number(receipt.dataset.savedAt||0);
      const time=savedAt ? new Date(savedAt).toLocaleTimeString('zh-CN',{hour12:false}) : '';
      const text=kind==='error' ? '画布保存失败 · 保留此页'
        : kind==='unconfirmed' ? '暂未确认保存 · 保留此页'
        : kind==='saved' ? '已存到本机 '+time : '等待首次画布保存';
      if(receipt.dataset.saveState!==kind)receipt.dataset.saveState=kind;
      const error=String(kind==='error'||kind==='unconfirmed');
      if(receipt.dataset.error!==error)receipt.dataset.error=error;
      if(receipt.textContent!==text)receipt.textContent=text;
    }
    async function update(){
      if(updateBusy)return;
      updateBusy=true;
      try{
      const current=new URLSearchParams(location.search).get('projectId');
      if(!current||disposed)return;
      if(current!==projectId){
        projectId=current;contextLoaded=false;save.disabled=true;brief.disabled=true;notes.disabled=true;
        try{
          const value=await request('/compare/api/context?projectId='+encodeURIComponent(projectId));revision=value.revision;brief.value=value.brief;notes.value=value.notes;
          let draft=null;try{draft=JSON.parse(storage.get(draftKey())||'null');}catch(_){}
          if(draft&&draft.revision===revision&&typeof draft.brief==='string'&&typeof draft.notes==='string'){
            brief.value=draft.brief;notes.value=draft.notes;contextStatus.textContent='已恢复未保存修改';
          }else if(draft&&Number.isInteger(draft.revision)&&typeof draft.brief==='string'&&typeof draft.notes==='string'){
            brief.value=draft.brief;notes.value=draft.notes;revision=draft.revision;
            contextStatus.textContent='其他页面已更新。草稿保留在上方，可先复制或采用最新内容。';latest.hidden=false;
          }
          else contextStatus.textContent='需求已保存';
          contextLoaded=true;save.disabled=false;brief.disabled=false;notes.disabled=false;
        }catch(e){contextStatus.textContent=e.message;projectId='';return;}
      }
      try{
        const state=await request('/compare/api/status?projectId='+encodeURIComponent(projectId));
        switchButton.querySelector('span').textContent=state.projectName||'未命名项目';
        const receipt=bar.querySelector('.nv-save');
        const savedAt=state.savedAt ? String(state.savedAt) : '';
        if(receipt.dataset.savedAt!==savedAt)receipt.dataset.savedAt=savedAt;
        showSaveReceipt(state.saveError ? 'error' : state.savedAt ? 'saved' : 'empty');
      }catch(e){showSaveReceipt('unconfirmed');}
      }finally{updateBusy=false;}
    }
    update();const timer=setInterval(()=>{if(!document.hidden)update();},1500);
    window.addEventListener('pagehide',()=>{disposed=true;clearInterval(timer);observer.disconnect();},{once:true});
  }
  if(document.getElementById('compare-app'))home();else if(new URLSearchParams(location.search).get('ui')==='novart')editor();
})();
