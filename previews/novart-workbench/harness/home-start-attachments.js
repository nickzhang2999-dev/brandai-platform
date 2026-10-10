/* H-03: persistent homepage attachments; handoff through the original file picker. */
window.createHomeStart = function createHomeStart(host) {
  'use strict';
  const $ = id => document.getElementById(id), {api, node, button, notify} = host;
  const key = 'novart-home-start-v1', limit = 10 * 1024 * 1024;
  let items = [], submitted = null, busy = false, loaded = false, draftError = '', saveQueue = Promise.resolve();
  const runs = new Map(), states = new Map(), seenFrames = new WeakSet();
  const dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open('novart-home-start', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('draft');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  async function dbTask(mode, value) {
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('draft', mode), store = tx.objectStore('draft');
      const req = mode === 'readonly' ? store.get(key) : store.put(value, key);
      tx.oncomplete = () => resolve(req.result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
  }
  function persist() {
    const value = {items: items.map(({id,file,name,asset,error}) => ({id,file,name,asset,error})), submitted};
    saveQueue = saveQueue.catch(() => {}).then(() => dbTask('readwrite', value));
    return saveQueue.catch(error => { draftError = '浏览器暂存失败。请保留本页，图片上传后仍可继续。'; render(); throw error; });
  }
  const imageURL = asset => '/studio/start/image/' + asset.sha256;
  function controls() {
    const frozen = busy || Boolean(submitted);
    $('hs-pick').disabled = frozen || !loaded || items.length >= 4;
    $('ns-home-brief').readOnly = frozen;
    $('ns-create-blank').disabled = frozen || host.legacyBlocked();
    $('ns-create').disabled = busy || !loaded || host.legacyBlocked() || items.some(i => i.status === 'uploading') || (!submitted && items.some(i => !i.asset));
    if (items.length || submitted || busy) $('ns-create').querySelector('span').textContent = busy ? '正在创建…' : submitted ? '继续创建的项目' : '带图开始';
    else $('ns-create').querySelector('span').textContent = '创建项目';
  }
  function render() {
    const list = $('hs-attachments'); list.hidden = !items.length; list.replaceChildren();
    for (const item of items) {
      const card = node('div','hs-attachment'); card.dataset.id = item.id; card.dataset.state = item.status || (item.asset ? 'ready' : 'error');
      const image = node('img'); image.alt = item.name; image.src = item.url || (item.asset ? imageURL(item.asset) : '');
      const body = node('div','hs-file-info'); body.append(node('strong','',item.name));
      body.append(node('span','hs-file-state',item.status === 'uploading' ? '正在上传…' : item.asset ? '已就绪' : item.error || '上传未完成'));
      if (!item.asset && item.status !== 'uploading') { const retry = button('重试','hs-retry',() => stage(item)); retry.disabled = busy || Boolean(submitted); body.append(retry); }
      const remove = button('×','hs-remove',() => { items = items.filter(i => i !== item); if (item.url) URL.revokeObjectURL(item.url); persist().catch(() => {}); render(); });
      remove.setAttribute('aria-label','移除 ' + item.name); remove.disabled = busy || Boolean(submitted);
      card.append(image,body,remove); list.append(card);
    }
    $('hs-draft-note').textContent = draftError;
    const recovery = $('hs-recovery'); recovery.hidden = !submitted; recovery.replaceChildren();
    if (submitted) recovery.append(node('span','','这份需求和图片已提交或正在确认。继续会回到同一个项目。'), button('继续这个项目','ns-text-button',create));
    controls();
  }
  async function stage(item) {
    if (item.status === 'uploading' || !items.includes(item)) return;
    if (!item.file) { item.error = '原文件暂不可读，请移除后重新选择'; render(); return; }
    item.status = 'uploading'; item.error = ''; render();
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch('/studio/start/upload', {method:'POST', body:item.file, headers:{'Content-Type':item.file.type, 'X-File-Name':encodeURIComponent(item.name)}, signal:controller.signal});
      const data = await response.json();
      if (!response.ok || !data.asset?.sha256) { const error = new Error('上传失败，可重试'); if ([400,413].includes(response.status)) error.userMessage = data.error; throw error; }
      if (!items.includes(item)) return;
      if (items.some(other => other !== item && other.asset?.sha256 === data.asset.sha256)) {
        items = items.filter(other => other !== item); URL.revokeObjectURL(item.url); notify('这张图片已经在需求里了。');
      } else { item.asset = data.asset; item.status = 'ready'; }
      await persist().catch(() => {});
    } catch (error) { item.status = 'error'; item.error = error.userMessage || (error.name === 'AbortError' ? '上传超时，可重试' : '上传失败，可重试'); await persist().catch(() => {}); }
    finally { clearTimeout(timer); render(); }
  }
  async function addFiles(files) {
    if (busy || submitted || !loaded) return;
    const added = [];
    for (const file of files) {
      if (items.length >= 4) { notify('每次最多带 4 张图片。'); break; }
      if (!['image/png','image/jpeg','image/webp'].includes(file.type) || !file.size || file.size > limit) { notify('请选择 10 MB 以内的 PNG、JPG 或 WebP 图片。'); continue; }
      const item = {id:crypto.randomUUID(), file, name:file.name, asset:null, error:'', status:'queued', url:URL.createObjectURL(file)};
      items.push(item); added.push(item);
    }
    render(); await persist().catch(() => {});
    await Promise.all(added.map(stage));
  }
  async function create() {
    if (busy || !loaded || host.legacyBlocked() || host.composing()) return;
    const brief = $('ns-home-brief').value;
    if (!submitted && (Array.from(brief).length > 6000 || !items.length || items.some(i => !i.asset))) return;
    busy = true; render(); $('ns-create-status').textContent = '正在保存需求和图片…';
    const origin = location.hash;
    try {
      if (!submitted) {
        submitted = {requestId:crypto.randomUUID(), brief, assets:items.map(i => i.asset.sha256)};
        // Write identity before the first request; even a lost response reuses this ID.
        try { await persist(); } catch (_) { submitted = null; throw new Error('暂存空间不足，尚未创建项目。请保留本页，释放空间后重试。'); }
      }
      const job = await api('/studio/start/create', submitted);
      if (job.creationStatus !== 'ready' || !job.projectId) throw new Error('项目准备尚未完成，请继续重试。');
      await host.reloadProjects();
      if (!host.project(job.projectId)) throw new Error('项目已经保留，列表暂未读到，请继续这个项目。');
      const previous = submitted;
      submitted = null; items.forEach(i => { if (i.url) URL.revokeObjectURL(i.url); }); items = [];
      if ($('ns-home-brief').value === previous.brief) { $('ns-home-brief').value = ''; localStorage.removeItem('novart-m24-home-brief'); }
      await persist().catch(() => {});
      $('ns-create-status').textContent = '项目与原始需求已保存';
      if (location.hash === origin) host.openProject(job.projectId);
      else notify('项目已放入项目库，打开后图片会继续加入画布。');
    } catch (error) { $('ns-create-status').textContent = error.message + ' 需求和图片仍保留。'; }
    finally { busy = false; render(); }
  }
  function readNative(entry) {
    const {win,doc} = host.frameDocument(entry) || {}; if (!win) return null;
    if (doc.querySelector('.tl-error-boundary')
      || ['bootstrap', 'canvas-crash'].includes(doc.documentElement.dataset.novartNativeFailure)) {
      const error = new Error('画布打开失败，图片尚未导入。原始需求和图片仍保留，请重新打开或返回项目库。');
      error.nativeStartup = true;
      throw error;
    }
    // Shell readiness precedes lazy native chunks in ordinary browsers. Never
    // require an unregistered module: webpack would cache its failed creation.
    if (!doc.querySelector('[data-testid="canvas"]') || !doc.querySelector('[data-testid="upload-menu-trigger"]')) return null;
    let app;
    win.webpackChunk_lovartai_lovart_shell.push([['home-start-read-' + crypto.randomUUID()],{},require => {
      if (typeof require.m?.[37750] === 'function') app = require(37750).pW;
    }]);
    return app?.getEditor()?.getCurrentPageShapes() || null;
  }
  const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
  async function waitNative(entry) {
    for (let count=0;count<200;count++) {
      if (!current(entry)) return null;
      const shapes = readNative(entry); if (shapes) return shapes;
      await delay(100);
    }
    throw new Error('画布工具尚未加载完成，请重新打开后继续。');
  }
  function current(entry) { return host.current(entry) && !host.project(entry.id)?.archivedAt; }
  function paint(entry, state) {
    states.set(entry.id,state); if (!current(entry)) return;
    const box = $('hs-handoff'); box.hidden = false; box.dataset.state = state.kind;
    box.replaceChildren(node('span','hs-handoff-mark',state.kind === 'error' ? '!' : '↗'),node('strong','',state.title),node('p','',state.detail));
    if (state.kind === 'error') {
      const actions = node('div','hs-handoff-actions');
      actions.append(button(state.checkOnly ? '重新确认保存' : '重新打开并继续','ns-primary',() => state.checkOnly ? resume(entry,true) : location.reload()));
      actions.append(button('返回项目库','ns-text-button',() => host.goProjects())); box.append(actions);
    }
    $('ns-frames').classList.add('hs-transferring'); entry.frame.inert = true;
  }
  function hide() { $('hs-handoff').hidden = true; $('ns-frames').classList.remove('hs-transferring'); document.querySelectorAll('#ns-frames iframe').forEach(frame => { frame.inert = false; }); }
  function transfer(entry, files) {
    const {win,doc} = host.frameDocument(entry);
    return new Promise((resolve,reject) => {
      let timer, captured = false, settled = false;
      const old = new Set(doc.querySelectorAll('input[type=file]'));
      function finish(error) { if (settled) return; settled = true; clearTimeout(timer); doc.removeEventListener('click',capture,true); error ? reject(error) : resolve(); }
      function capture(event) {
        const input = event.target;
        if (settled || !(input instanceof win.HTMLInputElement) || input.type !== 'file' || old.has(input) || captured) return;
        event.preventDefault(); captured = true;
        try {
          if (!current(entry)) throw new Error('页面已切换，稍后打开项目会继续。');
          const transfer = new win.DataTransfer(); files.forEach(file => transfer.items.add(new win.File([file.blob],file.name,{type:file.blob.type})));
          // Recreate files in the editor's window, then forward the selection
          // after the native picker click has returned.
          win.setTimeout(() => {
            if (settled) return;
            try { if (!current(entry)) throw new Error('页面已切换。'); input.files = transfer.files; input.dispatchEvent(new win.Event('change',{bubbles:true})); finish(); }
            catch (error) { finish(error); }
          },0);
        } catch (error) { finish(error); }
      }
      doc.addEventListener('click',capture,true);
      timer = setTimeout(() => finish(new Error('图片入口还没有准备好。')),8000);
      const trigger = doc.querySelector('[data-testid="upload-menu-trigger"]');
      if (!trigger) { finish(new Error('图片工具尚未准备好。')); return; }
      trigger.dispatchEvent(new win.PointerEvent('pointerover',{bubbles:true,pointerType:'mouse',isPrimary:true,relatedTarget:null}));
      (async () => {
        for (let count=0;count<60;count++) {
          if (settled) return;
          if (!current(entry)) { finish(new Error('页面已切换。')); return; }
          const control = doc.querySelector('[data-testid="upload-menu-uploadImage"]');
          if (control) { control.click(); return; }
          await delay(80);
        }
      })().catch(finish);
    });
  }
  async function run(entry) {
    let confirmationOnly = false, nativeStarted = false;
    try {
      let job;
      try { job = await api('/studio/start/job?projectId=' + encodeURIComponent(entry.id)); }
      catch (error) { if (error.status === 404) { states.delete(entry.id); if(current(entry)) hide(); return; } throw error; }
      if (!current(entry) || job.archived) return;
      if (job.creationStatus !== 'ready') throw new Error('这个项目还在准备，请返回首页继续创建。');
      if (job.status === 'complete') {
        confirmationOnly = true;
        if (job.confirmedAssets.length !== job.assets.length) await api('/studio/start/confirm',{projectId:entry.id});
        states.delete(entry.id); if(current(entry)) hide(); return;
      }
      paint(entry,{kind:'loading',title:'把图片放进画布',detail:'原始需求已经保存，正在准备 '+job.assets.length+' 张图片。'});
      const shapes = await waitNative(entry);
      if (!shapes || !current(entry)) return;
      const missing = job.assets.filter(a => !job.completedAssets.includes(a.sha256) && !shapes.some(s => s.type === 'c-image' && s.props?.name === a.uploadName.replace(/\.[^.]+$/,'')));
      const files = [];
      for (const asset of missing) {
        const response = await fetch(imageURL(asset)); if (!response.ok) throw new Error('图片暂时无法读取。');
        files.push({blob:await response.blob(),name:asset.uploadName});
      }
      if (!current(entry)) return;
      if (files.length) { nativeStarted = true; await transfer(entry,files); }
      for (let count=0;count<40;count++) {
        await delay(1000);
        job = await api('/studio/start/job?projectId='+encodeURIComponent(entry.id));
        if (job.archived) throw new Error('项目已归档，恢复后会继续。');
        if (job.completedAssets.length) {
          confirmationOnly = job.status === 'complete';
          job = await api('/studio/start/confirm',{projectId:entry.id});
          confirmationOnly = false;
        }
        if (job.status === 'complete') {
          states.delete(entry.id); host.invalidateAssets(entry.id);
          if (current(entry)) { hide(); notify('图片已加入画布，原始需求也已保留。'); host.showRequirements(entry); }
          return;
        }
        paint(entry,{kind:'loading',title:'把图片放进画布',detail:'已保存 '+job.completedAssets.length+' / '+job.assets.length+' 张。完成后即可编辑。'});
      }
      throw new Error('部分图片的保存尚未确认。已保存的图片会保留。');
    } catch (error) {
      paint(entry,{kind:'error',title:error.nativeStartup ? '画布暂时无法打开' : confirmationOnly ? '图片已保存，正在确认交接' : '图片还没全部加入画布',detail:error.message,checkOnly:confirmationOnly});
      // A native upload can keep retrying after our UI timeout. Keep the shared
      // import lock until the owning page is unloaded; retry replaces that page.
      if (nativeStarted && !confirmationOnly) await new Promise(resolve => window.addEventListener('pagehide',resolve,{once:true}));
    }
  }
  async function resume(entry, retry=false) {
    if (!entry?.ready || !current(entry)) return;
    if (states.has(entry.id)) { const state = states.get(entry.id); paint(entry,state); if (state.kind === 'error' && !retry) return; }
    if (runs.has(entry.id)) return;
    const fresh = !seenFrames.has(entry); seenFrames.add(entry);
    if (entry.id.startsWith('home-')) paint(entry,{kind:'loading',title:'正在确认图片',detail:'如果另一标签正在导入，完成后这里会自动继续。'});
    const task = (async () => {
      // Same-origin tabs serialize import, then re-read durable receipts.
      if (navigator.locks) {
        const name = 'novart-home-import-'+entry.id;
        await navigator.locks.request(name,{ifAvailable:true},async lock => {
          if (lock) { if(current(entry)) await run(entry); return; }
          await navigator.locks.request(name,async () => {
            if (!current(entry)) return;
            // A freshly opened, blocked editor may have loaded the old empty
            // document while its sibling imported. Re-read only that untouched
            // frame; cached editing sessions are never discarded here.
            if (fresh) { states.delete(entry.id); hide(); host.refreshImportedFrame(entry); }
            else await run(entry);
          });
        });
      }
      else await run(entry);
    })();
    runs.set(entry.id,task);
    try { await task; } finally { runs.delete(entry.id); }
  }
  $('hs-file-input').addEventListener('change',event => { addFiles([...event.target.files]); event.target.value = ''; });
  $('hs-pick').addEventListener('click',() => $('hs-file-input').click());
  const composer = $('ns-composer');
  composer.addEventListener('dragover',event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); composer.classList.add('hs-drag'); } });
  composer.addEventListener('dragleave',event => { if (!composer.contains(event.relatedTarget)) composer.classList.remove('hs-drag'); });
  composer.addEventListener('drop',event => { if (event.dataTransfer.files.length) { event.preventDefault(); composer.classList.remove('hs-drag'); addFiles([...event.dataTransfer.files]); } });
  composer.addEventListener('paste',event => { const files = [...event.clipboardData.files]; if (files.length) { event.preventDefault(); addFiles(files); } });
  dbTask('readonly').then(value => {
    if (value && Array.isArray(value.items)) {
      items = value.items.slice(0,4).map(i => ({...i,status:i.asset?'ready':'error',url:i.file?URL.createObjectURL(i.file):null}));
      submitted = value.submitted || null;
      if (submitted) $('ns-home-brief').value = submitted.brief;
    }
  }).catch(() => { draftError = '浏览器暂存不可用。请保留本页；带图创建前需要恢复暂存空间。'; }).finally(() => { loaded = true; render(); });
  render();
  return {create,hasDraft:() => Boolean(items.length || submitted),resume,routeChanged() { hide(); },
    busy:() => busy, snapshot:() => ({loaded,busy,attachmentCount:items.length,readyCount:items.filter(i=>i.asset).length,submittedRequestId:submitted?.requestId||null,running:[...runs.keys()]})};
};
