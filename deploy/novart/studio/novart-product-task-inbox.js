/* Terminal reminders reuse the authenticated notification inbox. This adapter
   never creates tasks, inserts images, or treats browser storage as task state. */
(() => {
  'use strict';
  const context = window.__NOVART_PRODUCT__;
  if (!context?.user?.id || !context.workspaceId) return;
  const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
  const node = (tag, value = '', className) => { const element = document.createElement(tag); element.textContent = value; if (className) element.className = className; return element; };
  const projectId = new URLSearchParams(location.search).get('projectId');
  const identity = value => value?.workspaceId === context.workspaceId && value?.userId === context.user.id;
  const adapters = {STUDIO_UPLOAD:'NovartProductMaterials', STUDIO_GENERATION:'NovartProductGeneration'};
  let started = false, stopped = false, canvasBusy = false;
  async function focusCanvas(value) {
    if (!identity(value) || value.projectId !== projectId || !validId(value.taskId) || !adapters[value.kind]) throw Error('任务不属于当前画布');
    if (canvasBusy) throw Error('正在打开上一条任务，请稍后重试');
    canvasBusy = true;
    try {
      const deadline = Date.now() + 12000;
      while (!stopped && !window[adapters[value.kind]]?.focusTask && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      if (stopped || !window[adapters[value.kind]]?.focusTask) throw Error('画布任务尚未就绪，请重新打开');
      await window[adapters[value.kind]].focusTask(value.taskId);
    } finally { canvasBusy = false; }
  }
  function canvasStart() {
    window.addEventListener('message', async event => {
      const value = event.data;
      if (event.origin !== location.origin || event.source !== parent || parent === window || value?.type !== 'novart-product-task-open'
        || !identity(value) || value.projectId !== projectId || !validId(value.token)) return;
      try {
        await focusCanvas(value);
        if (!stopped) parent.postMessage({...value,type:'novart-product-task-opened',ok:true},location.origin);
      } catch (error) {
        if (!stopped) parent.postMessage({...value,type:'novart-product-task-opened',ok:false,error:error.message},location.origin);
      }
    });
    // Direct notification links also work outside the shell. Opening them only
    // expands the existing authenticated task receipt; insertion stays explicit.
    const params = new URLSearchParams(location.search), taskId = params.get('taskId'), requestId = params.get('requestId');
    if (validId(projectId) && (validId(taskId) !== validId(requestId))) {
      focusCanvas({workspaceId:context.workspaceId,userId:context.user.id,projectId,taskId:taskId || requestId,kind:taskId?'STUDIO_UPLOAD':'STUDIO_GENERATION'})
        .catch(() => { /* Existing task panels retain their visible refresh path. */ });
    }
  }

  let trigger, panel, list, status, refreshButton, openElsewhere, items = [], seen = {}, sequence = 0;
  let timer, controller, busy = false, failures = 0, paused = false, denied = false, pending = null, handoffTimer;
  const seenKey = 'task-inbox-seen:' + encodeURIComponent(context.user.id) + ':' + encodeURIComponent(context.workspaceId);
  const endpoint = '/api/workspaces/' + encodeURIComponent(context.workspaceId) + '/notifications?scope=studio';
  function parse(value) {
    if (!value || !Array.isArray(value.items) || value.items.length > 50) throw Error('任务列表响应不完整，请刷新');
    const ids = new Set();
    return value.items.map(item => {
      if (!item || !adapters[item.kind] || !['SUCCEEDED','FAILED'].includes(item.status) || typeof item.id !== 'string' || item.id.length > 180
        || ids.has(item.id) || typeof item.title !== 'string' || item.title.length > 500 || item.detail != null && (typeof item.detail !== 'string' || item.detail.length > 5000)
        || !Number.isFinite(Date.parse(item.createdAt)) || typeof item.href !== 'string') throw Error('任务列表响应不完整，请刷新');
      ids.add(item.id);
      const url = new URL(item.href,location.origin), upload = item.kind === 'STUDIO_UPLOAD';
      const id = url.searchParams.get(upload?'taskId':'requestId'), project = url.searchParams.get('projectId');
      if (url.origin !== location.origin || url.pathname !== '/canvas' || url.hash || url.searchParams.get('workspaceId') !== context.workspaceId
        || !validId(id) || !validId(project) || url.searchParams.has(upload?'requestId':'taskId')) throw Error('任务地址不属于当前品牌，请刷新');
      const target = new URL('/canvas',location.origin);
      target.searchParams.set('workspaceId',context.workspaceId); target.searchParams.set('projectId',project); target.searchParams.set(upload?'taskId':'requestId',id);
      return {...item,projectId:project,taskId:id,href:target.pathname+target.search,stamp:item.createdAt+'|'+item.status+'|'+item.title};
    });
  }
  function markSeen() {
    for (const item of items) seen[item.id] = item.stamp;
    const keep = Object.entries(seen).slice(-200); seen = Object.fromEntries(keep);
    try { localStorage.setItem(seenKey,JSON.stringify(seen)); } catch { /* Only read markers; all tasks remain server-backed. */ }
  }
  function position() {
    if (!panel || panel.hidden) return;
    const rect = trigger.getBoundingClientRect(), width = Math.min(360,innerWidth - 24);
    panel.style.width = width+'px'; panel.style.left = Math.max(12,Math.min(rect.right+12,innerWidth-width-12))+'px';
    panel.style.bottom = Math.max(12,Math.min(innerHeight-rect.bottom,innerHeight-120))+'px';
  }
  function close(returnFocus = true) { panel.hidden = true; trigger.setAttribute('aria-expanded','false'); if (returnFocus) trigger.focus(); }
  function updateBadge() {
    const unread = items.filter(item => seen[item.id] !== item.stamp).length;
    trigger.querySelector('.np-inbox-count').textContent = unread ? String(unread) : '';
    trigger.querySelector('.np-inbox-count').hidden = !unread;
    trigger.setAttribute('aria-label',denied?'任务，登录状态已变化':unread?'任务，'+unread+'条新提醒':'任务');
  }
  function render() {
    if (!list) return;
    const focused = list.contains(document.activeElement) ? document.activeElement?.closest('[data-notification-id]')?.dataset.notificationId : null;
    list.replaceChildren();
    for (const item of items) {
      const row = node('li','','np-inbox-row'); row.dataset.notificationId = item.id; row.dataset.status = item.status; row.dataset.kind = item.kind; row.dataset.taskId = item.taskId; row.dataset.projectId = item.projectId;
      row.append(node('strong',item.title));
      if (item.detail) row.append(node('p',item.detail));
      const when = node('time',new Date(item.createdAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})); when.dateTime = item.createdAt;
      const action = node('button','返回项目'); action.type = 'button'; action.dataset.action = 'open-task'; action.onclick = () => openTask(item); action.disabled = denied;
      row.append(when,action); list.append(row);
      if (focused === item.id) action.focus({preventScroll:true});
    }
    if (!items.length && !denied) list.append(node('li','暂无已完成的任务','np-inbox-empty'));
    if (!panel.hidden) markSeen(); updateBadge();
  }
  function schedule(delay = 30000) {
    clearTimeout(timer);
    if (!stopped && !paused && !denied && document.visibilityState === 'visible') timer = setTimeout(() => refresh(true),delay);
  }
  async function refresh(automatic = false) {
    if (stopped || busy || denied) return;
    if (!automatic) { paused = false; failures = 0; }
    busy = true; clearTimeout(timer); refreshButton.disabled = true;
    const epoch = sequence, requestController = new AbortController(); controller = requestController;
    const timeout = setTimeout(() => requestController.abort(),12000);
    try {
      const response = await fetch(endpoint,{headers:{'X-Novart-User':context.user.id},credentials:'same-origin',cache:'no-store',redirect:'manual',signal:requestController.signal});
      if (epoch !== sequence || stopped) return;
      if ([401,403,409].includes(response.status) || response.type === 'opaqueredirect') { denied = true; items = []; pending = null; clearTimeout(handoffTimer); openElsewhere.hidden = true; throw Error('登录或品牌权限已变化，请刷新页面后查看任务'); }
      if (!response.ok) { const error = Error('暂时无法读取任务'); error.retryable = response.status >= 500 || response.status === 429; throw error; }
      const next = parse(await response.json());
      if (epoch !== sequence || stopped) return;
      items = next; failures = 0; paused = false; if (!pending && openElsewhere.hidden) status.textContent = ''; render(); schedule();
    } catch (error) {
      if (epoch !== sequence || stopped) return;
      failures++;
      if (!denied && (error.retryable || error.name === 'AbortError' || error instanceof TypeError) && failures <= 3) {
        status.textContent = '正在重新读取任务（'+failures+'/3）'; schedule(Math.min(20000,2500*2**(failures-1)));
      } else { paused = true; status.textContent = denied?error.message:'任务提醒暂未更新，请点“刷新”；服务器仍会继续处理已受理任务。'; }
      render();
    } finally { clearTimeout(timeout); if (controller === requestController) controller = null; busy = false; refreshButton.disabled = denied; }
  }
  function openTask(item) {
    if (denied || stopped) return;
    clearTimeout(handoffTimer);
    pending = {...item,token:crypto.randomUUID(),deadline:Date.now()+25000,frame:null,sent:false};
    status.textContent = '正在打开对应项目…'; openElsewhere.hidden = true; openElsewhere.href = item.href;
    // The shell's existing anchor handler preserves its live editor sessions,
    // history and unsent drafts. No location.reload or document replacement.
    const link = node('a'); link.href = location.pathname+location.search+'#/workspace/'+encodeURIComponent(item.projectId); document.body.append(link); link.click(); link.remove();
    handoff();
  }
  function handoff() {
    clearTimeout(handoffTimer); const intent = pending; if (!intent || stopped || denied) return;
    if (location.hash !== '#/workspace/'+intent.projectId) { pending = null; status.textContent = ''; return; }
    if (Date.now() > intent.deadline) { pending = null; status.textContent = '此项目暂未展开，可在新标签页查看任务；当前画布与草稿仍保留。'; openElsewhere.hidden = false; return; }
    const frame = document.querySelector('iframe[data-testid="studio-canvas-frame"][data-project-id="'+intent.projectId+'"]');
    // The owned React editor publishes readiness after restoring the real document.
    // Keep the legacy adapter for the captured editor, but do not depend on it.
    let taskReady = false;
    try {
      const editor = frame?.contentWindow;
      taskReady = editor?.document.documentElement.dataset.nvStudioCanvasReady === 'true'
        && !!editor.document.querySelector('[data-testid="owned-editor"]')
        || !!editor?.NovartProductTaskInbox?.ready();
    } catch { /* A navigating or foreign frame is not a valid task receiver. */ }
    if (!intent.sent && frame?.dataset.ready === 'true' && frame.closest('.ns-frame-slot')?.dataset.active === 'true' && taskReady) {
      intent.frame = frame; intent.sent = true;
      frame.contentWindow.postMessage({type:'novart-product-task-open',workspaceId:context.workspaceId,userId:context.user.id,projectId:intent.projectId,kind:intent.kind,taskId:intent.taskId,token:intent.token},location.origin);
    }
    handoffTimer = setTimeout(handoff,200);
  }
  function shellStart() {
    const host = document.querySelector('.ns-sidebar-bottom'); if (!host) return;
    try { const value = JSON.parse(localStorage.getItem(seenKey)||'{}'); if (value && typeof value === 'object' && !Array.isArray(value)) seen = Object.fromEntries(Object.entries(value).filter(([id,stamp]) => id.length<=180 && typeof stamp==='string' && stamp.length<=800).slice(-200)); } catch {}
    const style = node('style'); style.textContent = '.np-inbox-trigger{position:relative;display:flex;align-items:center;gap:10px;width:100%;min-height:42px;border:0;border-radius:14px;padding:10px 14px;background:transparent;color:inherit;font:inherit;cursor:pointer}.np-inbox-trigger:hover{background:var(--nv-accent-soft,#f2efff)}.np-inbox-count{margin-left:auto;min-width:19px;height:19px;padding:0 4px;border-radius:99px;background:var(--nv-accent,#7c5cff);color:white;font:11px/19px system-ui;text-align:center}.np-inbox-count[hidden],.np-task-inbox[hidden]{display:none}.np-task-inbox{position:fixed;z-index:1600;max-height:min(70vh,480px);overflow:auto;box-sizing:border-box;padding:16px;border:1px solid var(--nv-line,#e5e5eb);border-radius:20px;background:white;color:var(--nv-ink,#303038);box-shadow:0 10px 40px #18181b18;font:13px/1.5 system-ui}.np-inbox-heading{display:flex;align-items:center;gap:10px}.np-inbox-heading h2{margin:0;flex:1;font-size:15px}.np-task-inbox button,.np-task-inbox a{color:inherit;font:inherit}.np-task-inbox button{border:1px solid var(--nv-line,#e5e5eb);border-radius:10px;padding:5px 9px;background:white;cursor:pointer}.np-task-inbox button:disabled{opacity:.5;cursor:default}.np-inbox-status{font-size:12px;color:var(--nv-secondary,#686874);overflow-wrap:anywhere}.np-inbox-list{list-style:none;padding:0;margin:0}.np-inbox-row{display:grid;gap:6px;padding:14px 0;border-top:1px solid var(--nv-line,#e5e5eb)}.np-inbox-row p{margin:0;overflow-wrap:anywhere;max-height:7em;overflow:auto}.np-inbox-row time{font-size:11px;color:var(--nv-secondary,#686874)}.np-inbox-row button{justify-self:start}.np-inbox-empty{padding:20px 0;color:var(--nv-secondary,#686874)}.np-inbox-trigger:focus-visible,.np-task-inbox button:focus-visible{outline:2px solid var(--nv-accent,#7c5cff);outline-offset:2px}@media(max-width:700px){.np-inbox-trigger{padding:10px;justify-content:center}.np-inbox-label{display:none}.np-inbox-count{position:absolute;top:1px;right:1px}}'; document.head.append(style);
    trigger = node('button','','np-inbox-trigger'); trigger.type = 'button'; trigger.dataset.testid = 'product-task-inbox-trigger'; trigger.setAttribute('aria-haspopup','dialog'); trigger.setAttribute('aria-expanded','false'); trigger.setAttribute('aria-controls','np-task-inbox');
    const icon = node('span','♧'); icon.setAttribute('aria-hidden','true'); icon.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>';
    const count = node('span','','np-inbox-count'); count.hidden = true; trigger.append(icon,node('span','任务','np-inbox-label'),count); host.prepend(trigger);
    panel = node('section','','np-task-inbox'); panel.id = 'np-task-inbox'; panel.dataset.testid = 'product-task-inbox'; panel.setAttribute('role','dialog'); panel.setAttribute('aria-label','任务提醒'); panel.hidden = true;
    const heading = node('div','','np-inbox-heading'), title = node('h2','任务提醒'), hide = node('button','关闭'); hide.type = 'button'; hide.onclick = () => close();
    refreshButton = node('button','刷新'); refreshButton.type = 'button'; refreshButton.dataset.action = 'refresh'; refreshButton.onclick = () => refresh();
    heading.append(title,refreshButton,hide); status = node('p','','np-inbox-status'); status.setAttribute('role','status'); list = node('ul','','np-inbox-list');
    openElsewhere = node('a','在新标签页查看任务'); openElsewhere.target = '_blank'; openElsewhere.rel = 'noopener'; openElsewhere.hidden = true;
    panel.append(heading,status,openElsewhere,list); document.body.append(panel);
    trigger.onclick = () => { if (!panel.hidden) { close(); return; } panel.hidden = false; trigger.setAttribute('aria-expanded','true'); markSeen(); updateBadge(); position(); refreshButton.focus(); refresh(); };
    document.addEventListener('pointerdown',event => { if (!panel.hidden && !panel.contains(event.target) && !trigger.contains(event.target)) close(false); });
    document.addEventListener('keydown',event => { if (event.key === 'Escape' && !panel.hidden) { event.preventDefault(); close(); } });
    window.addEventListener('resize',position);
    window.addEventListener('message',event => {
      const value = event.data, intent = pending;
      if (!intent || event.origin !== location.origin || event.source !== intent.frame?.contentWindow || value?.type !== 'novart-product-task-opened'
        || !identity(value) || value.token !== intent.token || value.projectId !== intent.projectId || value.taskId !== intent.taskId || value.kind !== intent.kind) return;
      pending = null; clearTimeout(handoffTimer);
      if (location.hash !== '#/workspace/'+intent.projectId) return;
      if (value.ok === true) { status.textContent = ''; close(false); }
      else { status.textContent = typeof value.error === 'string'?value.error.slice(0,300):'任务未能展开，请刷新重试'; openElsewhere.hidden = false; }
    });
    window.addEventListener('focus',() => { if (!denied) refresh(); });
    document.addEventListener('visibilitychange',() => { if (document.visibilityState === 'visible') refresh(); else clearTimeout(timer); });
    render(); refresh();
  }
  function start() { if (started) return; started = true; const path = location.pathname.replace(/\/+$/,''); if (path === '/canvas') canvasStart(); else if (path === '/studio') shellStart(); }
  window.addEventListener('pagehide',() => { stopped = true; sequence++; clearTimeout(timer); clearTimeout(handoffTimer); pending = null; controller?.abort(); });
  window.addEventListener('pageshow',event => { if (event.persisted) { stopped = false; if (trigger) refresh(); } });
  window.NovartProductTaskInbox = Object.freeze({start,ready:() => started && !stopped});
})();
