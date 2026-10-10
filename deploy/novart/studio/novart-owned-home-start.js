/* Product homepage handoff. Files stay recoverable until the owned editor
   confirms an actual document save. No captured-editor APIs or AI calls. */
window.createHomeStart = function createHomeStart(host) {
  'use strict';
  const $ = id => document.getElementById(id), {api, node, button, notify} = host;
  const key = 'owned-home-start-v1', limit = 10 * 1024 * 1024, budgetMs = 120000;
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  const identity = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
  const types = ['image/png','image/jpeg','image/webp'];
  let items = [], submitted = null, busy = false, loaded = false, draftError = '', latestEntry = null, recoveryBlocked = false;
  let saveQueue = Promise.resolve();
  const runs = new Map(), states = new Map(), waiters = new Map();
  const dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open('novart-owned-home-start', 1);
    const timer = setTimeout(() => reject(new Error('恢复空间打开超时')),8000);
    request.onupgradeneeded = () => request.result.createObjectStore('draft');
    request.onsuccess = () => { clearTimeout(timer); resolve(request.result); };
    request.onerror = request.onblocked = () => { clearTimeout(timer); reject(new Error('恢复空间暂不可用')); };
  });
  async function dbTask(mode, value) {
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('draft', mode), store = transaction.objectStore('draft');
      const request = mode === 'readonly' ? store.get(key) : store.put(value, key);
      const timer = setTimeout(() => { try { transaction.abort(); } catch {} reject(new Error('恢复记录保存超时')); },8000);
      transaction.oncomplete = () => { clearTimeout(timer); resolve(request.result); };
      transaction.onerror = transaction.onabort = () => { clearTimeout(timer); reject(new Error('恢复记录未能保存')); };
    });
  }
  function persist() {
    // Cache only recoverable input and stable identities. Material readiness
    // and saved status are rechecked with the backend/editor on every resume.
    const value = {version:1, items:items.map(({id,file,name,taskId}) => ({id,file,name,taskId})), submitted:submitted ? {...submitted} : null};
    saveQueue = saveQueue.catch(() => {}).then(() => dbTask('readwrite', value));
    return saveQueue.catch(() => { draftError = '恢复记录未能保存。请保留本页和原图，恢复存储空间后继续。'; render(); throw new Error(draftError); });
  }
  function validFile(file) { return file instanceof Blob && types.includes(file.type) && file.size > 0 && file.size <= limit; }
  function materialReceipt(value) {
    const workspace = window.__NOVART_PRODUCT__?.workspaceId;
    if (!value || !identity(value.id) || !identity(value.assetId) || !/^[a-f0-9]{64}$/.test(value.assetSha256)
      || value.kind !== 'image' || !types.includes(value.mimeType) || typeof value.fileName !== 'string' || !value.fileName.length || value.fileName.length > 255
      || !Number.isInteger(value.sizeBytes) || value.sizeBytes < 1 || value.sizeBytes > limit
      || !Number.isInteger(value.width) || value.width < 1 || value.width > 16384 || !Number.isInteger(value.height) || value.height < 1 || value.height > 16384
      || !identity(workspace) || value.url !== '/api/workspaces/' + encodeURIComponent(workspace) + '/assets/' + encodeURIComponent(value.assetId) + '/raw') throw new Error('素材回执不完整或不属于当前品牌，请重新确认。');
    return {id:value.id, assetId:value.assetId, assetSha256:value.assetSha256, kind:'image', mimeType:value.mimeType, fileName:value.fileName, sizeBytes:value.sizeBytes, width:value.width, height:value.height, url:value.url};
  }
  function taskReceipt(value, item, projectId) {
    if (!value || !identity(value.taskId) || value.projectId !== projectId || value.mutationId !== item.id
      || (item.taskId && item.taskId !== value.taskId) || !['PENDING','RUNNING','SUCCEEDED','FAILED'].includes(value.status)
      || !Number.isInteger(value.progress) || value.progress < 0 || value.progress > 100 || !Number.isFinite(Date.parse(value.expiresAt))) throw new Error('上传回执与本次项目或图片不一致，请继续确认。');
    if (value.status === 'SUCCEEDED') return {...value, material:materialReceipt(value.material)};
    if (value.material) throw new Error('素材尚未确认保存，不能放入画布。');
    return value;
  }
  function current(entry) { return host.current(entry) && !host.project(entry.id)?.archivedAt; }
  function controls() {
    const frozen = busy || Boolean(submitted);
    $('hs-pick').disabled = frozen || !loaded || recoveryBlocked || items.length >= 4;
    $('ns-home-brief').readOnly = frozen;
    $('ns-create-blank').disabled = frozen || recoveryBlocked || host.legacyBlocked();
    $('ns-create').disabled = busy || !loaded || recoveryBlocked || host.legacyBlocked() || (!submitted && items.some(item => !validFile(item.file)));
    $('ns-create').querySelector('span').textContent = busy ? '正在创建…' : submitted ? '继续这个项目' : items.length ? '带图开始' : '创建项目';
  }
  function render() {
    const list = $('hs-attachments'); list.hidden = !items.length; list.replaceChildren();
    for (const item of items) {
      const card = node('div','hs-attachment'); card.dataset.id = item.id; card.dataset.state = item.error ? 'error' : item.saved ? 'ready' : 'queued';
      const image = node('img'); image.alt = item.name; if (item.url) image.src = item.url;
      const body = node('div','hs-file-info'); body.append(node('strong','',item.name),node('span','hs-file-state',item.error || (item.saved ? '画布已保存' : item.material ? '素材已保存' : item.taskId ? '处理中，等待确认' : '原图已暂存')));
      const remove = button('×','hs-remove',() => { if (busy || submitted) return; items = items.filter(value => value !== item); if (item.url) URL.revokeObjectURL(item.url); void persist().catch(() => {}); render(); });
      remove.setAttribute('aria-label','移除 ' + item.name); remove.disabled = busy || Boolean(submitted); card.append(image,body,remove); list.append(card);
    }
    $('hs-draft-note').textContent = draftError;
    const recovery = $('hs-recovery'); recovery.hidden = !submitted; recovery.replaceChildren();
    if (submitted) recovery.append(node('span','','项目和原图恢复记录仍保留。继续会使用同一项目，不会自动生成图片。'),button('继续这个项目','ns-text-button',create));
    controls();
  }
  async function addFiles(files) {
    if (busy || submitted || !loaded || recoveryBlocked) return;
    for (const file of files) {
      if (items.length >= 4) { notify('每次最多带 4 张图片。'); break; }
      if (!validFile(file)) { notify('请选择 10 MB 以内的 PNG、JPG 或 WebP 图片。'); continue; }
      items.push({id:crypto.randomUUID(),file,name:(file.name || 'image.png').slice(0,255),taskId:null,taskStatus:null,material:null,saved:false,url:URL.createObjectURL(file),error:''});
    }
    render(); await persist().catch(() => {});
  }
  async function create() {
    if (busy || !loaded || recoveryBlocked || host.legacyBlocked() || host.composing()) return;
    const brief = $('ns-home-brief').value;
    if (!submitted && (!items.length || Array.from(brief).length > 6000 || items.some(item => !validFile(item.file)))) return;
    busy = true; render(); const origin = location.hash;
    try {
      if (!submitted) submitted = {requestId:crypto.randomUUID(),brief,projectName:Array.from(brief.trim().split('\n')[0] || '图片创作').slice(0,32).join(''),projectId:null};
      // Persist both creation identity and every upload identity before writes.
      await persist(); $('ns-create-status').textContent = '正在创建项目并保存需求…';
      if (!submitted.projectId) {
        const response = await api('/compare/api/create',{requestId:submitted.requestId,projectName:submitted.projectName,brief:submitted.brief});
        if (!identity(response?.projectId)) throw new Error('创建回执未确认，请继续同一请求。');
        submitted.projectId = response.projectId; await persist();
      }
      await host.reloadProjects();
      if (!host.project(submitted.projectId)) throw new Error('项目已创建，项目库还未同步，请稍后继续。');
      $('ns-create-status').textContent = '项目已创建，打开画布后继续保存图片。';
      if (location.hash === origin) host.openProject(submitted.projectId);
      else notify('项目已保留在项目库，打开后继续处理图片。');
    } catch (error) { $('ns-create-status').textContent = (typeof error?.message === 'string' ? error.message.slice(0,240) : '创建尚未确认，请继续。') + ' 需求和原图仍保留。'; }
    finally { busy = false; render(); }
  }
  function hide() {
    $('hs-handoff').hidden = true; $('ns-frames').classList.remove('hs-transferring');
    document.querySelectorAll('#ns-frames iframe').forEach(frame => { frame.inert = false; });
  }
  function paint(entry, state) {
    states.set(entry.id,state); if (!current(entry)) return;
    const box = $('hs-handoff'); box.hidden = false; box.dataset.state = state.kind;
    box.replaceChildren(node('span','hs-handoff-mark',state.kind === 'error' ? '!' : '↗'),node('strong','',state.title),node('p','',state.detail));
    if (state.kind === 'error') {
      const actions = node('div','hs-handoff-actions');
      actions.append(button(state.failedId ? '重新上传失败图片' : '继续确认','ns-primary',async () => {
        if (state.failedId) {
          const item = items.find(value => value.id === state.failedId);
          if (item?.taskStatus === 'FAILED' && !item.material && !item.saved) {
            item.id = crypto.randomUUID(); item.taskId = null; item.taskStatus = null; item.error = '';
            try { await persist(); } catch { return; }
          }
        }
        void resume(entry,true);
      }));
      actions.append(button('返回项目库','ns-text-button',() => host.goProjects())); box.append(actions);
    }
    $('ns-frames').classList.add('hs-transferring'); entry.frame.inert = true;
  }
  function remaining(deadline) { const value = deadline - Date.now(); if (value <= 0) throw new Error('本次等待已结束。已受理的任务仍可能继续，请稍后继续确认，原图仍保留。'); return value; }
  async function request(path, init, deadline) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.min(20000,remaining(deadline)));
    try {
      const response = await fetch(path,{...init,signal:controller.signal,credentials:'same-origin',cache:'no-store'});
      let value; try { value = await response.json(); } catch { throw new Error('素材回执暂时无法读取，继续会复用同一请求。'); }
      if (!response.ok) throw new Error(response.status === 409 ? '当前内容已变化，请重新打开项目后继续确认。' : response.status === 413 ? '图片超过大小限制，原图仍保留。' : '素材请求未完成，请继续确认。');
      return value;
    } catch (error) { if (controller.signal.aborted || error instanceof TypeError) throw new Error('请求结果未确认，继续会复用同一个请求，不会重复创建。'); throw error; }
    finally { clearTimeout(timer); }
  }
  async function uploadItem(entry, item, deadline) {
    if (item.material) { item.material = materialReceipt(item.material); return; }
    if (!current(entry)) throw new Error('页面已切换，打开项目后可继续。');
    let task;
    const endpoint = '/studio/material-upload?projectId=' + encodeURIComponent(entry.id);
    if (item.taskId) task = taskReceipt(await request(endpoint + '&taskId=' + encodeURIComponent(item.taskId),{},deadline),item,entry.id);
    else {
      if (!validFile(item.file)) throw new Error('原图暂不可读，请保留当前项目和文件。');
      const form = new FormData(); form.set('projectId',entry.id); form.set('mutationId',item.id); form.set('file',item.file,item.name);
      task = taskReceipt(await request(endpoint,{method:'POST',body:form},deadline),item,entry.id);
    }
    item.taskId = task.taskId; item.taskStatus = task.status; await persist();
    while (task.status === 'PENDING' || task.status === 'RUNNING') {
      if (!current(entry)) throw new Error('页面已切换，已受理的任务会继续处理。');
      if (Date.parse(task.expiresAt) <= Date.now()) throw new Error('任务处理时间已到，请到任务面板确认结果，原图仍保留。');
      paint(entry,{kind:'loading',title:'正在保存图片素材',detail:'已受理 '+(items.indexOf(item)+1)+' / '+items.length+' 张，正在等待处理结果。'});
      await new Promise(resolve => setTimeout(resolve,Math.min(1500,remaining(deadline))));
      task = taskReceipt(await request(endpoint + '&taskId=' + encodeURIComponent(item.taskId),{},deadline),item,entry.id);
      item.taskStatus = task.status;
    }
    if (task.status === 'FAILED') { await persist(); const error = new Error('这张图片的处理已失败。原图仍保留，可以重新提交这张图片。'); error.failedId = item.id; throw error; }
    item.material = task.material; item.error = ''; await persist(); render();
  }
  function waitForSaved(entry, item, deadline) {
    return new Promise((resolve,reject) => {
      const timeout = remaining(deadline);
      const timer = setTimeout(() => { waiters.delete(item.id); reject(new Error('画布保存还未确认。原图和素材已保留，继续确认不会重复插入。')); },timeout);
      waiters.set(item.id,{entry,resolve,reject,timer});
      try { entry.frame.contentWindow.postMessage({type:'nv-studio',action:'insert-material',projectId:entry.id,requestId:item.id,material:materialReceipt(item.material)},location.origin); }
      catch { clearTimeout(timer); waiters.delete(item.id); reject(new Error('画布尚未接收图片，请重新打开项目后继续。')); }
    });
  }
  function receive(event) {
    const data = event.data;
    if (event.origin !== location.origin || !data || data.type !== 'nv-studio' || data.action !== 'insert-material-result' || !uuid(data.requestId)) return;
    const waiter = waiters.get(data.requestId);
    if (!waiter || event.source !== waiter.entry.frame.contentWindow || data.projectId !== waiter.entry.id) return;
    if (data.status !== 'saved' && data.status !== 'failed') return;
    if (data.status === 'saved' && (!Number.isInteger(data.revision) || data.revision < 1)) return;
    clearTimeout(waiter.timer); waiters.delete(data.requestId);
    if (data.status === 'saved') waiter.resolve();
    else waiter.reject(new Error(typeof data.error === 'string' ? data.error.slice(0,240) : '画布保存尚未确认，请继续确认。'));
  }
  async function run(entry) {
    const deadline = Date.now() + budgetMs;
    try {
      await saveQueue;
      // A sibling tab may have finished this same recovery job while this page
      // waited for the import lock. Read its receipt before sending anything.
      const stored = await dbTask('readonly');
      if (!stored?.submitted) {
        const siblingFinished = states.get(entry.id)?.sibling;
        items.forEach(item => { if (item.url) URL.revokeObjectURL(item.url); }); items = []; submitted = null; states.delete(entry.id);
        if (current(entry)) {
          hide();
          // Only this lock-blocked, inert frame is known not to contain edits.
          // Reload its saved document after the sibling completed the handoff.
          if (siblingFinished) host.refreshImportedFrame(entry);
        }
        render(); return;
      }
      if (stored.submitted.requestId !== submitted?.requestId || stored.submitted.projectId !== entry.id) throw new Error('恢复记录已变化，请返回首页确认当前项目。');
      for (const item of items) {
        const receipt = stored.items?.find(value => value.id === item.id);
        if (!receipt || receipt.taskId && !identity(receipt.taskId)) throw new Error('图片恢复记录已变化，请返回首页确认。');
        item.saved = false; item.material = null; item.taskStatus = null; item.taskId = receipt.taskId || item.taskId;
      }
      for (const item of items) {
        remaining(deadline); if (!current(entry)) throw new Error('页面已切换，打开项目后可继续。');
        if (item.saved) continue;
        paint(entry,{kind:'loading',title:'正在保存图片素材',detail:'原始需求已保留。正在处理 '+(items.indexOf(item)+1)+' / '+items.length+' 张图片。'});
        await uploadItem(entry,item,deadline);
        if (!current(entry) || !entry.ready) throw new Error('画布暂时不可用，素材和原图仍保留。');
        paint(entry,{kind:'loading',title:'正在确认画布保存',detail:'素材已保存，等待画布确认第 '+(items.indexOf(item)+1)+' 张图片。'});
        await waitForSaved(entry,item,deadline); item.saved = true; await persist(); render();
      }
      const completed = items, previous = submitted;
      items = []; submitted = null;
      try { await persist(); } catch (error) { items = completed; submitted = previous; throw error; }
      completed.forEach(item => { if (item.url) URL.revokeObjectURL(item.url); });
      if ($('ns-home-brief').value === previous.brief) { $('ns-home-brief').value = ''; try { localStorage.removeItem('novart-m24-home-brief'); } catch {} }
      states.delete(entry.id); host.invalidateAssets(entry.id); render();
      if (current(entry)) { hide(); notify('图片和需求已保存，可以继续编辑。'); host.showRequirements(entry); }
    } catch (error) {
      paint(entry,{kind:'error',title:'图片交接尚未完成',detail:(typeof error?.message === 'string' ? error.message.slice(0,300) : '请稍后继续确认。') + ' 原图仍保留。',failedId:error.failedId});
    }
  }
  async function resume(entry, retry=false) {
    latestEntry = entry;
    if (!loaded || recoveryBlocked || !entry?.ready || !current(entry) || submitted?.projectId !== entry.id) return;
    if (states.get(entry.id)?.kind === 'error' && !retry) { paint(entry,states.get(entry.id)); return; }
    if (runs.has(entry.id)) return;
    const task = (async () => {
      if (navigator.locks) await navigator.locks.request('novart-owned-home-' + entry.id,{ifAvailable:true},async lock => {
        if (lock) await run(entry);
        else paint(entry,{kind:'error',sibling:true,title:'另一页面正在处理图片',detail:'请等另一页面处理结束后继续确认，原图仍保留。'});
      });
      else await run(entry);
    })();
    runs.set(entry.id,task);
    try { await task; } finally { runs.delete(entry.id); }
  }
  function canvasUnavailable(entry) {
    if (submitted?.projectId !== entry.id) return;
    for (const [id,waiter] of waiters) if (waiter.entry === entry) { clearTimeout(waiter.timer); waiters.delete(id); waiter.reject(new Error('画布暂时不可用，原图和已保存素材仍保留。')); }
    paint(entry,{kind:'error',title:'画布暂时不可用',detail:'图片交接已停止。原始需求、原图和已保存素材仍保留。'});
  }
  $('hs-file-input').addEventListener('change',event => { void addFiles([...event.target.files]); event.target.value = ''; });
  $('hs-pick').addEventListener('click',() => $('hs-file-input').click());
  const composer = $('ns-composer');
  composer.addEventListener('dragover',event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); composer.classList.add('hs-drag'); } });
  composer.addEventListener('dragleave',event => { if (!composer.contains(event.relatedTarget)) composer.classList.remove('hs-drag'); });
  composer.addEventListener('drop',event => { if (event.dataTransfer.files.length) { event.preventDefault(); composer.classList.remove('hs-drag'); void addFiles([...event.dataTransfer.files]); } });
  composer.addEventListener('paste',event => { const files = [...event.clipboardData.files]; if (files.length) { event.preventDefault(); void addFiles(files); } });
  window.addEventListener('message',receive);
  window.addEventListener('pagehide',() => { window.removeEventListener('message',receive); for (const waiter of waiters.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('页面已关闭，原图恢复记录仍保留。')); } waiters.clear(); },{once:true});
  dbTask('readonly').then(value => {
    if (!value) return;
    if (value.version !== 1 || !Array.isArray(value.items) || value.items.length > 4 || new Set(value.items.map(item => item.id)).size !== value.items.length
      || value.items.some(item => !uuid(item.id) || typeof item.name !== 'string' || !validFile(item.file) || item.taskId && !identity(item.taskId))) throw new Error('恢复记录无法读取');
    if (value.submitted && (!uuid(value.submitted.requestId) || typeof value.submitted.brief !== 'string' || typeof value.submitted.projectName !== 'string'
      || value.submitted.projectId !== null && !identity(value.submitted.projectId))) throw new Error('恢复记录无法读取');
    items = value.items.map(item => ({id:item.id,file:item.file,name:item.name,taskId:item.taskId || null,taskStatus:null,material:null,saved:false,url:URL.createObjectURL(item.file),error:''})); submitted = value.submitted || null;
    if (submitted) $('ns-home-brief').value = submitted.brief;
  }).catch(() => { recoveryBlocked = true; draftError = '原图恢复记录暂不可用，请保留本页和原文件，检查存储空间后刷新。'; })
    .finally(() => { loaded = true; render(); if (latestEntry) void resume(latestEntry); });
  render();
  return {create,hasDraft:() => Boolean(items.length || submitted),resume,canvasUnavailable,routeChanged() { hide(); },busy:() => busy,
    snapshot:() => ({loaded,busy,attachmentCount:items.length,readyCount:items.filter(item=>item.material).length,submittedRequestId:submitted?.requestId || null,running:[...runs.keys()]})};
};
