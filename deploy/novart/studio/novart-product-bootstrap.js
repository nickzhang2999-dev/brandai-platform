/* Product transport for the reviewed UI. Authentication remains Auth.js;
   the captured client's display hint is never accepted by any server gate. */
(() => {
  'use strict';
  const context = JSON.parse(document.getElementById('novart-product-context').textContent);
  window.__NOVART_PRODUCT__ = Object.freeze(context);
  // Install before any captured script executes. The SDK still validates the
  // signature, domain and expiry; a configured value is not a license verdict.
  const configuredLicense = context.canvasLicense?.key;
  const licenseValue = typeof configuredLicense === 'string' && configuredLicense.length <= 8192 && !/[\u0000-\u001f\u007f-\u009f]/.test(configuredLicense) ? configuredLicense : '';
  Object.defineProperty(globalThis, '__NOVART_TLDRAW_LICENSE_KEY', {value:licenseValue, writable:false, configurable:false, enumerable:false});
  const NativeWebSocket = window.WebSocket;
  window.WebSocket = class extends NativeWebSocket {
    constructor(address, protocols) {
      const url = new URL(address, location.href);
      if (url.host !== location.host || !['ws:', 'wss:'].includes(url.protocol)) throw new DOMException('实时服务尚未接入', 'SecurityError');
      super(address, protocols);
    }
  };
  const originalFetch = window.fetch.bind(window);
  const prefix = 'novart-product:' + encodeURIComponent(context.user.id) + ':' + encodeURIComponent(context.workspaceId || 'none') + ':';
  function scopedStorage(storage) {
    const keys = () => Array.from({length: storage.length}, (_, i) => storage.key(i)).filter(k => k?.startsWith(prefix)).map(k => k.slice(prefix.length));
    const methods = {getItem: k => storage.getItem(prefix + k), setItem: (k, v) => storage.setItem(prefix + k, String(v)),
      removeItem: k => storage.removeItem(prefix + k), clear: () => keys().forEach(k => storage.removeItem(prefix + k)), key: i => keys()[i] ?? null};
    return new Proxy({}, {
      get: (_target, key) => key === 'length' ? keys().length : key in methods ? methods[key] : typeof key === 'string' ? methods.getItem(key) : undefined,
      set: (_target, key, value) => { methods.setItem(key, value); return true; },
      deleteProperty: (_target, key) => { methods.removeItem(key); return true; },
      ownKeys: keys, getOwnPropertyDescriptor: (_target, key) => keys().includes(key) ? {enumerable:true, configurable:true, value:methods.getItem(key)} : undefined,
    });
  }
  for (const key of ['localStorage', 'sessionStorage']) {
    try { const storage = scopedStorage(window[key]); Object.defineProperty(window, key, {value:storage}); }
    catch (_) { /* Existing UI reports unavailable recovery storage. */ }
  }
  window.addEventListener('storage', event => {
    if (!event.isTrusted) return;
    event.stopImmediatePropagation();
    if (event.key?.startsWith(prefix)) window.dispatchEvent(new StorageEvent('storage', {key:event.key.slice(prefix.length), oldValue:event.oldValue, newValue:event.newValue, url:event.url}));
  }, true);
  for (const method of ['open', 'deleteDatabase']) {
    const original = indexedDB[method].bind(indexedDB);
    indexedDB[method] = (name, ...args) => original(prefix + name, ...args);
  }
  if (window.BroadcastChannel) { const Original = window.BroadcastChannel; window.BroadcastChannel = class extends Original { constructor(name) { super(prefix + name); } }; }
  const mapped = window.__NOVART_ASSET_MAP__ || {};
  const nativeHosts = new Set(['api.lovart.ai', 'api.lovart.art', 'client.lovart.ai', 'lgw.lovart.ai', 'lgw.lovart.art']);
  const scopedPath = path => /^\/(studio\/|compare\/api\/|workflow(?:\/|$)|api\/canva\/|api\/www\/)/.test(path);
  function localUrl(value) {
    const url = new URL(String(value), location.href);
    if (url.origin !== location.origin) {
      const captured = mapped[url.origin + url.pathname];
      if (captured) return new URL(captured, location.origin);
      if (nativeHosts.has(url.hostname) && /^\/api\/(canva|www)\//.test(url.pathname)) {
        url.protocol = location.protocol; url.host = location.host;
      } else if (/^https?:$/.test(url.protocol)) return new URL('/studio/unavailable', location.origin);
    }
    if (url.origin === location.origin && scopedPath(url.pathname) && context.workspaceId) url.searchParams.set('workspaceId', context.workspaceId);
    return url;
  }
  window.fetch = (input, init) => {
    const request = new Request(input, init), url = localUrl(request.url);
    const headers = new Headers(request.headers);
    if (url.origin === location.origin && scopedPath(url.pathname)) headers.set('X-Novart-User', context.user.id);
    // Never forward a vendor credential, authorization value or cookie cross-origin.
    headers.delete('authorization'); headers.delete('usertoken');
    const execute = body => originalFetch(new Request(url, {method:request.method, headers, credentials:'same-origin', cache:'no-store', redirect:request.redirect,
      signal:request.signal, keepalive:request.keepalive, body}));
    if (['GET','HEAD'].includes(request.method)) return execute(undefined);
    // Page-hide draft flushes use a string and keepalive: dispatch synchronously.
    const body = init?.body;
    if (typeof body === 'string' || body instanceof URLSearchParams || body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return execute(body);
    return request.arrayBuffer().then(execute);
  };
  const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) { this.__novartScope = scopedPath(localUrl(url).pathname); return open.call(this, method, localUrl(url).href, ...rest); };
  XMLHttpRequest.prototype.send = function(body) { if (this.__novartScope) this.setRequestHeader('X-Novart-User', context.user.id); return send.call(this, body); };
  // Keep an already open workspace pinned when another tab changes its brand.
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method].bind(history);
    history[method] = (state, title, address) => {
      if (address && context.workspaceId) { const url = new URL(address, location.href); if (url.origin === location.origin && ['/studio','/canvas'].includes(url.pathname)) { url.searchParams.set('workspaceId', context.workspaceId); address = url; } }
      return original(state, title, address);
    };
  }
  document.cookie = 'usertoken=' + encodeURIComponent(context.user.id) + '; Path=/; SameSite=Strict' + (location.protocol === 'https:' ? '; Secure' : '');
  document.cookie = '__locale=zh; Path=/; SameSite=Strict';
  const startup = document.createElement('div'); startup.className = 'np-startup'; startup.setAttribute('role','status'); startup.textContent = '正在打开工作台…'; document.body.append(startup);
  const style = document.createElement('style'); style.textContent = '.np-startup{position:fixed;inset:0;z-index:99999;display:grid;place-content:center;background:#f7f6fa;color:#35313d;font:15px/1.8 system-ui;padding:24px}.np-startup form{display:grid;gap:14px;width:min(360px,85vw)}.np-startup input{border:1px solid #e5e1ec;border-radius:12px;padding:12px;background:white;color:#42394f;min-width:0}.np-note{font-size:12px;color:#82798e;line-height:1.6}.np-logout{margin-top:16px}'; document.head.append(style);
  const brandStyle = document.createElement('style'); brandStyle.textContent = '.np-brand-switcher{min-width:0;margin:10px 0 14px}.np-brand-trigger{display:flex;align-items:center;gap:8px;width:100%;min-height:42px;border:1px solid var(--nv-line,#ececf3);border-radius:14px;padding:8px 10px;background:var(--nv-card,#fff);color:var(--nv-ink,#272530);font:inherit;cursor:pointer}.np-brand-label{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;font-size:13px}.np-brand-initial{display:none;flex-shrink:0;width:24px;height:24px;align-items:center;justify-content:center;border-radius:8px;background:var(--nv-accent-soft,#f4f0ff);color:var(--nv-accent,#7c5cff);font-size:12px}.np-brand-chevron{flex-shrink:0;width:12px;height:12px}.np-brand-trigger:focus-visible,.np-brand-menu button:focus-visible,.np-create-brand button:focus-visible,.np-create-brand input:focus-visible{outline:2px solid var(--nv-accent,#7c5cff);outline-offset:2px}.np-brand-menu,.np-create-brand{box-sizing:border-box;color:var(--nv-ink,#272530);background:var(--nv-card,#fff);border:1px solid var(--nv-line,#ececf3);border-radius:20px;padding:16px;font:13px/1.5 system-ui;box-shadow:0 16px 60px #27253020}.np-brand-menu{position:fixed;inset:auto;margin:0;width:min(280px,calc(100vw - 24px));max-height:min(70vh,500px);overflow:auto}.np-brand-menu::backdrop{background:transparent}.np-brand-menu h2{margin:0 0 12px;font-size:14px}.np-brand-menu button{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;min-height:40px;padding:10px;border:0;border-radius:12px;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer}.np-brand-menu button:hover{background:var(--nv-accent-soft,#f4f0ff)}.np-brand-option[aria-current=true]{color:var(--nv-accent,#7c5cff);background:var(--nv-accent-soft,#f4f0ff)}.np-brand-option span:first-child{min-width:0;overflow-wrap:anywhere}.np-brand-add{margin-top:12px!important;border-top:1px solid var(--nv-line,#ececf3)!important;border-radius:0!important;color:var(--nv-accent,#7c5cff)!important}.np-brand-status{margin:10px 0 0;color:var(--nv-secondary,#686874);overflow-wrap:anywhere;font-size:12px}.np-brand-status:empty{display:none}.np-create-brand{width:min(420px,calc(100vw - 32px));max-height:calc(100dvh - 32px);overflow:auto}.np-create-brand::backdrop{background:#27253045;backdrop-filter:blur(3px)}.np-create-brand h2{margin:0;font-size:18px}.np-create-brand p{color:var(--nv-secondary,#686874)}.np-create-brand label{display:grid;gap:8px;margin:20px 0}.np-create-brand input{box-sizing:border-box;width:100%;height:44px;border:1px solid var(--nv-line,#ececf3);border-radius:12px;padding:10px 12px;background:var(--nv-card,#fff);color:inherit;font:inherit}.np-create-brand footer{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}.np-create-brand button{min-height:40px;border:1px solid var(--nv-line,#ececf3);border-radius:999px;padding:8px 16px;background:var(--nv-card,#fff);color:inherit;font:inherit;cursor:pointer}.np-create-brand button[type=submit]{background:var(--nv-accent,#7c5cff);color:#fff;border-color:transparent}.np-brand-menu button:disabled,.np-create-brand button:disabled{opacity:.5;cursor:wait}'; document.head.append(brandStyle);
  const knownWorkspaces = Array.isArray(context.workspaces) ? [...context.workspaces] : [];
  const confirmedCreationFailures = new Set([400,401,402,403,404,405,409,413,422]);
  const unknownCreation = () => { const error = new Error('品牌创建结果尚未确认，请先检查品牌列表，避免重复创建。'); error.creationUncertain = true; return error; };
  async function brandRequest(path, value) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 12000);
    let response;
    try {
      const headers = {'Content-Type':'application/json','X-Novart-User':context.user.id};
      if (path === '/api/workspaces') headers['X-Novart-Mutation'] = crypto.randomUUID();
      response = await originalFetch(path, {method:'POST', credentials:'same-origin', cache:'no-store', headers, body:JSON.stringify(value), signal:controller.signal});
      let result;
      try { result = await response.json(); } catch (_) { throw new Error('操作回执暂时无法读取，请稍后确认。'); }
      if (!response.ok) throw new Error(result.error || '操作未完成，请稍后重试。');
      if (path === '/api/workspaces' && (!result || typeof result.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(result.id) || typeof result.name !== 'string' || !result.name.trim())) throw unknownCreation();
      return result;
    } catch (error) {
      if (path === '/api/workspaces' && (!response || response.ok || !confirmedCreationFailures.has(response.status))) throw unknownCreation();
      if (error.name === 'AbortError') throw new Error('服务响应超时，当前品牌和编辑内容仍保留。'); throw error;
    }
    finally { clearTimeout(timeout); }
  }
  async function refreshKnownBrands() {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(),12000);
    try {
      const query = context.workspaceId ? '?workspaceId=' + encodeURIComponent(context.workspaceId) : '';
      const response = await originalFetch('/api/workbench/session' + query, {credentials:'same-origin',cache:'no-store',headers:{'X-Novart-User':context.user.id},signal:controller.signal});
      const value = await response.json();
      if (!response.ok || value.user?.id !== context.user.id || !Array.isArray(value.workspaces) || value.workspaces.some(workspace => !workspace || typeof workspace.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(workspace.id) || typeof workspace.name !== 'string')) throw new Error('品牌列表尚未确认，旧列表仍保留，请稍后再次检查。');
      knownWorkspaces.splice(0,knownWorkspaces.length,...value.workspaces); return knownWorkspaces;
    } catch (error) { if (error.name === 'AbortError') throw new Error('品牌列表读取超时，当前页面仍保留，请稍后再次检查。'); throw error; }
    finally { clearTimeout(timeout); }
  }
  async function prepareBrandSwitch() {
    const state = window.NovartStudio?.snapshot();
    if (!state || state.stateLoaded !== true) throw new Error('当前品牌尚未读取完成，请确认内容已恢复后再切换品牌。');
    if (state.profileDirty || state.brandDirty || state.favoritesDirty || state.metadataConflict) throw new Error('请先保存当前品牌规范、偏好或收藏，再切换品牌。');
    if (state.createBusy || state.metadataBusy || state.archiveBusy || state.renameBusy || state.homeStart?.busy || state.homeStart?.running?.length || state.homeStart?.uploading) throw new Error('项目或图片正在保存，请完成后再切换品牌。');
    if (typeof window.NovartStudio.confirmBrandLeave !== 'function') throw new Error('首页保存组件尚未准备完成，请重新打开当前页面后再切换品牌。');
    await window.NovartStudio.confirmBrandLeave();
    const frames = [...document.querySelectorAll('#ns-frames iframe')];
    if (frames.some(frame => frame.dataset.ready !== 'true')) throw new Error('已有画布尚未恢复，请打开并确认后再切换品牌。');
    await Promise.all(frames.map(frame => new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID(), projectId = frame.dataset.projectId;
      const cleanup = () => { clearTimeout(timer); window.removeEventListener('message', receive); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('画布保存尚未确认，请返回工作台确认保存后再切换。')); }, 12000);
      function receive(event) {
        const value = event.data;
        if (event.origin !== location.origin || event.source !== frame.contentWindow || value?.type !== 'nv-studio' || value.action !== 'confirm-leave-result' || value.requestId !== requestId || value.projectId !== projectId) return;
        cleanup(); value.status === 'saved' ? resolve() : reject(new Error(value.error || '画布仍有未保存修改，请确认后再切换品牌。'));
      }
      window.addEventListener('message', receive);
      frame.contentWindow.postMessage({type:'nv-studio',action:'confirm-leave',projectId,requestId},location.origin);
    })));
  }
  async function selectBrand(workspaceId, destination = 'home') {
    if (context.workspaceId) await prepareBrandSwitch();
    const selected = await brandRequest('/api/workbench/session', {workspaceId});
    if (selected.user?.id !== context.user.id || selected.activeWorkspaceId !== workspaceId || !selected.workspaces?.some(workspace => workspace.id === workspaceId)) throw new Error('品牌切换回执无法确认，当前页面仍保留，请重试。');
    // Full navigation drops the old project route and recreates workspace-scoped storage.
    location.assign('/studio?workspaceId=' + encodeURIComponent(workspaceId) + (destination === 'brand' ? '#/brand' : '#/home'));
  }
  let nativeLicenseRejected = false, licenseObserver = null, licenseTimer = null;
  function checkNativeLicense() {
    if (nativeLicenseRejected || !document.querySelector('[data-testid="tl-license-expired"]')) return;
    nativeLicenseRejected = true;
    licenseObserver?.disconnect(); clearTimeout(licenseTimer);
    document.documentElement.dataset.nvStudioCanvasReady = 'false';
    startup.dataset.state = 'license-required';
    const explanation = document.createElement('p'), projects = document.createElement('a');
    explanation.textContent = '当前画布引擎未获得此域名授权。已保存的项目和素材仍保留，请管理员配置有效授权后刷新。';
    projects.textContent = '返回项目库'; projects.className = 'ns-primary'; projects.target = '_top';
    projects.href = '/studio?workspaceId=' + encodeURIComponent(context.workspaceId || '') + '#/projects';
    startup.replaceChildren(explanation, projects);
    if (!startup.isConnected) document.body.append(startup);
    // Embedded canvases use the m8 startup-error protocol; this also covers
    // direct /canvas visits, where there is no parent bridge.
  }
  if (location.pathname === '/canvas') {
    licenseObserver = new MutationObserver(checkNativeLicense);
    licenseObserver.observe(document.documentElement, {childList:true, subtree:true});
    checkNativeLicense();
    window.addEventListener('pagehide', () => { licenseObserver?.disconnect(); clearTimeout(licenseTimer); }, {once:true});
  }
  if (location.pathname === '/canvas' && (context.canvasLicense?.status !== 'configured' || !licenseValue)) {
    const notice = document.createElement('p'); notice.className = 'np-note np-license-note'; notice.setAttribute('role','status');
    notice.textContent = context.canvasLicense?.status === 'invalid' ? '画布授权配置需要检查，请联系管理员。已保存的项目和素材仍保留。' : '尚未配置画布授权，请联系管理员。已保存的项目和素材仍保留。';
    notice.style.cssText = 'position:fixed;top:56px;right:16px;max-width:min(460px,90vw);z-index:99998;padding:10px 14px;border-radius:12px;background:#f2edfa;color:#77618b;pointer-events:none';
    document.body.append(notice);
  }
  const message = text => { startup.replaceChildren(); const p = document.createElement('p'); p.textContent = text; const retry = document.createElement('button'); retry.className='ns-primary'; retry.textContent='重新打开'; retry.onclick=() => location.reload(); startup.append(p,retry); };
  async function createBrand() {
    startup.replaceChildren(); const form = document.createElement('form'), title = document.createElement('h1'), input = document.createElement('input'), submit = document.createElement('button'), status = document.createElement('p');
    title.textContent='创建你的第一个品牌'; input.required=true; input.maxLength=60; input.placeholder='品牌名称'; input.setAttribute('aria-label','品牌名称'); submit.textContent='进入工作台'; submit.className='ns-primary'; status.setAttribute('role','status'); form.append(title,input,submit,status); startup.append(form);
    let created = null, creationUncertain = false, saving = false;
    form.onsubmit=async event => { event.preventDefault(); if(saving||!input.value.trim())return; saving=true; submit.disabled=true; try {
      if (creationUncertain) {
        await refreshKnownBrands();
        if (!knownWorkspaces.length) { status.textContent='列表暂未发现品牌，请稍后再次检查。创建结果仍未确认，不会重复提交。'; return; }
        const heading=document.createElement('h1'), note=document.createElement('p'), list=document.createElement('div');heading.textContent='检查已有品牌';note.textContent='创建结果尚未确认，请选择列表中已有品牌继续。不会按名称自动认领或再次创建。';
        for (const workspace of knownWorkspaces) { const pick=document.createElement('button');pick.type='button';pick.className='ns-primary';pick.textContent=workspace.name;pick.dataset.workspaceId=workspace.id;pick.onclick=async()=>{if(saving)return;saving=true;list.querySelectorAll('button').forEach(button=>{button.disabled=true;});try{await selectBrand(workspace.id);}catch(error){status.textContent=error.message;saving=false;list.querySelectorAll('button').forEach(button=>{button.disabled=false;});}};list.append(pick); }
        startup.replaceChildren(heading,note,list,status); return;
      }
      if (!created) created = await brandRequest('/api/workspaces', {name:input.value.trim()});
      if (!created.id) throw new Error('品牌创建回执无法确认，请刷新品牌列表后重试。');
      input.disabled = true; await selectBrand(created.id, 'brand');
    } catch(error) { creationUncertain ||= Boolean(error.creationUncertain);status.textContent=(created ? '品牌已创建，尚未切换。' : '') + error.message;submit.textContent=created?'进入已创建的品牌':creationUncertain?'检查品牌列表':'进入工作台'; }
    finally {saving=false;submit.disabled=false;} }; input.focus();
  }
  function installBrandSwitcher(sidebar) {
    const box=document.createElement('div'), trigger=document.createElement('button'), label=document.createElement('span'), initial=document.createElement('span'), chevron=document.createElement('span');
    box.className='np-brand-switcher';trigger.type='button';trigger.className='np-brand-trigger';trigger.dataset.testid='product-brand-trigger';trigger.setAttribute('aria-haspopup','dialog');trigger.setAttribute('aria-expanded','false');trigger.setAttribute('aria-controls','np-brand-menu');
    const current=knownWorkspaces.find(workspace=>workspace.id===context.workspaceId), currentName=current?.name || '当前品牌';
    trigger.title='切换或新增品牌：'+currentName;trigger.setAttribute('aria-label','切换或新增品牌，当前 '+currentName);
    initial.className='np-brand-initial';initial.setAttribute('aria-hidden','true');initial.textContent=Array.from(currentName)[0];label.className='np-brand-label';label.textContent=currentName;
    chevron.className='np-brand-chevron';chevron.setAttribute('aria-hidden','true');chevron.innerHTML='<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m2 4 4 4 4-4"/></svg>';
    trigger.append(initial,label,chevron);box.append(trigger);sidebar.insertBefore(box,sidebar.querySelector('nav'));
    const menu=document.createElement('dialog'), heading=document.createElement('h2'), options=document.createElement('div'), add=document.createElement('button'), status=document.createElement('p');
    menu.id='np-brand-menu';menu.className='np-brand-menu';menu.dataset.testid='product-brand-menu';menu.setAttribute('aria-label','选择品牌');heading.textContent='你的品牌';options.className='np-brand-options';add.type='button';add.className='np-brand-add';add.textContent='＋ 新增品牌';add.dataset.testid='product-brand-add';status.className='np-brand-status';status.setAttribute('role','status');menu.append(heading,options,add,status);document.body.append(menu);
    let busy=false;
    const controls=()=>{trigger.disabled=busy;menu.querySelectorAll('button').forEach(button=>{button.disabled=busy;});};
    function render() {
      options.replaceChildren();
      for(const workspace of knownWorkspaces) {
        const option=document.createElement('button'), text=document.createElement('span'), selected=document.createElement('span');option.type='button';option.className='np-brand-option';option.dataset.workspaceId=workspace.id;option.dataset.testid='product-brand-option';text.textContent=workspace.name;selected.textContent=workspace.id===context.workspaceId?'当前':'';option.setAttribute('aria-current',String(workspace.id===context.workspaceId));option.append(text,selected);
        option.onclick=async()=>{
          if(busy)return;if(workspace.id===context.workspaceId){menu.close();return;}
          busy=true;status.textContent='正在确认保存并切换品牌…';controls();
          try{await selectBrand(workspace.id);}catch(error){status.textContent=error.message;busy=false;controls();}
        };options.append(option);
      }
      controls();
    }
    function position() {
      if(!menu.open)return;const rect=trigger.getBoundingClientRect(), width=menu.offsetWidth, height=menu.offsetHeight;
      menu.style.left=Math.max(12,Math.min(innerWidth-width-12,rect.right+8))+'px';menu.style.top=Math.max(12,Math.min(innerHeight-height-12,rect.top))+'px';
    }
    const menuButtons=()=>[...menu.querySelectorAll('button:not(:disabled)')];
    function openMenu(focusLast = false) {
      if(busy)return;if(menu.open){menu.close();return;}status.textContent='';render();menu.showModal();trigger.setAttribute('aria-expanded','true');position();
      const buttons=menuButtons();(focusLast ? buttons.at(-1) : menu.querySelector('.np-brand-option[aria-current=true]') || buttons[0])?.focus();
    }
    trigger.onclick=()=>openMenu();
    trigger.addEventListener('keydown',event=>{if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();openMenu(event.key==='ArrowUp');}});
    menu.addEventListener('keydown',event=>{
      if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key)||busy)return;event.preventDefault();
      const buttons=menuButtons(),current=buttons.indexOf(document.activeElement);
      const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(current+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;
      buttons[next]?.focus();
    });
    menu.addEventListener('close',()=>{trigger.setAttribute('aria-expanded','false');trigger.focus();});menu.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
    menu.addEventListener('click',event=>{if(!busy&&event.target===menu){const rect=menu.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)menu.close();}});
    window.addEventListener('resize',position);window.addEventListener('scroll',position,true);
    const openCreateBrand=()=>{
      if(busy||document.querySelector('.np-create-brand[open]'))return;const returnTarget=document.activeElement;menu.close();
      const dialog=document.createElement('dialog'), form=document.createElement('form'), title=document.createElement('h2'), note=document.createElement('p'), field=document.createElement('label'), input=document.createElement('input'), footer=document.createElement('footer'), cancel=document.createElement('button'), submit=document.createElement('button'), feedback=document.createElement('p');
      dialog.className='np-create-brand';dialog.dataset.testid='product-create-brand';dialog.setAttribute('aria-label','新增品牌');title.textContent='新增品牌';note.textContent='品牌拥有各自的项目、素材和视觉规范，创建后先完善新品牌的规范。';field.textContent='品牌名称';input.name='name';input.required=true;input.maxLength=60;input.autocomplete='off';input.placeholder='例如：海风咖啡';input.setAttribute('aria-label','品牌名称');field.append(input);cancel.type='button';cancel.textContent='取消';submit.type='submit';submit.textContent='创建并进入';feedback.className='np-brand-status';feedback.setAttribute('role','status');footer.append(cancel,submit);form.append(title,note,field,feedback,footer);dialog.append(form);document.body.append(dialog);
      let created=null, saving=false, creationUncertain=false;
      const close=()=>{if(saving)return;dialog.close();};cancel.onclick=close;
      dialog.addEventListener('close',()=>{dialog.remove();(returnTarget?.isConnected && !returnTarget.closest('dialog:not([open])') ? returnTarget : trigger).focus();});dialog.addEventListener('cancel',event=>{if(saving)event.preventDefault();});
      form.onsubmit=async event=>{
        event.preventDefault();if(saving||!input.value.trim())return;saving=true;submit.disabled=true;cancel.disabled=true;input.disabled=true;feedback.textContent='正在确认当前内容已保存…';
        try {
          if(creationUncertain){feedback.textContent='正在检查已有品牌，不会再次创建…';await refreshKnownBrands();render();dialog.close();status.textContent='创建结果尚未确认。请检查已有品牌并选择继续；若未看到新品牌，请稍后重新打开列表检查。';menu.showModal();trigger.setAttribute('aria-expanded','true');position();return;}
          if(!created){await prepareBrandSwitch();created=await brandRequest('/api/workspaces',{name:input.value.trim()});if(!created.id)throw new Error('品牌创建回执无法确认，请刷新品牌列表后检查。');knownWorkspaces.unshift({id:created.id,name:created.name,role:'OWNER'});render();}
          feedback.textContent='品牌已创建，正在打开规范…';await selectBrand(created.id, 'brand');
        } catch(error) {creationUncertain ||= Boolean(error.creationUncertain);feedback.textContent=(created?'品牌已创建，尚未切换。':'')+error.message;submit.textContent=created?'进入已创建的品牌':creationUncertain?'检查品牌列表':'重试创建';}
        finally {saving=false;submit.disabled=false;cancel.disabled=false;input.disabled=Boolean(created);}
      };
      dialog.showModal();input.focus();
    };
    add.onclick=openCreateBrand;
    document.getElementById('ns-brand-new')?.addEventListener('click',openCreateBrand);
  }
  async function start() {
    if (!context.workspaceId) { await createBrand(); return; }
    history.replaceState(history.state,'',location.href);
    // The authenticated shell and owned editor use same-origin resources.
    // Only the explicit legacy canvas needs captured external asset rewriting.
    if (location.pathname === '/canvas') {
      if (!('serviceWorker' in navigator)) throw Error('当前浏览器无法加载画布资源，请使用新版 Chrome 或 Edge。');
      await navigator.serviceWorker.register('/novart-product-worker.js',{scope:'/'});
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise((resolve,reject) => { const timeout=setTimeout(()=>reject(Error('资源初始化超时，请重新打开')),12000); navigator.serviceWorker.addEventListener('controllerchange',()=>{clearTimeout(timeout);resolve();},{once:true}); });
    }
    const adapters = location.pathname === '/canvas' ? ['/novart-product-materials.js','/novart-product-generation.js','/novart-product-task-inbox.js'] : ['/novart-product-task-inbox.js'];
    for (const source of adapters) await new Promise((resolve,reject) => {
      const script=document.createElement('script');script.src=source;script.onload=resolve;script.onerror=()=>reject(Error('创作组件加载失败，请重新打开'));document.head.append(script);
    });
    // Blocking native scripts run before defer overlays, matching HTML semantics.
    const scripts=[...document.querySelectorAll('script[type="application/x-novart"]')];
    scripts.sort((a,b)=>Number(a.hasAttribute('defer'))-Number(b.hasAttribute('defer')));
    for(const old of scripts) await new Promise((resolve,reject)=>{const script=document.createElement('script');script.async=false;if(old.src){script.src=old.src;script.onload=resolve;script.onerror=()=>reject(Error('工作台资源加载失败，请重试'));}else{script.textContent=old.textContent;}old.replaceWith(script);if(!script.src)resolve();});
    checkNativeLicense();
    if (nativeLicenseRejected) return;
    // Observe the actual SDK node through its asynchronous startup/5s refusal,
    // not synthetic license state. Stop after a bounded startup window.
    if (licenseObserver) licenseTimer = setTimeout(() => licenseObserver?.disconnect(), 60000);
    const sidebar=document.querySelector('.ns-sidebar');
    if(sidebar) {
      installBrandSwitcher(sidebar);
      const settings=document.getElementById('ns-settings-form'), logout=document.createElement('button');logout.className='ns-secondary np-logout';logout.type='button';logout.textContent='退出登录';
      logout.onclick=async()=>{logout.disabled=true;try{const csrf=await (await originalFetch('/api/auth/csrf')).json();const result=await originalFetch('/api/auth/signout',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrfToken:csrf.csrfToken,callbackUrl:location.origin+'/login'})});if(!result.ok)throw Error('退出失败');document.cookie='usertoken=; Path=/; Max-Age=0';location.replace('/login?callbackUrl=%2Fstudio');}catch(_){logout.disabled=false;logout.textContent='退出失败，点击重试';}};
      settings?.append(logout);
    }
    if(context.readOnly && location.pathname==='/canvas') {
      const deadline=Date.now()+20000;
      await new Promise((resolve, reject) => {
        const timer = setInterval(() => {
          if (nativeLicenseRejected) { clearInterval(timer); reject(Error('画布授权校验未通过')); return; }
          if (Date.now() > deadline) { clearInterval(timer); reject(Error('只读画布未能就绪，请重新打开')); return; }
          // Wait for native mounting before requiring captured modules. Requiring
          // an unregistered module can cache incomplete exports during startup.
          if (!document.querySelector('.tl-container, .tl-canvas')) return;
          try {
            let app;
            window.webpackChunk_lovartai_lovart_shell?.push([['novart-readonly-' + Date.now()], {}, require => {
              if (typeof require.m?.[37750] === 'function') app = require(37750).pW;
            }]);
            const editor = app?.getEditor();
            if (editor) { editor.updateInstanceState({ isReadonly: true }); clearInterval(timer); resolve(); }
          } catch (_) { /* Native mounting has not finished; retry within the deadline. */ }
        }, 100);
      });
    }
    if (location.pathname === '/canvas') {
      window.NovartProductMaterials?.start();
      window.NovartProductGeneration?.start();
      const availability = () => {
        for (const button of document.querySelectorAll('[data-testid="generate-menu-image"], [data-testid="generate-menu-video"], [data-testid="nav-font-gen-button"]')) {
          if (!button.disabled) button.disabled = true;
          if (button.title !== '此工具尚未接入，请使用输入框提交图片生成') button.title = '此工具尚未接入，请使用输入框提交图片生成';
        }
      };
      availability(); new MutationObserver(availability).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled']});
    }
    window.NovartProductTaskInbox?.start();
    if (nativeLicenseRejected) return;
    startup.remove();
    window.dispatchEvent(new Event('novart-product-ready'));
  }
  start().catch(error=>{ if (!nativeLicenseRejected) message(error.message); });
})();
