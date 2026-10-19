/* Product homepage handoff. Inputs stay recoverable until the owned editor
   confirms document saves and the explicitly requested conversation receipt.
   This shell never calls a provider or generates a second request identity. */
window.createHomeStart = function createHomeStart(host) {
  'use strict';
  const $ = id => document.getElementById(id), {api, node, button, notify} = host;
  const legacyKey = 'owned-home-start-v1', limit = 10 * 1024 * 1024, budgetMs = 120000;
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  const identity = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
  // Switching brand reloads the page, so the brand is fixed for this module.
  const homeWorkspace = window.__NOVART_PRODUCT__?.workspaceId;
  const key = identity(homeWorkspace) ? legacyKey + ':' + homeWorkspace : legacyKey;
  const types = ['image/png','image/jpeg','image/webp'];
  let items = [], submitted = null, busy = false, loaded = false, draftError = '', latestEntry = null, recoveryBlocked = false;
  let checkingRecovery = false;
  let saveQueue = Promise.resolve(), recoveryWrites = 0, recoveryRevision = 0, recoverySavedRevision = 0;
  const runs = new Map(), states = new Map(), waiters = new Map();
  const dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open('novart-owned-home-start', 1);
    const timer = setTimeout(() => reject(new Error('恢复空间打开超时')),8000);
    request.onupgradeneeded = () => request.result.createObjectStore('draft');
    request.onsuccess = () => { clearTimeout(timer); resolve(request.result); };
    request.onerror = request.onblocked = () => { clearTimeout(timer); reject(new Error('恢复空间暂不可用')); };
  });
  async function dbTask(mode, value, target = key) {
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('draft', mode), store = transaction.objectStore('draft');
      const request = mode === 'readonly' ? store.get(target) : value === undefined ? store.delete(target) : store.put(value, target);
      const timer = setTimeout(() => { try { transaction.abort(); } catch {} reject(new Error('恢复记录保存超时')); },8000);
      transaction.oncomplete = () => { clearTimeout(timer); resolve(request.result); };
      transaction.onerror = transaction.onabort = () => { clearTimeout(timer); reject(new Error('恢复记录未能保存')); };
    });
  }
  function persist() {
    // Cache only recoverable input and stable identities. Material readiness
    // and saved status are rechecked with the backend/editor on every resume.
    const value = {version:1, items:items.map(({id,file,name,taskId,uploadStarted}) => ({id,file,name,taskId,uploadStarted})), submitted:submitted ? {...submitted} : null};
    const revision = ++recoveryRevision; recoveryWrites++;
    saveQueue = saveQueue.catch(() => {}).then(() => dbTask('readwrite', value)).finally(() => { recoveryWrites--; });
    return saveQueue.then(() => { recoverySavedRevision = revision; draftError = ''; render(); }, () => { draftError = '恢复记录未能保存。请保留本页和原图，恢复存储空间后继续。'; render(); throw new Error(draftError); });
  }
  async function confirmLeave() {
    if (!loaded || recoveryBlocked) throw new Error('首页原图尚未确认恢复，请保留当前页面，检查恢复空间后再切换品牌。');
    if (busy || checkingRecovery || runs.size) throw new Error('首页图片正在处理，请完成后再切换品牌。');
    if (!items.length && !submitted && !recoveryWrites && !draftError) return;
    // A visible thumbnail is not a persistence receipt. Retry the current value
    // and wait for the actual IndexedDB transaction before leaving this brand.
    let timer;
    try {
      await Promise.race([persist(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('首页原图暂存尚未确认，请保留本页并稍后重试切换品牌。')), 10000); })]);
      if (busy || runs.size || recoveryWrites || recoverySavedRevision !== recoveryRevision || draftError) throw new Error('首页原图仍有未确认保存的变化，请保留本页并重试。');
    } finally { clearTimeout(timer); }
  }
  function validFile(file) { return file instanceof Blob && types.includes(file.type) && file.size > 0 && file.size <= limit; }
  function materialReceipt(value) {
    const workspace = window.__NOVART_PRODUCT__?.workspaceId;
    if (!value || !identity(value.id) || !identity(value.assetId) || !/^[a-f0-9]{64}$/.test(value.assetSha256)
      || value.kind !== 'image' || !types.includes(value.mimeType) || typeof value.fileName !== 'string' || !value.fileName.length || value.fileName.length > 255
      || !Number.isInteger(value.sizeBytes) || value.sizeBytes < 1 || value.sizeBytes > limit
      || !Number.isInteger(value.width) || value.width < 1 || value.width > 16384 || !Number.isInteger(value.height) || value.height < 1 || value.height > 16384
      || !identity(workspace) || value.url !== '/api/workspaces/' + encodeURIComponent(workspace) + '/assets/' + encodeURIComponent(value.assetId) + '/raw') throw new Error('素材信息不完整或不属于当前品牌，请重新确认。');
    return {id:value.id, assetId:value.assetId, assetSha256:value.assetSha256, kind:'image', mimeType:value.mimeType, fileName:value.fileName, sizeBytes:value.sizeBytes, width:value.width, height:value.height, url:value.url};
  }
  function taskReceipt(value, item, projectId) {
    if (!value || !identity(value.taskId) || value.projectId !== projectId || value.mutationId !== item.id
      || (item.taskId && item.taskId !== value.taskId) || !['PENDING','RUNNING','SUCCEEDED','FAILED'].includes(value.status)
      || !Number.isInteger(value.progress) || value.progress < 0 || value.progress > 100 || !Number.isFinite(Date.parse(value.expiresAt))) throw new Error('上传结果与本次项目或图片不一致，请继续确认。');
    if (value.status === 'SUCCEEDED') return {...value, material:materialReceipt(value.material)};
    if (value.material) throw new Error('素材尚未确认保存，不能放入画布。');
    return value;
  }
  function current(entry) { return host.current(entry) && !host.project(entry.id)?.archivedAt; }
  function failedItem(item) { return item.taskStatus === 'FAILED' && !item.material && !item.saved; }
  function canEndHandoff() {
    return Boolean(submitted?.projectId) && !submitted.creationAccepted && submitted.creationStarted !== true
      && (!submitted.startCreation || submitted.creationStarted === false || items.some(failedItem))
      && items.every(item => failedItem(item) || item.material || item.uploadStarted === false);
  }
  function mayRemove(item) {
    return !busy && !checkingRecovery && !runs.size && !recoveryWrites && (!submitted || failedItem(item))
      && (!submitted || submitted.creationStarted !== true && !submitted.creationAccepted);
  }
  function pendingMatches(stored) {
    return stored?.submitted?.requestId === submitted?.requestId && stored?.submitted?.projectId === submitted?.projectId
      && stored.items?.length === items.length && items.every(item => stored.items.some(other => other.id === item.id && (other.taskId || null) === (item.taskId || null)));
  }
  async function recoveryAction(action) {
    if (busy || checkingRecovery || runs.size || !loaded || recoveryBlocked) return false;
    busy = true; render(); let changed = false;
    try {
      const perform = async () => {
        await saveQueue.catch(() => {});
        if (submitted) {
          const stored = await dbTask('readonly');
          if (!pendingMatches(stored)) throw new Error('恢复记录已在另一页面变化，请刷新当前页面后检查。');
          if (stored.submitted.creationStarted === true) submitted.creationStarted = true;
          if (stored.submitted.creationAccepted === true) submitted.creationAccepted = true;
        }
        await action(); changed = true;
      };
      if (submitted?.projectId && navigator.locks) await navigator.locks.request('novart-owned-home-' + submitted.projectId,{ifAvailable:true},async lock => {
        if (!lock) throw new Error('另一页面正在处理这次交接，请稍后再检查。');
        await perform();
      });
      else await perform();
    } catch (error) { $('ns-create-status').textContent = error.message; notify(error.message); }
    finally { busy = false; render(); }
    return changed;
  }
  async function replaceRecovery(nextItems, nextSubmitted) {
    const previousItems = items, previousSubmitted = submitted;
    items = nextItems; submitted = nextSubmitted;
    try { await persist(); }
    catch (error) { items = previousItems; submitted = previousSubmitted; render(); throw error; }
  }
  function releaseHandoff(previous) {
    states.delete(previous.projectId); hide(); host.invalidateAssets(previous.projectId);
    $('ns-create-status').textContent = '本次交接已结束，已创建的项目和已保存素材仍保留；需求和原图可在首页继续编辑。';
    notify('已保留项目。本次创作不会自动提交。');
  }
  async function endHandoff() {
    if (!canEndHandoff()) return false;
    return recoveryAction(async () => {
      if (!canEndHandoff()) throw new Error('仍有任务结果未确认，请先检查上次提交。');
      const previous = submitted;
      // Explicitly ending the handoff keeps source files as editable drafts.
      // Fresh identities are only used after a new user submission; no network write here.
      const drafts = items.map(item => ({...item,id:crypto.randomUUID(),taskId:null,taskStatus:null,uploadStarted:false,material:null,saved:false,error:'',failureKind:null}));
      await replaceRecovery(drafts,null); releaseHandoff(previous);
    });
  }
  async function removeItem(item) {
    if (!mayRemove(item)) return false;
    return recoveryAction(async () => {
      const next = items.filter(value => value !== item), previous = submitted;
      if (previous && (!failedItem(item) || previous.creationStarted === true || previous.creationAccepted)) throw new Error('这张图片的提交结果尚未确认，请先检查任务。');
      // Removing the final failed attachment must not turn a reference-based
      // creation into a text-only paid request.
      const finish = Boolean(previous) && !next.length && canEndHandoff();
      await replaceRecovery(next,finish ? null : submitted);
      if (item.url) URL.revokeObjectURL(item.url);
      if (finish) releaseHandoff(previous);
      else if (previous) states.delete(previous.projectId);
    });
  }
  async function retryFailed(entry, failedId, replacementFile) {
    const item = items.find(value => value.id === failedId);
    if (!item || !failedItem(item) || item.failureKind === 'invalid' && !replacementFile) return;
    if (replacementFile && !validFile(replacementFile)) { notify('请选择 10 MB 以内的 PNG、JPG 或 WebP 图片。'); return; }
    const changed = await recoveryAction(async () => {
      if (submitted?.creationStarted || submitted?.creationAccepted) throw new Error('创作的提交结果尚未确认，请先继续确认原任务。');
      const replacement = {...item,id:crypto.randomUUID(),taskId:null,taskStatus:null,uploadStarted:false,error:'',failureKind:null,
        ...(replacementFile ? {file:replacementFile,name:(replacementFile.name || 'image.png').slice(0,255),url:URL.createObjectURL(replacementFile)} : {})};
      try { await replaceRecovery(items.map(value => value === item ? replacement : value),submitted); }
      catch (error) { if (replacementFile) URL.revokeObjectURL(replacement.url); throw error; }
      if (replacementFile && item.url) URL.revokeObjectURL(item.url);
      states.delete(entry.id);
    });
    if (changed) void resume(entry,true);
  }
  function selectReplacement(entry, failedId) {
    const input = node('input'); input.type = 'file'; input.accept = types.join(',');
    input.onchange = () => { if (input.files?.length) void retryFailed(entry,failedId,input.files[0]); }; input.click();
  }
  function uploadFailure(task) {
    // Only fixed, known server messages are translated. Do not expose arbitrary
    // exception text, URLs or storage credentials in a user-visible error.
    const reason = typeof task.error === 'string' && task.error.length <= 240 ? task.error.replace(/\s/g,'') : '';
    if (reason === '图片损坏或格式不受支持。请上传4000万像素以内的静态PNG、JPEG或WebP。') return {kind:'invalid',message:'图片损坏或格式不受支持。请换一张 4000 万像素以内的静态 PNG、JPG 或 WebP；同一文件重传可能仍会失败。'};
    if (reason === '上传内容校验失败，请重新选择图片。') return {kind:'invalid',message:'图片内容校验失败，请重新选择图片。'};
    if (['图片上传超时，请重新选择图片上传。','上传已结束或超时，请重新选择图片。'].includes(reason)) return {kind:'expired',message:'图片上传已超时，可以重新上传，或移除后继续编辑项目。'};
    if (reason === '图片存储失败，请重新选择图片上传；若持续失败请联系管理员。') return {kind:'storage',message:'图片保存失败，可以重试；持续失败请联系管理员，也可以先结束交接并编辑项目。'};
    if (['上传权限已变更，未添加图片。','权限不足'].includes(reason)) return {kind:'permission',message:'上传权限已变更，图片未添加。请确认当前品牌和项目权限。'};
    if (['项目已归档或删除，未添加图片。','项目不存在。','项目已归档，无法上传图片。'].includes(reason)) return {kind:'project',message:'项目已归档或不可用，图片未添加。请返回项目库选择其他项目。'};
    return {kind:'unknown',message:'图片处理失败，可以重新上传、移除图片，或结束交接后编辑已有项目。'};
  }
  function recordFailure(item, task) { const failure = uploadFailure(task); item.error = failure.message; item.failureKind = failure.kind; }
  async function inspectRecovery() {
    if (checkingRecovery || busy || runs.size || !submitted?.projectId || recoveryBlocked) return;
    const submission = submitted, deadline = Date.now() + 20000;
    checkingRecovery = true; render();
    try {
      for (const item of items) {
        if (!item.taskId) continue;
        const task = taskReceipt(await request('/studio/material-upload?projectId=' + encodeURIComponent(submission.projectId) + '&taskId=' + encodeURIComponent(item.taskId),{},deadline),item,submission.projectId);
        if (submitted !== submission) return;
        item.taskStatus = task.status; item.material = task.status === 'SUCCEEDED' ? task.material : null;
        if (task.status === 'FAILED') recordFailure(item,task); else { item.error = ''; item.failureKind = null; }
      }
    } catch (error) { $('ns-create-status').textContent = error.message; }
    finally { checkingRecovery = false; render(); }
  }
  function controls() {
    const frozen = busy || checkingRecovery || Boolean(submitted);
    $('hs-pick').disabled = frozen || !loaded || recoveryBlocked || items.length >= 4;
    $('ns-home-brief').readOnly = frozen;
    $('ns-create-blank').disabled = frozen || recoveryBlocked || host.legacyBlocked();
    $('ns-create').disabled = busy || checkingRecovery || !loaded || recoveryBlocked || host.legacyBlocked() || (!submitted && items.some(item => !validFile(item.file)));
    $('ns-create').querySelector('span').textContent = busy ? '正在创建…' : submitted ? '继续这个项目' : items.length && !$('ns-home-brief').value.trim() ? '放入画布' : '开始创作';
  }
  function render() {
    const list = $('hs-attachments'); list.hidden = !items.length; list.replaceChildren();
    for (const item of items) {
      const card = node('div','hs-attachment'); card.dataset.id = item.id; card.dataset.state = item.error ? 'error' : item.saved ? 'ready' : 'queued';
      const image = node('img'); image.alt = item.name; if (item.url) image.src = item.url;
      const body = node('div','hs-file-info'); body.append(node('strong','',item.name),node('span','hs-file-state',item.error || (item.saved ? '画布已保存' : item.material ? '素材已保存' : checkingRecovery ? '正在检查上次上传…' : ['PENDING','RUNNING'].includes(item.taskStatus) ? '正在处理图片' : item.taskId || item.uploadStarted ? '提交结果待确认' : '原图已暂存')));
      const remove = button('×','hs-remove',() => { void removeItem(item); });
      remove.setAttribute('aria-label','移除 ' + item.name); remove.disabled = !mayRemove(item); card.append(image,body,remove); list.append(card);
    }
    $('hs-draft-note').textContent = draftError;
    const recovery = $('hs-recovery'); recovery.hidden = !submitted; recovery.replaceChildren();
    if (submitted) recovery.append(node('span','',submitted.startCreation ? '需求已保留。继续会确认同一次创作，不会新建重复生成请求。' : '项目和原图恢复记录仍保留。继续会使用同一项目，不会自动生成图片。'),button('继续这个项目','ns-text-button',create));
    if (submitted && canEndHandoff()) { const end = button('结束交接，保留项目','ns-text-button',endHandoff); end.disabled = busy || checkingRecovery || Boolean(runs.size); recovery.append(end); }
    controls();
  }
  async function addFiles(files) {
    if (busy || submitted || !loaded || recoveryBlocked) return;
    for (const file of files) {
      if (items.length >= 4) { notify('每次最多带 4 张图片。'); break; }
      if (!validFile(file)) { notify('请选择 10 MB 以内的 PNG、JPG 或 WebP 图片。'); continue; }
      items.push({id:crypto.randomUUID(),file,name:(file.name || 'image.png').slice(0,255),taskId:null,taskStatus:null,uploadStarted:false,material:null,saved:false,url:URL.createObjectURL(file),error:''});
    }
    render(); await persist().catch(() => {});
  }
  async function create() {
    if (busy || checkingRecovery || !loaded || recoveryBlocked || host.legacyBlocked() || host.composing()) return;
    const brief = $('ns-home-brief').value;
    if (!submitted && brief.length > 4000) { $('ns-create-status').textContent = '创作需求最多 4000 个字符，完整草稿仍保留。请缩短后再开始。'; $('ns-home-brief').focus(); return; }
    if (!submitted && !items.length && !brief.trim()) { $('ns-create-status').textContent = '先写一句需求，或打开空白画布。'; $('ns-home-brief').focus(); return; }
    if (!submitted && items.some(item => !validFile(item.file))) return;
    busy = true; render(); const origin = location.hash;
    try {
      // Only a new explicit click opts into first creation. Historical saved
      // handoffs without this flag keep their original upload-only meaning.
      if (!submitted) submitted = {requestId:crypto.randomUUID(),brief,projectName:Array.from(brief.trim().split('\n')[0] || '图片创作').slice(0,32).join(''),projectId:null,startCreation:Boolean(brief.trim()),creationStarted:false,creationAccepted:false};
      // Persist both creation identity and every upload identity before writes.
      await persist(); $('ns-create-status').textContent = '正在创建项目并保存需求…';
      if (!submitted.projectId) {
        const response = await api('/compare/api/create',{requestId:submitted.requestId,projectName:submitted.projectName,brief:submitted.brief});
        if (!identity(response?.projectId)) throw new Error('项目创建结果还没确认，请继续同一次请求。');
        submitted.projectId = response.projectId; await persist();
      }
      await host.reloadProjects();
      if (!host.project(submitted.projectId)) throw new Error('项目已创建，项目库还未同步，请稍后继续。');
      $('ns-create-status').textContent = submitted.startCreation ? '项目已创建，打开画布后开始这次创作。' : '项目已创建，打开画布后继续保存图片。';
      if (location.hash === origin) host.openProject(submitted.projectId);
      else notify('项目和需求已保留在项目库，打开后继续。');
    } catch (error) { $('ns-create-status').textContent = (typeof error?.message === 'string' ? error.message.slice(0,240) : '创建尚未确认，请继续。') + ' 需求和原图仍保留。'; }
    finally { busy = false; render(); if (latestEntry) void resume(latestEntry); }
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
      const invalidFile = items.find(item => item.id === state.failedId)?.failureKind === 'invalid';
      const retry = button(state.failedId ? invalidFile ? '更换失败图片' : '重新上传失败图片' : '继续确认','ns-primary',() => {
        if (invalidFile) selectReplacement(entry,state.failedId);
        else if (state.failedId) void retryFailed(entry,state.failedId);
        else void resume(entry,true);
      });
      retry.disabled = busy || checkingRecovery; actions.append(retry);
      if (state.failedId) {
        const item = items.find(value => value.id === state.failedId);
        if (item && failedItem(item)) { const remove = button('移除失败图片','ns-text-button',async () => {
          const removed = await removeItem(item);
          if (removed && submitted?.projectId === entry.id) paint(entry,{kind:'error',title:'失败图片已移除',detail:'项目和已保存素材仍保留。可结束本次交接后继续编辑，不会自动提交创作。'});
        }); remove.disabled = busy || checkingRecovery; actions.append(remove); }
      }
      if (canEndHandoff()) { const end = button('结束交接并进入项目','ns-text-button',endHandoff); end.disabled = busy || checkingRecovery; actions.append(end); }
      actions.append(button('返回项目库','ns-text-button',() => host.goProjects())); box.append(actions);
    }
    $('ns-frames').classList.add('hs-transferring'); entry.frame.inert = true;
  }
  function remaining(deadline) { const value = deadline - Date.now(); if (value <= 0) throw new Error('本次等待已结束。已提交的任务可能还在处理，请稍后继续确认，原图仍保留。'); return value; }
  async function request(path, init, deadline) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.min(20000,remaining(deadline)));
    try {
      const response = await fetch(path,{...init,signal:controller.signal,credentials:'same-origin',cache:'no-store'});
      let value; try { value = await response.json(); } catch { throw new Error('暂时读不到素材结果，继续会复用同一次请求。'); }
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
      item.uploadStarted = true; await persist();
      const form = new FormData(); form.set('projectId',entry.id); form.set('mutationId',item.id); form.set('file',item.file,item.name);
      task = taskReceipt(await request(endpoint,{method:'POST',body:form},deadline),item,entry.id);
    }
    item.taskId = task.taskId; item.taskStatus = task.status; await persist();
    while (task.status === 'PENDING' || task.status === 'RUNNING') {
      if (!current(entry)) throw new Error('页面已切换，已提交的任务会继续处理。');
      if (Date.parse(task.expiresAt) <= Date.now()) throw new Error('任务处理时间已到，请到任务面板确认结果，原图仍保留。');
      paint(entry,{kind:'loading',title:'正在保存图片素材',detail:'已提交 '+(items.indexOf(item)+1)+' / '+items.length+' 张，正在等待处理结果。'});
      await new Promise(resolve => setTimeout(resolve,Math.min(1500,remaining(deadline))));
      task = taskReceipt(await request(endpoint + '&taskId=' + encodeURIComponent(item.taskId),{},deadline),item,entry.id);
      item.taskStatus = task.status;
    }
    if (task.status === 'FAILED') { recordFailure(item,task); await persist(); render(); const error = new Error(item.error); error.failedId = item.id; throw error; }
    item.material = task.material; item.error = ''; await persist(); render();
  }
  function waitForSaved(entry, item, deadline) {
    return new Promise((resolve,reject) => {
      const timeout = remaining(deadline);
      const timer = setTimeout(() => { waiters.delete(item.id); reject(new Error('画布保存还未确认。原图和素材已保留，继续确认不会重复插入。')); },timeout);
      waiters.set(item.id,{entry,resolve,reject,timer,action:'insert-material-result'});
      try { entry.frame.contentWindow.postMessage({type:'nv-studio',action:'insert-material',projectId:entry.id,requestId:item.id,material:materialReceipt(item.material)},location.origin); }
      catch { clearTimeout(timer); waiters.delete(item.id); reject(new Error('画布尚未接收图片，请重新打开项目后继续。')); }
    });
  }
  function waitForCreation(entry, submission, deadline) {
    return new Promise((resolve,reject) => {
      const requestId = submission.requestId;
      const timer = setTimeout(() => { waiters.delete(requestId); reject(new Error('创作的提交结果还没确认。需求已保留，继续只会核对同一次请求，不会重复扣费。')); }, Math.min(30000,remaining(deadline)));
      waiters.set(requestId,{entry,resolve,reject,timer,action:'start-creation-result'});
      try { entry.frame.contentWindow.postMessage({type:'nv-studio',action:'start-creation',projectId:entry.id,requestId,text:submission.brief,referenceShapeIds:items.map(item => 'shape:home-' + item.id)},location.origin); }
      catch { clearTimeout(timer); waiters.delete(requestId); reject(new Error('画布尚未接收创作需求，请重新打开项目后继续。')); }
    });
  }
  function receive(event) {
    const data = event.data;
    if (event.origin !== location.origin || !data || data.type !== 'nv-studio' || !['insert-material-result','start-creation-result'].includes(data.action) || !uuid(data.requestId)) return;
    const waiter = waiters.get(data.requestId);
    if (!waiter || data.action !== waiter.action || event.source !== waiter.entry.frame.contentWindow || data.projectId !== waiter.entry.id) return;
    const success = data.action === 'start-creation-result' ? 'accepted' : 'saved';
    if (data.status !== success && data.status !== 'failed') return;
    if (success === 'saved' && data.status === success && (!Number.isInteger(data.revision) || data.revision < 1)) return;
    clearTimeout(waiter.timer); waiters.delete(data.requestId);
    if (data.status === success) waiter.resolve();
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
        const drafts = stored?.items || [];
        if (!Array.isArray(drafts) || drafts.some(item => !uuid(item.id) || !validFile(item.file) || typeof item.name !== 'string' || item.taskId || item.uploadStarted)) throw new Error('恢复草稿已变化，请刷新后检查。');
        items.forEach(item => { if (item.url) URL.revokeObjectURL(item.url); });
        items = drafts.map(item => ({...item,taskStatus:null,material:null,saved:false,error:'',failureKind:null,url:URL.createObjectURL(item.file)})); submitted = null; states.delete(entry.id);
        if (current(entry)) {
          hide();
          // Only this lock-blocked, inert frame is known not to contain edits.
          // Reload its saved document after the sibling completed the handoff.
          if (siblingFinished) host.refreshImportedFrame(entry);
        }
        render(); return;
      }
      if (stored.submitted.requestId !== submitted?.requestId || stored.submitted.projectId !== entry.id) throw new Error('恢复记录已变化，请返回首页确认当前项目。');
      if (stored.submitted.creationAccepted === true) submitted.creationAccepted = true;
      if (stored.submitted.creationStarted === true) submitted.creationStarted = true;
      for (const item of items) {
        const receipt = stored.items?.find(value => value.id === item.id);
        if (!receipt || receipt.taskId && !identity(receipt.taskId)) throw new Error('图片恢复记录已变化，请返回首页确认。');
        item.saved = false; item.material = null; item.taskStatus = null; item.error = ''; item.taskId = receipt.taskId || item.taskId; item.uploadStarted = receipt.uploadStarted !== false;
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
      if (submitted.startCreation === true && !submitted.creationAccepted) {
        if (!submitted.brief.trim() || submitted.brief.length > 4000) throw new Error('创作需求长度不符合要求，请保留原始需求并在项目中继续编辑。');
        if (!current(entry) || !entry.ready) throw new Error('画布暂时不可用，需求和已保存素材仍保留。');
        paint(entry,{kind:'loading',title:'正在开始创作',detail:'需求和参考图已保存，正在提交这次创作。'});
        submitted.creationStarted = true; await persist();
        await waitForCreation(entry,submitted,deadline);
        submitted.creationAccepted = true; await persist();
      }
      const completed = items, previous = submitted;
      items = []; submitted = null;
      try { await persist(); } catch (error) { items = completed; submitted = previous; throw error; }
      completed.forEach(item => { if (item.url) URL.revokeObjectURL(item.url); });
      if ($('ns-home-brief').value === previous.brief) { $('ns-home-brief').value = ''; try { localStorage.removeItem('novart-m24-home-brief'); } catch {} }
      states.delete(entry.id); host.invalidateAssets(entry.id); render();
      if (current(entry)) { hide(); notify(previous.startCreation ? '创作已提交，可以在对话中查看进度。' : '图片和需求已保存，可以继续编辑。'); if (!previous.startCreation) host.showRequirements(entry); }
    } catch (error) {
      paint(entry,{kind:'error',title:submitted?.startCreation ? '创作交接尚未完成' : '图片交接尚未完成',detail:(typeof error?.message === 'string' ? error.message.slice(0,300) : '请稍后继续确认。') + ' 需求和原图仍保留。',failedId:error.failedId});
    }
  }
  async function resume(entry, retry=false) {
    latestEntry = entry;
    if (busy || checkingRecovery || !loaded || recoveryBlocked || !entry?.ready || !current(entry) || submitted?.projectId !== entry.id) return;
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
    try { await task; } finally { runs.delete(entry.id); render(); }
  }
  function canvasUnavailable(entry) {
    if (submitted?.projectId !== entry.id) return;
    for (const [id,waiter] of waiters) if (waiter.entry === entry) { clearTimeout(waiter.timer); waiters.delete(id); waiter.reject(new Error('画布暂时不可用，原图和已保存素材仍保留。')); }
    paint(entry,{kind:'error',title:'画布暂时不可用',detail:'图片交接已停止。原始需求、原图和已保存素材仍保留。'});
  }
  $('hs-file-input').addEventListener('change',event => { void addFiles([...event.target.files]); event.target.value = ''; });
  $('hs-pick').addEventListener('click',() => $('hs-file-input').click());
  $('ns-home-brief').addEventListener('input',controls);
  const composer = $('ns-composer');
  composer.addEventListener('dragover',event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); composer.classList.add('hs-drag'); } });
  composer.addEventListener('dragleave',event => { if (!composer.contains(event.relatedTarget)) composer.classList.remove('hs-drag'); });
  composer.addEventListener('drop',event => { if (event.dataTransfer.files.length) { event.preventDefault(); composer.classList.remove('hs-drag'); void addFiles([...event.dataTransfer.files]); } });
  composer.addEventListener('paste',event => { const files = [...event.clipboardData.files]; if (files.length) { event.preventDefault(); void addFiles(files); } });
  window.addEventListener('message',receive);
  window.addEventListener('pagehide',() => { window.removeEventListener('message',receive); for (const waiter of waiters.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('页面已关闭，原图恢复记录仍保留。')); } waiters.clear(); },{once:true});
  async function loadRecovery() {
    const own = await dbTask('readonly');
    if (own || key === legacyKey) return own;
    const legacy = await dbTask('readonly', undefined, legacyKey);
    if (!legacy) return null;
    // A missing project is unknown ownership (possibly a lost create response).
    // Keep that original record instead of assigning it to whichever brand opens first.
    const projectId = legacy.submitted?.projectId;
    if (!identity(projectId)) {
      notify('检测到尚未确认品牌归属的旧版草稿，原始记录仍保留，未放入当前品牌。');
      return null;
    }
    await host.reloadProjects();
    if (!host.project(projectId)) return null;
    // Network checks happen before the transaction. Re-read both keys under a
    // single write transaction: another tab may already have recovered/saved.
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('draft','readwrite'), store = transaction.objectStore('draft');
      let value = null;
      const timer = setTimeout(() => { try { transaction.abort(); } catch {} reject(new Error('恢复记录保存超时')); },8000);
      transaction.oncomplete = () => { clearTimeout(timer); resolve(value); };
      transaction.onerror = transaction.onabort = () => { clearTimeout(timer); reject(new Error('恢复记录未能保存')); };
      const ownRequest = store.get(key);
      ownRequest.onsuccess = () => {
        if (ownRequest.result) { value = ownRequest.result; return; }
        const legacyRequest = store.get(legacyKey);
        legacyRequest.onsuccess = () => {
          const candidate = legacyRequest.result;
          if (candidate?.submitted?.projectId !== projectId) return;
          try { validateRecovery(candidate); } catch { transaction.abort(); return; }
          value = candidate; store.put(candidate,key); store.delete(legacyKey);
        };
      };
    });
  }
  function validateRecovery(value) {
    if (value.version !== 1 || !Array.isArray(value.items) || value.items.length > 4 || new Set(value.items.map(item => item.id)).size !== value.items.length
      || value.items.some(item => !uuid(item.id) || typeof item.name !== 'string' || !validFile(item.file) || item.taskId && !identity(item.taskId))) throw new Error('恢复记录无法读取');
    if (value.submitted && (!uuid(value.submitted.requestId) || typeof value.submitted.brief !== 'string' || typeof value.submitted.projectName !== 'string'
      || value.submitted.projectId !== null && !identity(value.submitted.projectId)
      || value.submitted.startCreation !== undefined && typeof value.submitted.startCreation !== 'boolean'
      || value.submitted.creationStarted !== undefined && typeof value.submitted.creationStarted !== 'boolean'
      || value.submitted.creationAccepted !== undefined && typeof value.submitted.creationAccepted !== 'boolean')) throw new Error('恢复记录无法读取');
  }
  loadRecovery().then(value => {
    if (!value) return;
    validateRecovery(value);
    items = value.items.map(item => ({id:item.id,file:item.file,name:item.name,taskId:item.taskId || null,taskStatus:null,uploadStarted:typeof item.uploadStarted === 'boolean' ? item.uploadStarted : Boolean(value.submitted),material:null,saved:false,url:URL.createObjectURL(item.file),error:''})); submitted = value.submitted || null;
    if (submitted) $('ns-home-brief').value = submitted.brief;
  }).catch(() => { recoveryBlocked = true; draftError = '原图恢复记录暂不可用，请保留本页和原文件，检查存储空间后刷新。'; })
    .finally(async () => { loaded = true; render(); await inspectRecovery(); if (latestEntry) void resume(latestEntry); });
  render();
  return {create,hasDraft:() => Boolean(items.length || submitted),resume,canvasUnavailable,confirmLeave,routeChanged() { hide(); },busy:() => busy,
    snapshot:() => ({loaded,busy,recoveryPending:recoveryWrites > 0,recoveryError:draftError,recoveryBlocked,attachmentCount:items.length,readyCount:items.filter(item=>item.material).length,failedCount:items.filter(failedItem).length,checkingRecovery,canEndHandoff:canEndHandoff(),submittedRequestId:submitted?.requestId || null,running:[...runs.keys()]})};
};
