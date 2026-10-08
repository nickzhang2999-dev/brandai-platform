/* Product transport for the reviewed UI. Authentication remains Auth.js;
   the captured client's display hint is never accepted by any server gate. */
(() => {
  'use strict';
  const context = JSON.parse(document.getElementById('novart-product-context').textContent);
  window.__NOVART_PRODUCT__ = Object.freeze(context);
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
  const style = document.createElement('style'); style.textContent = '.np-startup{position:fixed;inset:0;z-index:99999;display:grid;place-content:center;background:#f7f6fa;color:#35313d;font:15px/1.8 system-ui;padding:24px}.np-startup form{display:grid;gap:14px;width:min(360px,85vw)}.np-startup input,.np-brand{border:1px solid #e5e1ec;border-radius:12px;padding:12px;background:white;color:#42394f;min-width:0}.np-brand{margin:12px 12px 8px;max-width:calc(100% - 24px);font:inherit}.np-note{font-size:12px;color:#82798e;line-height:1.6}.np-logout{margin-top:16px}'; document.head.append(style);
  const message = text => { startup.replaceChildren(); const p = document.createElement('p'); p.textContent = text; const retry = document.createElement('button'); retry.className='ns-primary'; retry.textContent='重新打开'; retry.onclick=() => location.reload(); startup.append(p,retry); };
  async function createBrand() {
    startup.replaceChildren(); const form = document.createElement('form'), title = document.createElement('h1'), input = document.createElement('input'), submit = document.createElement('button'), status = document.createElement('p');
    title.textContent='创建你的第一个品牌'; input.required=true; input.maxLength=60; input.placeholder='品牌名称'; input.setAttribute('aria-label','品牌名称'); submit.textContent='进入工作台'; submit.className='ns-primary'; status.setAttribute('role','status'); form.append(title,input,submit,status); startup.append(form);
    form.onsubmit=async event => { event.preventDefault(); if(!input.value.trim())return; submit.disabled=true; try {
      const response=await originalFetch('/api/workspaces',{method:'POST',headers:{'Content-Type':'application/json','X-Novart-User':context.user.id},body:JSON.stringify({name:input.value.trim()})}); const value=await response.json(); if(!response.ok)throw Error(value.error || '创建失败，请重试'); location.replace('/studio?workspaceId='+encodeURIComponent(value.id));
    } catch(error) { status.textContent=error.message; submit.disabled=false; } }; input.focus();
  }
  async function start() {
    if (!context.workspaceId) { await createBrand(); return; }
    history.replaceState(history.state,'',location.href);
    if (!('serviceWorker' in navigator)) throw Error('当前浏览器无法加载画布资源，请使用新版 Chrome 或 Edge。');
    await navigator.serviceWorker.register('/novart-product-worker.js',{scope:'/'});
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((resolve,reject) => { const timeout=setTimeout(()=>reject(Error('资源初始化超时，请重新打开')),12000); navigator.serviceWorker.addEventListener('controllerchange',()=>{clearTimeout(timeout);resolve();},{once:true}); });
    // Blocking native scripts run before defer overlays, matching HTML semantics.
    const scripts=[...document.querySelectorAll('script[type="application/x-novart"]')];
    scripts.sort((a,b)=>Number(a.hasAttribute('defer'))-Number(b.hasAttribute('defer')));
    for(const old of scripts) await new Promise((resolve,reject)=>{const script=document.createElement('script');script.async=false;if(old.src){script.src=old.src;script.onload=resolve;script.onerror=()=>reject(Error('工作台资源加载失败，请重试'));}else{script.textContent=old.textContent;}old.replaceWith(script);if(!script.src)resolve();});
    const sidebar=document.querySelector('.ns-sidebar');
    if(sidebar) {
      const select=document.createElement('select');select.className='np-brand';select.setAttribute('aria-label','当前品牌');
      for(const workspace of context.workspaces){const option=new Option(workspace.name,workspace.id);option.selected=workspace.id===context.workspaceId;select.add(option);}
      // A separate tab preserves unsaved canvases in the current brand.
      select.onchange=()=>{const url='/studio?workspaceId='+encodeURIComponent(select.value); const link=document.createElement('a');link.href=url;link.target='_blank';link.rel='noopener';link.click();select.value=context.workspaceId;};
      sidebar.insertBefore(select,sidebar.querySelector('nav'));
      const settings=document.getElementById('ns-settings-form'), logout=document.createElement('button');logout.className='ns-secondary np-logout';logout.type='button';logout.textContent='退出登录';
      logout.onclick=async()=>{logout.disabled=true;try{const csrf=await (await originalFetch('/api/auth/csrf')).json();const result=await originalFetch('/api/auth/signout',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrfToken:csrf.csrfToken,callbackUrl:location.origin+'/login'})});if(!result.ok)throw Error('退出失败');document.cookie='usertoken=; Path=/; Max-Age=0';location.replace('/login?callbackUrl=%2Fstudio');}catch(_){logout.disabled=false;logout.textContent='退出失败，点击重试';}};
      settings?.append(logout);
    }
    if(context.readOnly && location.pathname==='/canvas') {
      const deadline=Date.now()+20000;
      await new Promise((resolve, reject) => {
        const timer = setInterval(() => {
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
      const availability = () => {
        for (const button of document.querySelectorAll('[data-testid="agent-send-button"], [data-testid="generate-menu-image"], [data-testid="generate-menu-video"], [data-testid="nav-font-gen-button"]')) {
          if (!button.disabled) button.disabled = true;
          if (button.title !== 'AI 生成正在接入，当前输入会保留为草稿') button.title = 'AI 生成正在接入，当前输入会保留为草稿';
          if (button.dataset.testid === 'agent-send-button' && !button.parentElement.querySelector('.np-ai-status')) {
            const note=document.createElement('span');note.className='np-note np-ai-status';note.textContent='AI 生成接入中';button.before(note);
          }
        }
      };
      availability(); new MutationObserver(availability).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled']});
      window.addEventListener('keydown',event=>{if(event.key==='Enter' && !event.shiftKey && !event.isComposing && event.target.closest?.('[data-testid="agent-message-input"]')){event.preventDefault();event.stopImmediatePropagation();}},true);
    }
    startup.remove();
    window.dispatchEvent(new Event('novart-product-ready'));
  }
  start().catch(error=>message(error.message));
})();
