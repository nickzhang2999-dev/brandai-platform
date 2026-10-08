/* M24: local drafts around the captured application's own inputForm actions.
   No queue, send command, private editor property, or bare store mutation. */
(() => {
  'use strict';
  const query = new URLSearchParams(location.search);
  const expected = {ui:'novart',studio:'1',inputGuard:'m10',canvasTools:'m12',motion:'m13',feedback:'m14',visual:'m16',statusUi:'m20',layoutUi:'m21',draftUi:'m24'};
  if (location.hostname !== '127.0.0.1' || !Object.entries(expected).every(([key,value]) => query.getAll(key).length === 1 && query.get(key) === value)) return;
  const projectId = query.get('projectId');
  if (query.getAll('projectId').length !== 1 || !projectId) return;
  const clone = value => JSON.parse(JSON.stringify(value));
  const input = () => document.querySelector('[data-testid="agent-message-input"][contenteditable="true"]');
  const clean = form => {
    const value = clone(form);
    if (value.lexicalJSONState) {
      for (const field of ['reconciliation','nextReconciliation','isFlushSync']) delete value.lexicalJSONState[field];
      const walk = node => {
        if (!node || typeof node !== 'object') return;
        delete node.key; // Only Lexical nodes. data.param.key is a business identity.
        if (Array.isArray(node.children)) node.children.forEach(walk);
      };
      walk(value.lexicalJSONState.root);
    }
    return value;
  };
  const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key,ordered(value[key])])) : value;
  const signature = form => JSON.stringify(ordered(clean(form)));
  const bodySignature = form => JSON.stringify(ordered({text:form.text || '',root:clean(form).lexicalJSONState?.root || null,
    paramList:form.paramList || [],mentionPreviewList:form.mentionPreviewList || []}));
  const empty = form => !form?.text?.trim() && !(form?.paramList?.length) && !(form?.mentionPreviewList?.length);
  const cachePrefix = 'novart-m24-chat:' + projectId + ':';
  const writer = crypto.randomUUID(), cacheKey = cachePrefix + writer;
  let api = null, unsubscribe = null, bridgeModules = null, bridgeWait = null, booted = false, stopped = false, composing = false, compositionWait = null;
  let current = null, currentSignature = '', revision = 0, confirmedSignature = '', sequence = 0;
  let loaded = false, busy = false, restoring = false, conflict = false, reading = false, cacheFailed = false;
  let pendingRemote = null, protectedBackup = null, adoptedBackup = null, error = '', state = 'loading', timer = 0, captureQueued = false, restoreToken = 0, userVersion = 0, abortRestore = null;
  let receipt = null, message = null, action = null, choices = null, observer = null;
  let referenceIssues = [], referenceToggle = null, referenceDetails = null, referencesOpen = false;
  let checkingReferences = false, referenceError = '', removingReference = false, pointerVersion = 0;
  let referenceTimer = 0, observedCanvasSave = '', referenceObserver = null, referencesDirty = false;
  const resourceFields = new Set(['imageUrl','thumbnail','videoUrl','audioUrl','fileUrl','url','src','originalUrl']);
  const renderFields = ['url','originalUrl','w','h','adjust','flipX','flipY','cropRegion'];
  const materialized = new Map();
  let awaitingCanvas = false, materializing = false;
  const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n => n.toString(16).padStart(2,'0')).join('');
  const same = (left,right) => JSON.stringify(ordered(left)) === JSON.stringify(ordered(right));
  function renderContext(shape) {
    return {shapeId:shape.id,elementId:shape.id.replace(/:/g,'-'),rotation:shape.rotation ?? 0,
      shapeProps:Object.fromEntries(renderFields.filter(key => Object.hasOwn(shape.props,key)).map(key => [key,clone(shape.props[key])]))};
  }
  function currentShape(param) {
    const editor = bridgeModules?.imageApp.getEditor();
    if (!editor) throw new Error('原画布图片尚未就绪，请保持本页打开。');
    const encoded = param.elementId || param.data?.elementId;
    const canonical = param.data?.shapeId || param.shapeId;
    let shape;
    if (canonical) shape = editor.getShape(canonical);
    else {
      const matches = editor.getCurrentPageShapes().filter(item => item.type === 'c-image' && item.id.replace(/:/g,'-') === encoded);
      if (matches.length !== 1) throw new Error('原图片对象已变化，请保留输入并重新选择图片。');
      shape = matches[0];
    }
    if (!shape || shape.type !== 'c-image' || encoded && shape.id.replace(/:/g,'-') !== encoded) throw new Error('图片引用身份无法核对，原稿仍保留。');
    return {editor,shape,context:renderContext(shape)};
  }
  function captureImages(form, retryFailed = false) {
    const params = [...(form?.paramList || []),...nativeMentions(form).map(item => item.node.data.param)];
    for (const param of params) {
      const url = param?.data?.imageUrl;
      if (param?.type !== 'image' || param.loading || typeof url !== 'string' || !url.startsWith('blob:' + location.origin + '/')) continue;
      const previous = materialized.get(url);
      if (previous) {
        if (!retryFailed || !previous.error || previous.stableURL) continue;
        if (previous.blob && previous.sha256 && previous.width && previous.height) {
          try { previous.context ||= currentShape(param).context; previous.error = null; }
          catch (problem) { previous.error = problem; }
          continue;
        }
        if (previous.ownURL) URL.revokeObjectURL(previous.ownURL);
      }
      const record = {url,param:clone(param),context:null,blob:null,sha256:null,width:null,height:null,assetURL:null,stableURL:null,ownURL:null,error:null};
      materialized.set(url,record);
      // Fetch immediately, before debounce or the renderer invalidates its URL.
      const captured = fetch(url).then(response => {
        if (!response.ok) throw new Error('裁切图片读取未完成，请保留本页并重新选择图片。');
        return response.blob();
      });
      try { record.context = currentShape(param).context; }
      catch (problem) { record.error = problem; }
      record.ready = captured.then(async blob => {
        if (!blob.size || blob.size > 32 * 1024 * 1024 || blob.type !== 'image/png') throw new Error('裁切图片格式或大小暂不支持，请保持本页打开。');
        record.blob = blob;
        record.sha256 = await hash(await blob.arrayBuffer());
        const decoded = await createImageBitmap(blob);
        record.width = decoded.width; record.height = decoded.height; decoded.close();
        return record;
      }).catch(problem => { record.error = problem; return record; });
    }
  }
  function serialized(form) {
    const copy = clean(form);
    const walk = value => {
      if (!value || typeof value !== 'object') return;
      for (const key of Object.keys(value)) {
        const replacement = typeof value[key] === 'string' && resourceFields.has(key) ? materialized.get(value[key])?.stableURL : null;
        if (replacement) value[key] = replacement;
        else if (typeof value[key] === 'object') walk(value[key]);
      }
    };
    walk(copy); return copy;
  }
  function neededImages(form) {
    const urls = new Set();
    const walk = value => {
      if (!value || typeof value !== 'object') return;
      for (const [key,item] of Object.entries(value)) {
        if (resourceFields.has(key) && typeof item === 'string' && item.startsWith('blob:' + location.origin + '/')) urls.add(item);
        else if (item && typeof item === 'object') walk(item);
      }
    };
    walk(form); return [...urls];
  }
  function contextMatches(left,right) { return same({shapeId:left.shapeId,elementId:left.elementId,shapeProps:left.shapeProps,rotation:left.rotation},right); }
  function waiting(message = '正在等待画布保存裁切状态…') {
    const problem = new Error(message); problem.awaitCanvas = true; return problem;
  }
  async function stabilizeImages(form) {
    captureImages(form,true);
    for (const url of neededImages(form)) {
      const record = materialized.get(url);
      if (!record) throw new Error('临时图片暂无法保存，请保持本页打开并重新引用。');
      if (record.stableURL) continue;
      await record.ready;
      if (stopped) throw new Error('页面已关闭，未应用迟到图片回执。');
      if (record.error) throw record.error;
      if (!record.context) throw new Error('图片来源尚未核对，请保留输入并重新选择图片。');
      const active = currentShape(record.param);
      if (!same(active.context,record.context)) throw waiting('图片裁切状态已变化，正在等待最新引用。');
      // Use the original uncached renderer, not the stale ExtEditor cache.
      // Compare pixels by exact PNG bytes; no manual crop or resizing occurs.
      const fresh = await active.editor.getShapeUtil(active.shape).getRenderedImageData(active.shape,{skipRotation:false});
      if (!fresh?.url) throw new Error('原裁切图片校验未完成，请保持本页打开后重试。');
      let verified;
      try {
        const rendered = await fetch(fresh.url);
        if (!rendered.ok) throw new Error('原裁切图片读取失败，请保持本页打开后重试。');
        verified = await hash(await rendered.arrayBuffer());
      }
      finally { if (fresh.url.startsWith('blob:') && fresh.url !== url) URL.revokeObjectURL(fresh.url); }
      if (verified !== record.sha256 || !same(currentShape(record.param).context,record.context)) throw waiting('图片引用正在更新，等待最新裁切后再暂存。');
      const response = await fetch('/studio/reference-image/context?projectId=' + encodeURIComponent(projectId) + '&elementId=' + encodeURIComponent(record.context.elementId),{cache:'no-store'});
      const receipt = await response.json();
      if (!response.ok) {
        if (response.status === 409) throw waiting();
        throw new Error(receipt.error || '图片来源读取未完成，请保持本页打开后重试。');
      }
      if (receipt.projectId !== projectId || !receipt.context || !contextMatches(receipt.context,record.context)) throw waiting();
      if (!record.assetURL) {
        record.ownURL ||= URL.createObjectURL(record.blob);
        try { record.assetURL = await bridgeModules.imageTools.getRenderedImageUrl(record.ownURL); }
        finally { if (record.assetURL && record.ownURL) { URL.revokeObjectURL(record.ownURL); record.ownURL = null; } }
      }
      if (stopped) throw new Error('页面已关闭，未应用迟到图片回执。');
      if (!same(currentShape(record.param).context,record.context)) throw waiting('裁切已变化，原图片回执未用于新引用。');
      const accepted = await fetch('/studio/reference-image',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({projectId,context:receipt.context,assetUrl:record.assetURL,sha256:record.sha256,width:record.width,height:record.height})});
      const data = await accepted.json();
      if (stopped) throw new Error('页面已关闭，未应用迟到图片回执。');
      if (!accepted.ok) {
        if (accepted.status === 409) throw waiting('画布状态已更新，原图片回执未用于新引用。');
        throw new Error(data.error || '裁切图片未能落盘，请保持本页打开后重试。');
      }
      if (data.projectId !== projectId || data.sha256 !== record.sha256 || data.width !== record.width || data.height !== record.height
        || data.assetUrl !== 'https://local-assets.invalid/' + record.sha256 || data.contextFingerprint !== receipt.context.contextFingerprint
        || data.elementId !== record.context.elementId || data.shapeId !== record.context.shapeId) throw new Error('图片落盘回执无法核对，请保持本页打开。');
      record.stableURL = data.assetUrl;
      record.blob = null; // Keep only the URL mapping needed by native Undo.
      // A confirmed asset/proof is not a confirmed draft. Persist a canonical
      // backup now, so a later real draft-write failure can recover on reload.
      cache(); renderReferences();
    }
    return serialized(form);
  }
  const mentionIdentity = param => param?.key ? {kind:'key',value:param.key}
    : param?.elementId ? {kind:'elementId',value:param.elementId} : null;
  const matchesIssue = (param, issue) => {
    const identity = mentionIdentity(param);
    const url = param?.data?.imageUrl;
    const expected = issue.referenceURL || 'https://local-assets.invalid/' + issue.assetSha256;
    return (!issue.identity || identity && identity.kind === issue.identity.kind && identity.value === issue.identity.value)
      && (url === expected || materialized.get(url)?.stableURL === expected);
  };
  const nativeMentions = form => {
    const nodes = [];
    const walk = (node, paragraph, depth) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'lovart-beautiful-mention' && node.data?.param?.type === 'image') nodes.push({node,paragraph,depth});
      if (Array.isArray(node.children)) node.children.forEach(child => walk(child,paragraph,depth+1));
    };
    (form?.lexicalJSONState?.root?.children || []).forEach((node,index) => walk(node,index,0));
    return nodes;
  };
  function visibleIssues() {
    const params = [...(current?.paramList || []),...nativeMentions(current).map(item => item.node.data.param)];
    const issues = referenceIssues.filter(issue => params.some(param => matchesIssue(param,issue)));
    // The original crop renderer emits a session-only blob. Never call that
    // durable or rewrite it into the original source image by assumption.
    for (const param of params) {
      const url = param?.data?.imageUrl, identity = mentionIdentity(param);
      if (typeof url !== 'string' || !url.startsWith('blob:' + location.origin + '/') || materialized.get(url)?.stableURL) continue;
      if (issues.some(issue => matchesIssue(param,issue))) continue;
      issues.push({code:'TEMPORARY_IMAGE',identity,referenceURL:url,label:param.label || '图片引用',
        message:materializing ? '正在保存裁切图片，当前文字仍保留。' : '裁切图片还未落盘，请保持本页打开后重试；当前文字和之前已存草稿仍保留。'});
    }
    return issues;
  }
  function acceptIssues(data) {
    if (!Array.isArray(data.referenceIssues) || data.referenceIssues.some(issue => !issue || typeof issue.code !== 'string'
      || typeof issue.message !== 'string' || typeof issue.label !== 'string' || !/^[a-f0-9]{64}$/.test(issue.assetSha256)
      || issue.identity !== null && (!['key','elementId'].includes(issue.identity?.kind) || typeof issue.identity.value !== 'string'))) {
      throw new Error('图片引用状态无法核对，草稿内容仍保留。');
    }
    referenceIssues = data.referenceIssues; referenceError = '';
  }
  function canRemove(issue) {
    if (!issue.identity) return false;
    const matches = nativeMentions(current).filter(item => matchesIssue(item.node.data.param,issue));
    return matches.length > 0 && matches.every(item => item.paragraph === 0 && item.depth === 1);
  }
  function renderReferences() {
    if (!referenceToggle) return;
    const issues = visibleIssues();
    referenceToggle.hidden = !issues.length && !referenceError;
    referenceToggle.textContent = referenceError ? '图片引用状态未确认' : `${issues.length} 个图片引用需要处理`;
    referenceToggle.setAttribute('aria-expanded',String(referencesOpen));
    referenceDetails.hidden = !referencesOpen || referenceToggle.hidden;
    // Rebuild only on a meaningful change: keyboard focus survives unrelated
    // native store notifications and the canvas save-status observer.
    const signature = JSON.stringify([issues,referenceError,removingReference,composing,restoring,busy,checkingReferences,
      issues.map(canRemove)]);
    if (referenceDetails.dataset.signature === signature) return;
    referenceDetails.dataset.signature = signature;
    referenceDetails.replaceChildren();
    if (referenceError) {
      const text = document.createElement('p'); text.textContent = referenceError;
      const retry = button('重新检查',refreshReferences); retry.disabled = checkingReferences;
      referenceDetails.append(text,retry);
    }
    for (const issue of issues) {
      const row = document.createElement('div'); row.className = 'm24-reference-row';
      const text = document.createElement('p');
      const label = document.createElement('strong'); label.textContent = issue.label || '图片引用';
      text.append(label,document.createElement('br'),document.createTextNode(issue.message));
      row.append(text);
      if (canRemove(issue)) {
        const remove = button('移除引用',event => removeReference(issue,event.currentTarget));
        remove.disabled = composing || restoring || busy || removingReference || conflict || !!pendingRemote;
        row.append(remove);
      } else {
        const hint = document.createElement('span'); hint.className = 'm24-reference-hint';
        hint.textContent = '请在输入框中选中这个引用后删除。'; row.append(hint);
      }
      referenceDetails.append(row);
    }
  }
  async function refreshReferences() {
    if (!loaded || stopped || checkingReferences || reading || restoring || busy || conflict || pendingRemote) return;
    checkingReferences = true; referencesDirty = false; const startRevision = revision; renderReferences();
    try {
      const data = await fetchDraft();
      if (stopped) return;
      if (revision !== startRevision) { referencesDirty = true; return; }
      if (referencesDirty) return; // A newer confirmed canvas save supersedes this read.
      if (data.revision !== revision) {
        referenceError = '草稿已在其他页面更新，请先核对草稿。';
        conflict = true; note('conflict'); return;
      }
      acceptIssues(data);
    } catch (problem) { if (!stopped) referenceError = problem.message; }
    finally {
      checkingReferences = false;
      if (!stopped) { renderReferences(); if (referencesDirty) refreshReferences(); }
    }
  }
  async function removeReference(issue, control) {
    if (!api || !loaded || stopped || composing || restoring || busy || removingReference || conflict || pendingRemote || !canRemove(issue)) return;
    const version = pointerVersion, thread = api.thread();
    removingReference = true; referenceError = ''; renderReferences();
    try {
      await api.removeReference(issue,thread);
      if (stopped) return;
      capture(); referencesOpen = visibleIssues().length > 0;
      const host = window.frameElement;
      const activeFrame = !host || (!host.closest('[inert]') && host.ownerDocument.activeElement === host
        && host.getBoundingClientRect().width > 0 && host.getBoundingClientRect().height > 0);
      if (activeFrame && pointerVersion === version && thread === api.thread()
        && (document.activeElement === control || document.activeElement === document.body)) input()?.focus({preventScroll:true});
    } catch (problem) { if (!stopped) referenceError = problem.message || '引用尚未移除，原稿仍保留。'; }
    finally { removingReference = false; if (!stopped) renderReferences(); }
  }
  function observeCanvasReceipt() {
    const canvasReceipt = document.querySelector('#novart-bar .nv-save');
    if (!canvasReceipt || referenceObserver) return;
    const check = () => {
      const saved = canvasReceipt.dataset.savedAt || '';
      if (canvasReceipt.dataset.saveState !== 'saved' || !saved || saved === observedCanvasSave) return;
      observedCanvasSave = saved; referencesDirty = true; clearTimeout(referenceTimer);
      if (awaitingCanvas) { awaitingCanvas = false; scheduleSave(); }
      referenceTimer = setTimeout(refreshReferences,150);
    };
    referenceObserver = new MutationObserver(check);
    referenceObserver.observe(canvasReceipt,{attributes:true,attributeFilter:['data-save-state','data-saved-at']}); check();
  }

  function cached() {
    try {
      const entries = [];
      for (let i=0; i<localStorage.length; i++) {
        const key = localStorage.key(i); if (!key?.startsWith(cachePrefix)) continue;
        const raw = localStorage.getItem(key); let data;
        try { data = JSON.parse(raw); } catch (_) { continue; }
        if (data?.projectId === projectId && Number.isSafeInteger(data.revision) && data.revision >= 0
          && Number.isFinite(data.updatedAt) && data.inputForm && typeof data.inputForm.text === 'string') entries.push({...data,_cacheKey:key,_raw:raw});
      }
      return entries.sort((a,b) => b.updatedAt - a.updatedAt)[0] || null;
    } catch (_) { cacheFailed = true; return null; }
  }
  function cache() {
    if (!current) return;
    if (protectedBackup && sequence === 0) return;
    try { localStorage.setItem(cacheKey,JSON.stringify({projectId,revision,writer,updatedAt:Date.now(),inputForm:serialized(current)})); cacheFailed = false; }
    catch (_) { cacheFailed = true; }
  }
  function discardBackup(record) {
    if (!record) return;
    try { if (localStorage.getItem(record._cacheKey) === record._raw) localStorage.removeItem(record._cacheKey); }
    catch (_) { cacheFailed = true; }
  }
  function removeCache() {
    try {
      const raw = localStorage.getItem(cacheKey), data = JSON.parse(raw || 'null');
      if (data?.writer === writer && data.revision <= revision && signature(data.inputForm) === signature(serialized(current)) && currentSignature === confirmedSignature) localStorage.removeItem(cacheKey);
      if (adoptedBackup && !protectedBackup) { discardBackup(adoptedBackup); adoptedBackup = null; }
    } catch (_) { cacheFailed = true; }
  }
  function render() {
    if (!receipt) return;
    receipt.dataset.draftState = state;
    const labels = {loading:'正在读取草稿…',restoring:'正在恢复草稿…',pending:'草稿待暂存',saving:'正在暂存草稿…',
      saved:empty(current) ? '草稿已清空' : '草稿已在本机暂存',empty:'草稿会在本机暂存',conflict:'另一页面更新了草稿',error:'草稿暂存未完成'};
    const label = error || (materializing ? '正在暂存裁切图片…' : labels[state]) || labels.pending;
    if (message.textContent !== label) message.textContent = label;
    receipt.title = cacheFailed ? label + '；浏览器备用暂存不可用，请保持此页打开。' : label;
    action.hidden = !(['error','conflict'].includes(state) || awaitingCanvas) || busy || reading || restoring;
    action.textContent = conflict ? '核对草稿' : loaded ? '重试暂存' : '重新读取';
    choices.hidden = !pendingRemote || composing || restoring || busy;
    renderReferences();
    document.documentElement.dataset.nvDraftReady = loaded ? 'true' : 'false';
  }
  function note(next, detail = '') { state = next; error = detail; render(); }
  function scheduleSave() {
    clearTimeout(timer);
    if (!loaded || busy || restoring || composing || conflict || pendingRemote || stopped || awaitingCanvas) return;
    timer = setTimeout(save,500);
  }
  function capture() {
    captureQueued = false;
    if (!api || stopped || restoring || composing) return;
    const next = clean(api.read()), nextSignature = signature(next);
    captureImages(next);
    if (nextSignature === currentSignature) return;
    const initialEmpty = empty(current) && empty(next) && !loaded && sequence === 0;
    current = next; currentSignature = nextSignature;
    if (initialEmpty) return;
    sequence++; awaitingCanvas = false; cache();
    if (pendingRemote || conflict) { render(); return; }
    note('pending'); scheduleSave();
  }
  function queueCapture() {
    if (captureQueued || stopped) return;
    captureQueued = true; queueMicrotask(capture);
  }
  async function fetchDraft() {
    let response, data;
    try { response = await fetch('/studio/draft?projectId=' + encodeURIComponent(projectId),{cache:'no-store'}); }
    catch (_) { throw new Error('草稿读取请求未完成，请保留当前输入后重新读取。'); }
    try { data = await response.json(); }
    catch (_) { throw new Error('草稿读取回执无法核对，请保留当前输入后重试。'); }
    if (!response.ok) throw new Error(data.error || '草稿暂时无法读取，请保留当前输入后重试。');
    if (data.projectId !== projectId || !Number.isSafeInteger(data.revision) || data.revision < 0
      || (data.inputForm !== null && (typeof data.inputForm !== 'object' || typeof data.inputForm.text !== 'string'))) throw new Error('草稿数据无法核对，请保留当前输入。');
    return data;
  }
  function waitComposition() {
    if (!composing) return Promise.resolve();
    return new Promise(resolve => { compositionWait = resolve; });
  }
  async function restore(form) {
    await waitComposition();
    const token = ++restoreToken, thread = api.thread(), userAtStart = userVersion;
    restoring = true; note('restoring');
    try {
      await api.restore(form,thread,() => token === restoreToken && !stopped && !composing && userVersion === userAtStart);
      if (stopped || token !== restoreToken) return false;
      current = clean(api.read()); currentSignature = signature(current); sequence++;
      return true;
    } catch (problem) {
      if (userVersion !== userAtStart) note('pending','已保留新输入，旧草稿未覆盖');
      else note('error',problem.message || '草稿未能恢复，请保留原稿后重试。');
      return false;
    } finally { restoring = false; abortRestore = null; queueCapture(); }
  }
  async function load(initial = false) {
    if (reading || stopped) return;
    reading = true; const start = sequence, backup = initial ? cached() : null;
    if (backup) { protectedBackup = backup; adoptedBackup = backup; }
    note('loading');
    try {
      const data = await fetchDraft();
      acceptIssues(data);
      await waitComposition(); capture();
      if (stopped) return;
      if (!initial || conflict) {
        pendingRemote = data; note('conflict','请选择要保留的草稿'); return;
      }
      loaded = true;
      if (sequence !== start || !empty(current)) {
        // The user's newer input wins over a delayed startup read.
        revision = data.revision; protectedBackup = null;
        confirmedSignature = data.inputForm ? signature(data.inputForm) : '';
        cache(); note('pending'); scheduleSave(); return;
      }
      // An unacknowledged pagehide write can leave the browser's revision
      // behind while the complete form already matches the checked disk GET.
      // Different content still requires an explicit conflict choice.
      const identicalBackup = backup?.inputForm && data.inputForm && signature(backup.inputForm) === signature(data.inputForm);
      if (backup && backup.revision !== data.revision && !identicalBackup) {
        revision = backup.revision; pendingRemote = data; conflict = true;
        if (await restore(backup.inputForm)) {
          protectedBackup = null; cache(); pendingRemote = data; conflict = true; note('conflict','浏览器备用稿与已暂存草稿不同');
        }
        return;
      }
      revision = data.revision;
      const desired = backup?.inputForm || data.inputForm;
      if (desired && !await restore(desired)) {
        if (state === 'pending') { loaded = true; protectedBackup = null; queueCapture(); scheduleSave(); }
        else loaded = false;
        return;
      }
      protectedBackup = null;
      confirmedSignature = data.inputForm ? signature(data.inputForm) : currentSignature;
      if (backup && !identicalBackup || currentSignature !== confirmedSignature) { cache(); note('pending'); scheduleSave(); }
      else { removeCache(); note(data.inputForm ? 'saved' : 'empty'); }
    } catch (problem) {
      // A failed read never grants a revision or writes a blank replacement.
      note('error',problem.message);
    } finally { reading = false; render(); if (referencesDirty) refreshReferences(); }
  }
  async function save() {
    clearTimeout(timer);
    if (!loaded || busy || composing || restoring || conflict || pendingRemote || stopped || !current) return;
    awaitingCanvas = false;
    if (currentSignature === confirmedSignature) { removeCache(); note(revision ? 'saved' : 'empty'); return; }
    busy = true; const sent = clone(current), sentSignature = currentSignature, canvasSaveAtStart = observedCanvasSave;
    note('saving');
    try {
      materializing = neededImages(sent).some(url => !materialized.get(url)?.stableURL); render();
      const durable = await stabilizeImages(sent); materializing = false;
      if (stopped) return;
      if (currentSignature !== sentSignature) { cache(); note('pending'); return; }
      const response = await fetch('/studio/draft',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({projectId,revision,inputForm:durable})});
      const data = await response.json();
      if (stopped) return;
      if (!response.ok) {
        if (response.status === 409) { conflict = true; note('conflict'); }
        else note('error',data.error || '草稿暂存失败，请保留当前输入后重试。');
        return;
      }
      if (data.projectId !== projectId || data.revision !== revision + 1 || !same(data.inputForm,durable)) throw new Error('暂存回执无法核对，请保留当前草稿。');
      acceptIssues(data);
      revision = data.revision; confirmedSignature = sentSignature;
      if (currentSignature === sentSignature) { removeCache(); note('saved'); }
      else { cache(); note('pending'); }
    } catch (problem) {
      if (stopped) return;
      if (problem.awaitCanvas) {
        awaitingCanvas = currentSignature === sentSignature && observedCanvasSave === canvasSaveAtStart;
        note('pending',awaitingCanvas ? problem.message : '');
      }
      else note('error',problem instanceof TypeError || problem instanceof SyntaxError
        ? '裁切图片或草稿暂存未确认，请保持本页打开后重试。' : problem.message);
    }
    finally { busy = false; materializing = false; if (!stopped) { render(); if (state === 'pending') scheduleSave(); else if (referencesDirty) refreshReferences(); } }
  }
  async function chooseRemote() {
    if (!pendingRemote || composing || busy || restoring) return;
    const data = pendingRemote;
    // Missing remote draft is never used to destroy the user's unsent input.
    if (!data.inputForm) { note('conflict','本机还没有已暂存稿，可选择用本页草稿替换'); return; }
    if (await restore(data.inputForm)) {
      acceptIssues(data);
      revision = data.revision; loaded = true; confirmedSignature = currentSignature;
      pendingRemote = null; conflict = false; protectedBackup = null;
      // The user explicitly chose the disk draft; discard only the inspected
      // recovery record, never a later record from another browser window.
      discardBackup(adoptedBackup); adoptedBackup = null;
      try { localStorage.removeItem(cacheKey); } catch (_) { cacheFailed = true; }
      note('saved');
    } else render();
  }
  function chooseCurrent() {
    if (!pendingRemote || composing || busy || restoring) return;
    revision = pendingRemote.revision; pendingRemote = null; conflict = false; protectedBackup = null; loaded = true;
    confirmedSignature = ''; cache(); note('pending'); save();
  }
  function button(label, fn) { const node = document.createElement('button'); node.type = 'button'; node.textContent = label; node.addEventListener('click',fn); return node; }
  function mount() {
    const edit = input(); if (!edit) return;
    if (!receipt?.isConnected) {
      receipt = document.createElement('div'); receipt.id = 'm24-draft-receipt';
      message = document.createElement('span'); message.setAttribute('role','status'); message.setAttribute('aria-live','polite');
      action = button('重新读取',() => conflict ? load(false) : loaded ? save() : load(true)); action.id = 'm24-draft-retry';
      choices = document.createElement('div'); choices.id = 'm24-draft-choices'; choices.hidden = true;
      choices.append(button('恢复已暂存草稿',chooseRemote),button('用本页草稿替换',chooseCurrent));
      referenceToggle = button('检查图片引用',() => { referencesOpen = !referencesOpen; renderReferences(); });
      referenceToggle.id = 'm24-reference-toggle'; referenceToggle.hidden = true;
      referenceToggle.setAttribute('aria-controls','m24-reference-details');
      referenceDetails = document.createElement('div'); referenceDetails.id = 'm24-reference-details'; referenceDetails.hidden = true;
      referenceDetails.setAttribute('role','region'); referenceDetails.setAttribute('aria-label','需要处理的图片引用');
      receipt.append(message,action,choices,referenceToggle,referenceDetails);
      const footer = document.getElementById('agent-chat-footer');
      let wrapper = edit;
      while (wrapper.parentElement && wrapper.parentElement !== footer) wrapper = wrapper.parentElement;
      if (footer && wrapper.parentElement === footer) wrapper.append(receipt);
      else edit.parentElement.parentElement.after(receipt);
      render();
    }
    observeCanvasReceipt();
    // This original headline only exists in an empty conversation.
    const headline = [...document.querySelectorAll('h1,h2,h3,p,div,span')].find(n => n.childElementCount === 0 && n.textContent.trim() === '试试这些 Lovart Skills');
    if (headline) {
      headline.textContent = '从一个想法开始'; headline.classList.add('m24-empty-heading');
      if (!headline.parentElement.querySelector('.m24-empty-note')) {
        const note = document.createElement('p'); note.className = 'm24-empty-note';
        note.textContent = '描述画面，或把画布素材加入引用。草稿会在本机暂存。'; headline.after(note);
      }
    }
  }
  function installBridge() {
    if (booted || stopped || !input() || !window.webpackChunk_lovartai_lovart_shell) return;
    try {
      if (!bridgeModules) window.webpackChunk_lovartai_lovart_shell.push([['novart-m24-local-draft-bridge'],{},require => {
        bridgeModules = {source:require(89759),actions:require(88494),reconcile:require(47674),imageApp:require(37750).pW,imageTools:require(48307)._$};
      }]);
      if (!bridgeModules) return;
      const {source,actions,reconcile} = bridgeModules;
      if (typeof source.ow.subscribe !== 'function') throw new Error('Original store subscription unavailable');
      if (!source._z('initialized') || !source._z('currentChatThreadId')) {
        if (!bridgeWait) bridgeWait = source.ow.subscribe(installBridge);
        return;
      }
      bridgeWait?.(); bridgeWait = null;
      api = {
          thread:() => source._z('currentChatThreadId'),
          read:() => clone(actions.qI(source._z('currentChatThreadId'))),
          removeReference:async (issue,thread) => {
            if (thread !== source._z('currentChatThreadId') || typeof reconcile.iQ !== 'function') throw new Error('对话已切换，引用仍保留。');
            const before = actions.qI(thread), found = nativeMentions(before).filter(item => matchesIssue(item.node.data.param,issue));
            if (!found.length || found.some(item => item.paragraph !== 0 || item.depth !== 1 || typeof item.node.key !== 'string')) throw new Error('请在输入框中选中这个引用后删除，文字仍保留。');
            await new Promise((resolve,reject) => {
              let finished = false;
              const finish = problem => { if (finished) return; finished = true; clearTimeout(timeout); off(); problem ? reject(problem) : resolve(); };
              const check = () => {
                if (stopped || thread !== source._z('currentChatThreadId')) return finish(new Error('对话已切换，引用状态未确认。'));
                const next = actions.qI(thread), lexical = next.lexicalJSONState;
                if (lexical?.root && !lexical.reconciliation && !lexical.nextReconciliation && !lexical.isFlushSync
                  && !nativeMentions(next).some(item => matchesIssue(item.node.data.param,issue))) finish();
              };
              const off = source.ow.subscribe(() => queueMicrotask(check));
              const timeout = setTimeout(() => finish(new Error('原编辑器未确认移除，请在输入框中检查引用。')),3500);
              // Fresh original node keys are supplied only to the source-owned
              // reconciliation action. The original OnChange rebuilds all lists.
              reconcile.iQ({remove:found.map(item => item.node)});
              queueMicrotask(check);
            });
          },
          restore:async (form,thread,valid) => {
            if (thread !== source._z('currentChatThreadId')) throw new Error('对话已切换，原稿仍保留。');
            const target = clean(form), expectedBody = bodySignature(target);
            // rE merges. Explicitly clear absent fields from the current form.
            const replacement = Object.fromEntries(Object.keys(actions.qI(thread)).map(key => [key,undefined]));
            Object.assign(replacement,target);
            if (!target.lexicalJSONState?.root) {
              if (!empty(target)) throw new Error('草稿缺少原编辑器文档，原稿仍保留。');
              actions.rE(thread,{...replacement,lexicalJSONState:undefined});
              await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
              if (!valid() || !empty(actions.qI(thread)) || input()?.textContent.trim()) throw new Error('原编辑器未确认空草稿恢复，请保留原稿。');
              return;
            }
            const before = actions.qI(thread).lexicalJSONState;
            if (before?.isFlushSync) {
              actions.rE(thread,{lexicalJSONState:{...before,isFlushSync:false}});
              await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            }
            if (!valid() || thread !== source._z('currentChatThreadId')) throw new Error('对话已切换，原稿仍保留。');
            await new Promise((resolve,reject) => {
              let finished = false;
              const finish = problem => { if (finished) return; finished = true; clearTimeout(timeout); off(); abortRestore = null; problem ? reject(problem) : resolve(); };
              abortRestore = () => finish(new Error('用户已开始新输入，旧草稿仍保留。'));
              const check = () => {
                if (!valid() || thread !== source._z('currentChatThreadId')) return finish(new Error('对话已切换，原稿仍保留。'));
                const next = actions.qI(thread), lexical = next.lexicalJSONState;
                if (lexical?.root && !lexical.isFlushSync && !lexical.reconciliation && !lexical.nextReconciliation
                  && bodySignature(next) === expectedBody) finish();
              };
              const off = source.ow.subscribe(check);
              const timeout = setTimeout(() => finish(new Error('原编辑器未确认草稿恢复，请保留原稿后重试。')),3500);
              actions.rE(thread,{...replacement,lexicalJSONState:{...target.lexicalJSONState,isFlushSync:true}});
            });
          }
        };
        booted = true; current = clean(api.read()); currentSignature = signature(current);
        unsubscribe = source.ow.subscribe(queueCapture);
        document.documentElement.dataset.nvDraftBridge = 'original-actions';
        load(true);
    } catch (_) { note('error','原输入组件暂未就绪，请保留输入后重开此项目。'); }
  }
  function compositionStart(event) {
    if (!input()?.contains(event.target)) return;
    userVersion++; if (restoring) { restoreToken++; abortRestore?.(); }
    composing = true; clearTimeout(timer); render();
  }
  function compositionEnd(event) {
    if (!input()?.contains(event.target)) return;
    composing = false; compositionWait?.(); compositionWait = null; queueCapture(); render(); scheduleSave();
  }
  function beforeInput(event) {
    if (!input()?.contains(event.target)) return;
    userVersion++;
    if (restoring) { restoreToken++; abortRestore?.(); }
  }
  function stop() {
    if (stopped) return;
    if (!restoring && !composing) capture();
    if (currentSignature !== confirmedSignature || busy || !loaded) cache();
    clearTimeout(timer); clearTimeout(referenceTimer);
    // Best effort only. Cached draft is removed exclusively by a checked receipt.
    if (loaded && !busy && !restoring && !composing && !conflict && !pendingRemote && currentSignature !== confirmedSignature
      && neededImages(current).every(url => materialized.get(url)?.stableURL)) {
      fetch('/studio/draft',{method:'POST',keepalive:true,headers:{'Content-Type':'application/json'},
        body:JSON.stringify({projectId,revision,inputForm:serialized(current)})}).catch(() => {});
    }
    stopped = true; restoreToken++; abortRestore?.(); bridgeWait?.(); unsubscribe?.(); observer?.disconnect();
    referenceObserver?.disconnect();
    for (const record of materialized.values()) if (record.ownURL) URL.revokeObjectURL(record.ownURL);
    document.removeEventListener('compositionstart',compositionStart,true);
    document.removeEventListener('compositionend',compositionEnd,true);
    document.removeEventListener('beforeinput',beforeInput,true);
    document.removeEventListener('pointerdown',pointerDown,true);
  }
  Object.defineProperty(window,'NovartM24Draft',{value:Object.freeze({snapshot() {
    return {projectId,revision,state,loaded,busy,restoring,composing,conflict,pendingChoice:!!pendingRemote,
      sequence,cacheFailed,referenceIssues:clone(visibleIssues()),referenceError,checkingReferences,removingReference,awaitingCanvas,materializing,
      materializedImages:[...materialized.values()].map(record => ({url:record.url,sha256:record.sha256,width:record.width,height:record.height,
        stableURL:record.stableURL,error:record.error?.message || null})),serializedInputForm:current ? serialized(current) : null,
      inputForm:current ? clone(current) : null,nativeInputForm:api ? api.read() : null};
  }}),writable:false});
  function start() {
    document.addEventListener('pointerdown',pointerDown,true);
    document.addEventListener('compositionstart',compositionStart,true);
    document.addEventListener('compositionend',compositionEnd,true);
    document.addEventListener('beforeinput',beforeInput,true);
    observer = new MutationObserver(() => { mount(); installBridge(); });
    observer.observe(document.documentElement,{childList:true,subtree:true});
    mount(); installBridge();
    window.addEventListener('pagehide',stop,{once:true});
  }
  function pointerDown(event) { if (event.isTrusted) pointerVersion++; }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',start,{once:true}); else start();
})();
