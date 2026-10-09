/* Product image generation uses durable HTTP receipts. Captured native modules
   still own input editing, image shapes, undo and document persistence. */
(() => {
  'use strict';
  const context = window.__NOVART_PRODUCT__, projectId = new URLSearchParams(location.search).get('projectId');
  if (!context || !projectId || location.pathname !== '/canvas') return;
  const endpoint = '/studio/generation?projectId=' + encodeURIComponent(projectId);
  const documentEndpoint = '/api/workspaces/' + encodeURIComponent(context.workspaceId) + '/projects/' + encodeURIComponent(projectId) + '/editor-document';
  const ratios = ['1:1','4:5','3:4','2:3','9:16','5:4','4:3','3:2','16:10','16:9','2.35:1','3:1'];
  const tasks = new Map(), autoInsert = new Map(), inserting = new Set(), retrying = new Set(), archiveWatchStarted = new Map(), watchStarted = new Map();
  const checks = new Map(); let checkEpoch = 0;
  const instance = crypto.randomUUID();
  const retryKey = 'novart-generation-pending:' + projectId;
  const frameKey = 'novart-generation-output-frame:' + projectId;
  let native, panel, list, notice, refreshButton, pendingButton, pendingPrompt, settings, ratioSelect, resolutionSelect, settingsSummary, frameControl, frameSelect, frameNote;
  let framePreference=null, frameOptionsKey='', editorUnsubscribe, mountQueued=false, lastWorkflowIntent=null;
  let timer, observer, unsubscribe, stopped = false, submitting = false, refreshing = false, failures = 0, paused = false;
  let pending = null, userRevision = 0, composing = false;
  const clone = value => JSON.parse(JSON.stringify(value));
  const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
  function signature(form) {
    const value = clone(form);
    if (value.lexicalJSONState) {
      for (const key of ['isFlushSync','reconciliation','nextReconciliation']) delete value.lexicalJSONState[key];
      const clean = node => { if (!node || typeof node !== 'object') return; delete node.key; node.children?.forEach(clean); };
      clean(value.lexicalJSONState.root);
    }
    return JSON.stringify(ordered(value));
  }
  const node = (tag, value, className) => { const element = document.createElement(tag); element.textContent = value; if (className) element.className = className; return element; };
  const message = value => { if (notice) { notice.textContent = value; panel.hidden = false; } };
  function bridge() {
    if (native?.editor?.store) return native;
    if (!document.querySelector('.tl-container, .tl-canvas')) throw Error('画布尚未就绪，请稍后重试');
    window.webpackChunk_lovartai_lovart_shell?.push([['novart-generation-' + Date.now()], {}, require => {
      if (![89759,88494,37750,29543,63470,41604,20254].every(id => typeof require.m?.[id] === 'function')) return;
      native = {source:require(89759), actions:require(88494), editor:require(37750).pW.getEditor(), image:require(29543).getDefaultImageShape,
        userShape:require(63470).g5, quality:require(41604), qualityActions:require(20254)};
    }]);
    if (!native?.editor?.store || !native.source._z('initialized')) throw Error('输入框尚未就绪，请稍后重试');
    return native;
  }
  function current() { const api = bridge(), threadId = api.source._z('currentChatThreadId'); return {threadId, form:clone(api.actions.qI(threadId))}; }
  function editable() { const api = bridge(); if (context.readOnly || api.editor.getInstanceState().isReadonly) throw Error('当前项目仅可查看，无法生成或加入图片'); return api.editor; }
  function size(form) {
    const nativeResolution = bridge().quality.X1('preference')?.image;
    const value = form.novartGenerationSize || {ratioKey:'1:1',resolutionTier:['1K','2K'].includes(nativeResolution)?nativeResolution:'1K'};
    if (!value || Object.keys(value).some(key => !['ratioKey','resolutionTier'].includes(key)) || !ratios.includes(value.ratioKey) || !['1K','2K'].includes(value.resolutionTier)) throw Error('当前尺寸尚未支持，请在发送旁选择比例与 1K / 2K');
    return {...value};
  }
  function workflowIntent(workflow) { return workflow?.loaded===false||!workflow?null:JSON.stringify(ordered({mode:workflow.mode,target:workflow.target,references:workflow.references})); }
  function mountWorkflowMode() {
    const workflow=window.NovartProductWorkflowSnapshot?.();if(!workflow?.loaded||workflow.projectId!==projectId)return;
    const intent=workflowIntent(workflow);if(lastWorkflowIntent!==null&&lastWorkflowIntent!==intent)userRevision++;lastWorkflowIntent=intent;
    if(workflow.mode==='modify'&&framePreference){framePreference=null;try{sessionStorage.removeItem(frameKey);}catch{}}
    const note=document.querySelector('#novart-workflow .nw-mode-note'),copy=workflow.mode==='modify'
      ? '请选择并保存改图目标；结果另存为新图，完成后手动加入，原图保留。'
      : '选择画布对象不会改变这里的创作方式。';
    if(note&&note.textContent!==copy)note.textContent=copy;
  }
  const needsOutputFrame = workflow => workflow?.mode==='generate' && workflow.references?.some(ref=>ref.participates&&ref.purpose==='EXACT');
  function outputFrame(workflow) {
    if(!needsOutputFrame(workflow))return undefined;
    if(!framePreference)throw Error('完整保留素材需要明确的输出画框。请在发送旁的图片设置中选择画框；需求与用途已保留');
    const editor=bridge().editor;
    if(framePreference.pageId!==editor.getCurrentPageId() || !editor.getCurrentPageShapes().some(shape=>shape.type==='frame'&&shape.id===framePreference.frameId))throw Error('所选输出画框已删除或不在当前页面，请重新选择；需求与用途已保留');
    return framePreference.frameId;
  }
  function rememberFrame(frameId) {
    const editor=bridge().editor;
    framePreference=frameId?{userId:context.user.id,workspaceId:context.workspaceId,projectId,pageId:editor.getCurrentPageId(),frameId}:null;
    try{if(framePreference)sessionStorage.setItem(frameKey,JSON.stringify(framePreference));else sessionStorage.removeItem(frameKey);}catch{message('输出画框已在本页选定，浏览器暂不能记住它；刷新后请重新选择');}
    userRevision++;mount();
  }
  function scheduleMount() { if(!mountQueued&&!stopped){mountQueued=true;queueMicrotask(()=>{mountQueued=false;if(!stopped)mount();});} }
  function mountOutputFrames() {
    if(!frameControl)return;
    const workflow=window.NovartProductWorkflowSnapshot?.(),needed=Boolean(needsOutputFrame(workflow));
    if(frameControl.hidden===needed)frameControl.hidden=!needed;
    if(!needed)return;
    const editor=bridge().editor,frames=editor.getCurrentPageShapes().filter(shape=>shape.type==='frame');
    const chosen=framePreference?.frameId||'',valid=chosen&&framePreference.pageId===editor.getCurrentPageId()&&frames.some(shape=>shape.id===chosen);
    const options=[{id:'',text:frames.length?'请选择输出画框':'请先在画布创建画框'}];
    if(chosen&&!valid)options.push({id:chosen,text:'原画框不可用，请重新选择',disabled:true});
    frames.forEach((shape,index)=>options.push({id:shape.id,text:(shape.props.name||'画框')+' · '+Math.round(shape.props.w)+' × '+Math.round(shape.props.h)+' · '+(index+1)}));
    const key=JSON.stringify(options);
    if(key!==frameOptionsKey){frameOptionsKey=key;frameSelect.replaceChildren(...options.map(value=>{const option=new Option(value.text,value.id);option.disabled=Boolean(value.disabled);return option;}));}
    if(frameSelect.value!==chosen)frameSelect.value=chosen;
    const disabled=context.readOnly||submitting||Boolean(pending);if(frameSelect.disabled!==disabled)frameSelect.disabled=disabled;
    const hint=pending?'先确认上一份受理，再更换输出画框':chosen&&!valid?'原画框已删除或不在当前页面，请重新选择':'按此画框中的位置保留原素材，框外部分不出图';
    if(frameNote.textContent!==hint)frameNote.textContent=hint;
  }
  function supported(form) {
    const allowed = new Set(['text','paramList','mentionPreviewList','lexicalJSONState','toolNameList','agentConfig','threadIdType','useWebSearch','novartGenerationSize','preferToolParams','preferToolCategories']);
    for (const [key,value] of Object.entries(form)) if (!allowed.has(key) && value != null && value !== false && value !== '') throw Error('当前输入包含尚未接入的参数，原稿已保留：' + key);
    // Native plain text also appears as string entries in mentionPreviewList.
    // Structured entries represent references and must not be silently dropped.
    if ((form.paramList?.length || 0) || form.mentionPreviewList?.some(value => typeof value !== 'string')) throw Error('输入框的图片、文件或技能引用尚未接入。请在“素材”中选择图片与用途后保存，原稿仍保留');
    if ((form.toolNameList?.length || 0) || Object.keys(form.preferToolParams || {}).length || Object.keys(form.preferToolCategories || {}).length || form.useWebSearch) throw Error('工具、网页搜索或原生工具参数尚未接入，原稿仍保留');
    if (form.threadIdType != null && form.threadIdType !== 2) throw Error('当前 Agent 模式尚未接入，请切回普通 Agent 后提交图片生成');
    if (Object.entries(form.agentConfig || {}).some(([key,value]) => key !== 'plus' || !Array.isArray(value) || value.length)) throw Error('当前 Agent 配置尚未接入，原稿仍保留');
    const lexical = form.lexicalJSONState?.root;
    const inspect = value => { if (!value || typeof value !== 'object') return; if (value.type && !['root','paragraph','text','linebreak'].includes(value.type)) throw Error('输入中包含尚未支持的引用或富文本节点，原稿仍保留'); value.children?.forEach(inspect); };
    inspect(lexical);
    const quality = bridge().quality.X1();
    if (quality.selectedMode && quality.selectedMode !== 'normal') throw Error('当前原生 Agent 质量模式尚未接入，请使用普通模式；本产品支持 1K / 2K 图片');
    const preference = quality.preference || {};
    if (preference.image && !['auto','1K','2K'].includes(preference.image)) throw Error('原生 4K 或未知图片分辨率尚未接入，请改为 1K / 2K');
    if (preference.video && preference.video !== 'auto') throw Error('视频生成参数尚未接入，请清除视频参数后提交');
    const selected = size(form);
    if (['1K','2K'].includes(preference.image) && preference.image !== selected.resolutionTier) throw Error('原生图片分辨率与产品尺寸不同，请统一为 ' + preference.image + ' 后提交');
    if (typeof form.text !== 'string' || !form.text.trim() || form.text.trim().length > 4000) throw Error('请输入 1–4000 字的图片需求');
    return selected;
  }
  async function request(url, init, expectedStatus) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url, {...init,signal:controller.signal});
      let value; try { value = await response.json(); } catch { const error = Error('任务响应无法读取，请刷新任务确认'); error.retryable = response.status >= 500; throw error; }
      if (!response.ok || expectedStatus && response.status !== expectedStatus) { const error = Error(value.error || '任务暂时无法读取，请重试'); error.retryable = response.status >= 500; error.status = response.status; throw error; }
      return value;
    } catch (error) {
      if (error.name === 'AbortError') { const timeout = Error('响应超时，已受理任务仍会继续。请确认回执后再提交'); timeout.retryable = true; throw timeout; }
      if (error instanceof TypeError) error.retryable = true;
      throw error;
    } finally { clearTimeout(timeout); }
  }
  const post = (url, body) => request(url, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}, 202);
  function result(value) {
    if (!value || !['versionId','assetId'].every(key => typeof value[key] === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value[key]))
      || !/^[a-f0-9]{64}$/.test(value.assetSha256 || '') || !['image/png','image/jpeg','image/webp'].includes(value.mimeType)
      || !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height) || value.width <= 0 || value.height <= 0 || typeof value.url !== 'string') throw Error('生成成果回执不完整，请刷新任务');
    const url = new URL(value.url,location.origin), expected = '/api/workspaces/' + encodeURIComponent(context.workspaceId) + '/assets/' + encodeURIComponent(value.assetId) + '/raw';
    if (url.origin !== location.origin || url.pathname !== expected || url.search || url.hash) throw Error('生成图片地址不属于当前品牌');
    return {...value,url:url.pathname};
  }
  function accept(value) {
    if (!value || value.projectId !== projectId || !['requestId','mutationId','generationId','displayText'].every(key => typeof value[key] === 'string')
      || !['PENDING','RUNNING','SUCCEEDED','FAILED'].includes(value.status) || !['NOT_REQUESTED','PENDING','RUNNING','READY','FAILED'].includes(value.resultState)
      || !Number.isFinite(Date.parse(value.expiresAt)) || value.progress !== null && !Number.isFinite(value.progress)
      || [value.archiveExpiresAt,value.archiveProcessingExpiresAt].some(date => date != null && !Number.isFinite(Date.parse(date)))
      || !Array.isArray(value.results) || typeof value.canRetryArchive !== 'boolean') throw Error('生成任务回执不完整，请刷新确认');
    const mode=value.mode??'generate';if(!['generate','modify'].includes(mode))throw Error('图片任务类型无法确认，请刷新任务');
    const task = {...value,mode,results:value.results.map(result)};
    if (task.resultState === 'READY' && (task.status !== 'SUCCEEDED' || !task.results.length)) throw Error('生成成果尚未确认，请刷新任务');
    if (task.status === 'SUCCEEDED' && !archiveWatchStarted.has(task.requestId)) archiveWatchStarted.set(task.requestId,Date.now());
    if (!watchStarted.has(task.requestId)) watchStarted.set(task.requestId,Date.now());
    tasks.set(task.requestId,task); return task;
  }
  const active = task => ['PENDING','RUNNING'].includes(task.status) || task.status === 'SUCCEEDED' && ['NOT_REQUESTED','PENDING','RUNNING'].includes(task.resultState);
  const deadline = task => task.status === 'SUCCEEDED'
    ? Math.min(task.archiveProcessingExpiresAt ? Date.parse(task.archiveProcessingExpiresAt) : (archiveWatchStarted.get(task.requestId) || Date.now()) + 360000, task.archiveExpiresAt ? Date.parse(task.archiveExpiresAt) : Infinity)
    : Math.min(Date.parse(task.expiresAt),(watchStarted.get(task.requestId) || Date.now()) + 360000);
  function savePending(value) {
    pending = value;
    try { if (value) sessionStorage.setItem(retryKey,JSON.stringify(value)); else sessionStorage.removeItem(retryKey); }
    catch { message('浏览器暂不能保存回执确认记录；请保持页面打开并先刷新任务确认受理情况'); }
    render();
  }
  function clearSubmitted(operation) {
    if (stopped || composing || current().threadId !== operation.threadId) return;
    const form = current().form;
    const unchanged = operation.instance === instance ? userRevision === operation.userRevision : userRevision === 0;
    if (signature(form) === operation.signature && unchanged && (!operation.workflowIntent || operation.workflowIntent===workflowIntent(window.NovartProductWorkflowSnapshot?.()))) native.actions.bS(operation.threadId,{novartGenerationSize:operation.payload.sizeSelection});
  }
  function onAccepted(task, operation) {
    if (operation && operation.payload.mutationId === task.mutationId) {
      if(task.mode!==(operation.mode||'generate'))throw Error('任务类型与本次需求不一致，原稿已保留，请刷新任务确认');
      clearSubmitted(operation);
      if (task.mode==='generate' && !stopped && operation.instance === instance && operation.pageId === bridge().editor.getCurrentPageId()) autoInsert.set(task.requestId,operation.pageId);
      savePending(null);
    }
    message(task.mode==='modify'?'修改任务已受理，完成后请手动加入画布，原图保留':'生成任务已受理，关闭页面后仍会继续处理');
    render(); finishReady(task); schedule(); refreshChecks();
  }
  async function savedContext() {
    const local = window.NovartProductWorkflowSnapshot?.();
    if (!local?.loaded || local.busy || local.dirty || local.stale) throw Error('请先保存“素材”中的用途设置，再提交生成');
    const [workflow,doc] = await Promise.all([request('/workflow?projectId=' + encodeURIComponent(projectId)),request(documentEndpoint)]);
    if (workflow.projectId !== projectId || !Number.isInteger(workflow.revision) || workflow.revision !== local.revision) throw Error('素材设置已变化，请读取最新设置并检查后再提交');
    if (!['generate','modify'].includes(workflow.mode) || (workflow.mode==='generate' ? workflow.target!==null : !workflow.target?.shapeId || !/^[a-f0-9]{64}$/.test(workflow.target.assetSha256||''))) throw Error('请在“素材”中明确创作方式与改图目标，并保存设置；原稿已保留');
    if (!Array.isArray(workflow.references) || workflow.references.some(ref => ref.participates && !['EXACT','ADAPTIVE','REFERENCE'].includes(ref.purpose))) throw Error('参与生成的素材用途尚未确认，请选择用途并保存；需求已保留');
    const blocking=workflow.issues?.find(issue=>issue.blocking);if(blocking)throw Error(blocking.message||'素材或改图目标已失效，请检查“素材”面板；原稿已保留');
    if (doc.projectId !== projectId || doc.workspaceId !== context.workspaceId || doc.readOnly || !Number.isInteger(doc.revision)) throw Error('无法确认当前画布的保存状态或编辑权限');
    const live = bridge().editor.getSnapshot().document;
    if (doc.canvas) {
      if (!doc.canvas.startsWith('SHAKKERDATA://')) throw Error('画布格式无法识别，请保留页面');
      const bytes = Uint8Array.from(atob(doc.canvas.slice('SHAKKERDATA://'.length)), char => char.charCodeAt(0));
      const decoded = JSON.parse(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text());
      if (JSON.stringify(ordered(live)) !== JSON.stringify(ordered(decoded.tldrawSnapshot?.document))) throw Error('画布还有修改等待保存，请稍后再提交');
    } else if (Object.values(live.store || {}).some(value => value.typeName === 'shape')) throw Error('画布正在首次保存，请稍后再提交');
    const latest = window.NovartProductWorkflowSnapshot?.();
    if (!latest || latest.dirty || latest.busy || latest.revision !== workflow.revision) throw Error('素材设置已变化，请保存后再提交');
    const outputFrameId=outputFrame(workflow);
    return {mode:workflow.mode,intent:workflowIntent(workflow),revisions:{workflowRevision:workflow.revision,documentRevision:doc.revision,...(outputFrameId?{outputFrameId}:{})}};
  }
  async function submit(threadId, inputForm) {
    if (submitting || stopped) return false;
    submitting = true; mount();
    try {
      const editor = editable(), now = current();
      if (threadId !== now.threadId || signature(inputForm) !== signature(now.form)) throw Error('当前对话或输入已经变化，原稿仍保留，请从输入框重新提交');
      const draft = window.NovartM24Draft?.snapshot();
      if (!draft?.loaded || draft.restoring || draft.composing || draft.conflict || draft.pendingChoice) throw Error('请先完成草稿恢复或冲突处理，原稿仍保留');
      const selected = supported(inputForm), submittedSignature = signature(inputForm), editSequence = userRevision, pageId = editor.getCurrentPageId();
      let operation = pending;
      if (operation && (operation.signature !== submittedSignature || operation.workflowIntent && operation.workflowIntent!==workflowIntent(window.NovartProductWorkflowSnapshot?.()))) throw Error('上一份需求的受理回执尚未确认。请先刷新生成任务，当前新输入仍保留');
      if (!operation) {
        message('正在确认画布与素材设置…');
        const saved = await savedContext();
        if (stopped || editor.getCurrentPageId() !== pageId) throw Error('画布页面已切换，尚未提交生成');
        operation = {threadId,pageId,instance,mode:saved.mode,workflowIntent:saved.intent,signature:submittedSignature,userRevision:editSequence,
          payload:{projectId,mutationId:crypto.randomUUID(),prompt:inputForm.text.trim(),sizeSelection:selected,...saved.revisions}};
        savePending(operation);
      }
      message(operation.mode==='modify'?'正在提交图片修改…':'正在提交图片生成…');
      let received;
      try { received = await post(endpoint,operation.payload); }
      catch (error) { if (!error.retryable || stopped) throw error; message('正在确认生成回执…'); received = await post(endpoint,operation.payload); }
      const task = accept(received);
      if (task.mutationId !== operation.payload.mutationId) throw Error('生成回执与本次需求不一致，请刷新任务确认');
      onAccepted(task,operation); return true;
    } catch (error) {
      if (error.status >= 400 && error.status < 500) savePending(null);
      message(error.message); return false;
    } finally { submitting = false; render(); mount(); }
  }
  async function submitCurrent() { try { const value = current(); return await submit(value.threadId,value.form); } catch (error) { message(error.message); return false; } }
  async function confirmPending() {
    if (!pending || submitting || stopped) return;
    const operation = pending;submitting=true;render();mount();
    try { editable();const task=accept(await post(endpoint,operation.payload));if(task.mutationId!==operation.payload.mutationId)throw Error('回执与原需求不一致，请刷新任务');onAccepted(task,operation); }
    catch(error){if(error.status>=400&&error.status<500)savePending(null);message(error.message);}
    finally{submitting=false;render();mount();}
  }
  function existing(material) {
    return bridge().editor.getCurrentPageShapes().find(shape => { if (shape.type !== 'c-image' || !shape.props?.url) return false; try { return new URL(shape.props.url,location.origin).href === new URL(material.url,location.origin).href; } catch { return false; } });
  }
  async function insert(task, output, pageId) {
    const editor = editable(), material = result(output), insertionPage = editor.getCurrentPageId();
    if (pageId && pageId !== insertionPage) return null;
    const found = existing(material); if (found) { editor.select(found.id); return found.id; }
    if (inserting.has(material.versionId)) return null;
    inserting.add(material.versionId); render();
    try {
      await new Promise((resolve,reject) => {
        const image = new Image(), timeout = setTimeout(() => { image.src=''; reject(Error('生成图片读取超时，请重新加入画布')); },20000);
        image.onload = () => { clearTimeout(timeout); image.naturalWidth === material.width && image.naturalHeight === material.height ? resolve() : reject(Error('图片实际尺寸与成果记录不一致，请重试归档或联系管理员')); };
        image.onerror = () => { clearTimeout(timeout); reject(Error('生成图片暂时无法读取，请稍后重新加入')); }; image.src=material.url;
      });
      if (stopped) return null;
      editable(); if (editor.getCurrentPageId() !== insertionPage) throw Error('画布页面已切换，生成图片仍在任务列表，可重新加入');
      const duplicate = existing(material); if (duplicate) return duplicate.id;
      const bounds=editor.getViewportPageBounds(), scale=Math.min(1,1024 / Math.max(material.width,material.height)), w=material.width*scale, h=material.height*scale;
      const base='shape:novart-generation-' + material.versionId, id=editor.getShape(base)?base+'-'+crypto.randomUUID():base;
      const shape=native.image(id,{x:bounds.x+(bounds.w-w)/2,y:bounds.y+(bounds.h-h)/2,w,h},material.url,task.displayText.slice(0,40)||'生成图片');
      shape.meta={...shape.meta,novartAssetId:material.assetId,novartAssetSha256:material.assetSha256,novartGenerationId:task.generationId,novartVersionId:material.versionId};
      editor.markHistoryStoppingPoint('insert-generated-image');editor.createShapes([native.userShape(shape,'user')]);editor.select(id);
      message(task.mode==='modify'?'修改结果已加入画布，原图保留；保存状态见顶部':'生成图片已加入画布，保存状态见顶部');return id;
    } finally { inserting.delete(material.versionId);render(); }
  }
  function finishReady(task) {
    if(task.mode==='modify'){autoInsert.delete(task.requestId);return;}
    const pageId=autoInsert.get(task.requestId);
    if (pageId && task.status === 'SUCCEEDED' && task.resultState === 'READY') {
      autoInsert.delete(task.requestId);
      if (!stopped) insert(task,task.results[0],pageId).catch(error=>message(error.message));
    }
    if (task.status === 'FAILED' || task.resultState === 'FAILED') autoInsert.delete(task.requestId);
  }
  async function retryArchive(task) {
    if (retrying.has(task.requestId)) return;
    retrying.add(task.requestId);render();
    try { editable(); const updated=accept(await post('/studio/generation/retry-archive',{projectId,requestId:task.requestId}));archiveWatchStarted.set(updated.requestId,Date.now());message('已重新受理图片归档，不会再次生成');failures=0;paused=false;render();schedule(); }
    catch(error){message(error.message);}finally{retrying.delete(task.requestId);render();}
  }
  function checkCurrent(epoch) { const query=new URLSearchParams(location.search);return !stopped && epoch===checkEpoch && query.get('projectId')===projectId && query.get('workspaceId')===context.workspaceId && window.__NOVART_PRODUCT__===context; }
  function checkReceipt(value,material) {
    const statuses=['NOT_REQUESTED','PENDING','RUNNING','SUCCEEDED','FAILED'];
    if(!value || value.versionId!==material.versionId || !statuses.includes(value.status) || typeof value.canRetry!=='boolean'
      || !Number.isInteger(value.progress) || value.progress<0 || value.progress>100
      || value.error!==null && typeof value.error!=='string') throw Error('品牌检查回执不完整，请刷新');
    if(value.status==='NOT_REQUESTED' ? value.taskId!==null || value.expiresAt!==null
      : typeof value.taskId!=='string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.taskId) || !Number.isFinite(Date.parse(value.expiresAt))) throw Error('品牌检查任务或期限不完整，请刷新');
    if(value.status==='SUCCEEDED') {
      if(!['PASS','RISK','FORBIDDEN'].includes(value.report?.overall) || value.checkedImageSha256!==material.assetSha256) throw Error('品牌检查未对应当前图片，请刷新检查');
    } else if(value.report!==null || value.checkedImageSha256!==null) throw Error('尚未完成的检查不能显示通过');
    if(value.status==='FAILED' && (typeof value.error!=='string' || !value.error))throw Error('检查失败原因缺失，请刷新');
    return value;
  }
  function checkState(material) {
    if(!checks.has(material.versionId))checks.set(material.versionId,{material,value:null,error:'',busy:false,timer:null,failures:0,started:Date.now()});
    return checks.get(material.versionId);
  }
  function checkOverdue(state) { return state.value && ['PENDING','RUNNING'].includes(state.value.status) && Date.now()>Math.min(Date.parse(state.value.expiresAt),state.started+360000); }
  async function readCheck(material,manual=false,retry=false) {
    const state=checkState(material),epoch=checkEpoch;if(state.busy||!checkCurrent(epoch))return;
    clearTimeout(state.timer);state.busy=true;if(manual){state.failures=0;state.started=Date.now();}render();
    try {
      if(retry)editable();
      const value=retry ? await post('/studio/generation/compliance/retry',{projectId,versionId:material.versionId})
        : await request('/studio/generation/compliance?projectId='+encodeURIComponent(projectId)+'&versionId='+encodeURIComponent(material.versionId));
      if(!checkCurrent(epoch))return;
      state.value=checkReceipt(value,material);state.error='';state.failures=0;
      if(['PENDING','RUNNING'].includes(value.status)&&!checkOverdue(state))state.timer=setTimeout(()=>readCheck(material),Math.min(3000,Math.max(1,Date.parse(value.expiresAt)-Date.now()+1)));
    } catch(error) {
      if(!checkCurrent(epoch))return;
      // Never preserve a former PASS through an unverified/foreign/error reply.
      state.value=null;state.error=error.message;state.failures++;
      if(!retry&&error.retryable&&state.failures<=3)state.timer=setTimeout(()=>readCheck(material),Math.min(20000,2500*2**(state.failures-1)));
    } finally { if(checkCurrent(epoch)){state.busy=false;render();} }
  }
  function refreshChecks(force=false) {
    for(const task of [...tasks.values()].reverse().slice(0,20))if(task.status==='SUCCEEDED'&&task.resultState==='READY')for(const material of task.results) {
      if(force||!checks.has(material.versionId))readCheck(material,force);
    }
  }
  function renderCheck(row,material) {
    const state=checks.get(material.versionId),value=state?.value;
    let label='品牌检查：未读取';
    if(state?.error)label='品牌检查：未确认 · '+state.error;
    else if(value?.status==='SUCCEEDED')label='品牌检查：'+({PASS:'通过',RISK:'有风险',FORBIDDEN:'不符合品牌规范'}[value.report.overall]);
    else if(value?.status==='FAILED')label='品牌检查：未完成 · '+value.error;
    else if(value?.status==='NOT_REQUESTED')label='品牌检查：尚未开始'+(value.error?' · '+value.error:'');
    else if(checkOverdue(state||{}))label='品牌检查：状态待确认，请刷新';
    else if(value?.status==='PENDING')label='品牌检查：等待检查';
    else if(value?.status==='RUNNING')label='品牌检查：检查中';
    else if(state?.busy)label='品牌检查：正在读取';
    const line=node('span',label,'np-generation-status');line.dataset.checkVersionId=material.versionId;line.dataset.checkStatus=value?.status||'UNKNOWN';row.append(line);
    if(value?.canRetry&&!context.readOnly) {
      const button=node('button',value.status==='NOT_REQUESTED'?'开始品牌检查':'重试品牌检查');button.type='button';button.dataset.action='retry-check';button.dataset.versionId=material.versionId;button.disabled=Boolean(state?.busy);button.onclick=()=>readCheck(material,true,true);row.append(button);
    } else if(!value || checkOverdue(state)) {
      const button=node('button','刷新检查');button.type='button';button.dataset.action='refresh-check';button.dataset.versionId=material.versionId;button.disabled=Boolean(state?.busy);button.onclick=()=>readCheck(material,true);row.append(button);
    }
  }
  function label(task) {
    const modifying=task.mode==='modify';
    if (task.status==='FAILED') return task.error||(modifying?'修改失败，原图与需求仍保留':'生成失败，需求已保留在任务记录中');
    if (task.status==='SUCCEEDED') {
      if (task.resultState==='READY') return modifying?'修改结果已保存，手动加入画布后继续编辑；原图保留':'图片已生成并保存';
      if (task.resultState==='FAILED') return task.archiveError||(modifying?'图片已修改，归档失败；可重试归档':'图片已生成，归档失败；可重试归档');
      if (Date.now()>deadline(task)) return '图片已处理，归档状态待确认，请刷新任务';
      return modifying?'图片已修改，正在归档':'图片已生成，正在归档';
    }
    if (Date.now()>deadline(task)) return '任务处理超时，请刷新确认最终状态';
    if (paused) return '状态读取暂停，请刷新任务确认';
    return modifying?(task.status==='PENDING'?'等待修改':'正在修改图片'):(task.status==='PENDING'?'等待生成':'正在生成图片');
  }
  function render() {
    if (!panel) return;
    const focused=document.activeElement,focusId=list.contains(focused)?focused.closest('[data-request-id]')?.dataset.requestId:null;
    const focusAction=focused?.dataset.action,focusVersion=focused?.dataset.versionId;
    list.replaceChildren();panel.hidden=!tasks.size&&!notice.textContent&&!pending;
    pendingButton.hidden=!pending;pendingButton.disabled=submitting||context.readOnly;pendingPrompt.hidden=!pending;pendingPrompt.textContent=pending?(pending.mode==='modify'?'待确认改图需求：':'待确认需求：')+pending.payload.prompt:'';
    for (const task of [...tasks.values()].reverse().slice(0,20)) {
      const row=node('div','','np-generation-row');row.dataset.requestId=task.requestId;row.dataset.status=task.status;row.dataset.resultState=task.resultState;row.dataset.mode=task.mode;
      row.append(node('p',task.displayText,'np-generation-prompt'),node('span',label(task),'np-generation-status'));
      if (task.status==='SUCCEEDED' && task.resultState==='READY') for(const material of task.results) {
        renderCheck(row,material);
        if(context.readOnly)continue;
        const button=node('button','加入画布');button.type='button';button.dataset.action='insert';button.dataset.versionId=material.versionId;
        try { if(existing(material))button.textContent='定位图片'; }catch{}
        button.disabled=inserting.has(material.versionId);button.onclick=()=>insert(task,material).catch(error=>message(error.message));row.append(button);
      }
      if(task.canRetryArchive&&!context.readOnly){const button=node('button','重试归档');button.type='button';button.dataset.action='retry-archive';button.disabled=retrying.has(task.requestId);button.onclick=()=>retryArchive(task);row.append(button);}
      list.append(row);
    }
    if(focusId){const row=[...list.children].find(item=>item.dataset.requestId===focusId);if(row){const target=focusAction?[...row.querySelectorAll('button')].find(button=>button.dataset.action===focusAction&&button.dataset.versionId===focusVersion):row;if(target){if(target===row)row.tabIndex=-1;target.focus({preventScroll:true});}}}
  }
  function schedule(delay=2500,unknown=false) {
    clearTimeout(timer);if(stopped||paused)return;
    const deadlines=[...tasks.values()].filter(task=>active(task)&&Date.now()<=deadline(task)).map(deadline);
    if(deadlines.length)timer=setTimeout(()=>refresh(true),Math.min(delay,Math.max(1,Math.min(...deadlines)-Date.now()+1)));
    else if(unknown&&!tasks.size)timer=setTimeout(()=>refresh(true),delay);
  }
  async function refresh(automatic=false) {
    if(stopped||refreshing)return;refreshing=true;clearTimeout(timer);if(!automatic){failures=0;paused=false;for(const task of tasks.values()){watchStarted.set(task.requestId,Date.now());if(task.status==='SUCCEEDED'&&active(task))archiveWatchStarted.set(task.requestId,Date.now());}}if(refreshButton)refreshButton.disabled=true;
    try {
      const value=await request(endpoint);if(!Array.isArray(value.requests))throw Error('生成任务列表不完整，请稍后刷新');
      for(const item of value.requests){const task=accept(item);if(pending?.payload.mutationId===task.mutationId)onAccepted(task,pending);finishReady(task);}
      failures=0;paused=false;render();schedule();refreshChecks(!automatic);
    }catch(error){failures++;if(error.retryable&&failures<=4){message('暂时无法读取任务，正在重试（'+failures+'/4）');schedule(Math.min(20000,2500*2**(failures-1)),true);}else{paused=true;message(error.message+'。可手动刷新；已受理任务仍由服务器处理。');}render();}
    finally{refreshing=false;if(refreshButton)refreshButton.disabled=false;}
  }
  function mount() {
    const button=document.querySelector('[data-testid="agent-send-button"]');if(!button)return;
    if(!settings){
      settings=node('details','','np-generation-settings');settings.dataset.testid='product-generation-settings';settingsSummary=node('summary','图片 · 1:1 · 1K');settings.append(settingsSummary);
      const body=node('div','','np-generation-options');ratioSelect=node('select','');ratioSelect.setAttribute('aria-label','生成图片比例');for(const ratio of ratios)ratioSelect.add(new Option(ratio,ratio));
      resolutionSelect=node('select','');resolutionSelect.setAttribute('aria-label','生成图片分辨率');for(const tier of ['1K','2K'])resolutionSelect.add(new Option(tier,tier));
      frameControl=node('label','','np-generation-frame');frameControl.hidden=true;frameControl.dataset.testid='product-output-frame-control';frameControl.append(node('span','输出画框'));
      frameSelect=node('select','');frameSelect.setAttribute('aria-label','完整保留素材的输出画框');frameSelect.dataset.testid='product-output-frame';frameSelect.onchange=()=>{try{rememberFrame(frameSelect.value);}catch(error){message(error.message);}};
      frameNote=node('span','','np-generation-frame-note');frameControl.append(frameSelect,frameNote);
      body.append(ratioSelect,resolutionSelect,frameControl);settings.append(body);settings.addEventListener('pointerdown',event=>event.stopPropagation());
      const changed=()=>{try{const value=current();native.qualityActions.Mg('image',resolutionSelect.value);native.actions.rE(value.threadId,{novartGenerationSize:{ratioKey:ratioSelect.value,resolutionTier:resolutionSelect.value}});userRevision++;settingsSummary.textContent=(window.NovartProductWorkflowSnapshot?.()?.mode==='modify'?'改图 · ':'图片 · ')+ratioSelect.value+' · '+resolutionSelect.value;}catch(error){message(error.message);}};
      ratioSelect.onchange=changed;resolutionSelect.onchange=changed;
    }
    if(settings.parentElement!==button.parentElement)button.before(settings);
    mountWorkflowMode();
    const modifying=window.NovartProductWorkflowSnapshot?.()?.mode==='modify';
    try{const value=size(current().form);ratioSelect.value=value.ratioKey;resolutionSelect.value=value.resolutionTier;const title=(modifying?'改图 · ':'图片 · ')+value.ratioKey+' · '+value.resolutionTier;if(settingsSummary.textContent!==title)settingsSummary.textContent=title;}catch{}
    const disabled=context.readOnly||submitting;if(button.disabled!==disabled)button.disabled=disabled;
    if(ratioSelect.disabled!==disabled)ratioSelect.disabled=disabled;if(resolutionSelect.disabled!==disabled)resolutionSelect.disabled=disabled;
    try{if(!editorUnsubscribe)editorUnsubscribe=bridge().editor.store.listen(scheduleMount);mountOutputFrames();}catch{}
    const title=modifying?'修改图片':'生成图片';if(button.title!==title)button.title=title;
  }
  function start() {
    if(panel)return;
    const style=node('style','');style.textContent='.np-generations{position:fixed;z-index:690;right:18px;top:72px;width:min(330px,calc(100vw - 36px));max-height:52vh;overflow:auto;background:var(--color-lo-bg-neutral-l0,#fff);color:var(--color-lo-text-neutral-l1,#39333f);border:1px solid var(--color-lo-border-neutral-l1,#e8e5ee);border-radius:18px;box-shadow:0 6px 24px #2820390d;font:12px/1.5 system-ui}.np-generations[hidden]{display:none}.np-generations summary{padding:12px 14px;font-weight:600;cursor:pointer}.np-generation-body{padding:0 14px 12px}.np-generation-row{display:grid;gap:6px;padding:10px 0;border-top:1px solid var(--color-lo-border-neutral-l1,#e8e5ee)}.np-generation-prompt{margin:0;overflow-wrap:anywhere;max-height:5em;overflow:auto}.np-generation-note,.np-generation-status{color:var(--color-lo-text-neutral-l2,#756d7f)}.np-generations button,.np-generation-settings select{border:1px solid var(--color-lo-border-neutral-l1,#e8e5ee);border-radius:10px;padding:5px 10px;background:var(--color-lo-bg-neutral-l0,#fff);color:inherit;cursor:pointer}.np-generations button{justify-self:start}.np-generations button:disabled{opacity:.5;cursor:default}.np-generation-settings{position:relative;font:12px/1.5 system-ui;white-space:nowrap}.np-generation-settings summary{cursor:pointer;list-style:none;border-radius:12px;padding:6px 8px;background:var(--color-lo-bg-overlay,#f6f4f9)}.np-generation-frame{flex-basis:100%;display:grid;gap:5px;min-width:220px;max-width:min(290px,70vw)}.np-generation-frame[hidden]{display:none}.np-generation-frame select{min-width:0;max-width:100%}.np-generation-frame-note{font-size:11px;white-space:normal;color:var(--color-lo-text-neutral-l2,#756d7f)}.np-generation-options{flex-wrap:wrap;position:absolute;bottom:calc(100% + 8px);right:0;display:flex;gap:6px;padding:10px;border:1px solid var(--color-lo-border-neutral-l1,#e8e5ee);border-radius:14px;background:var(--color-lo-bg-neutral-l0,#fff);z-index:710}';document.head.append(style);
    panel=node('details','','np-generations');panel.dataset.testid='product-generation-tasks';panel.open=true;panel.hidden=true;panel.append(node('summary','图片任务'));
    const body=node('div','','np-generation-body');notice=node('p','','np-generation-note');notice.setAttribute('role','status');list=node('div','');refreshButton=node('button','刷新生成任务');refreshButton.type='button';refreshButton.onclick=()=>refresh();pendingPrompt=node('p','','np-generation-prompt');pendingButton=node('button','确认上一份受理');pendingButton.type='button';pendingButton.dataset.action='confirm-pending';pendingButton.onclick=confirmPending;pendingButton.hidden=true;pendingPrompt.hidden=true;body.append(notice,refreshButton,pendingPrompt,pendingButton,list);panel.append(body);document.body.append(panel);panel.addEventListener('pointerdown',event=>event.stopPropagation());
    try{const value=JSON.parse(sessionStorage.getItem(frameKey)||'null');if(value?.userId===context.user.id&&value.workspaceId===context.workspaceId&&value.projectId===projectId&&typeof value.pageId==='string'&&typeof value.frameId==='string'&&value.frameId.startsWith('shape:'))framePreference=value;}catch{}
    try{const value=JSON.parse(sessionStorage.getItem(retryKey)||'null');if(value?.payload?.projectId===projectId&&typeof value.payload.mutationId==='string'&&typeof value.signature==='string')pending=value;}catch{}
    try{bridge();unsubscribe=native.source.ow.subscribe(()=>queueMicrotask(mount));}catch{}
    mount();render();observer=new MutationObserver(mount);observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['disabled']});
    const availability=document.getElementById('novart-availability');if(availability){availability.textContent='图片生成 · 云端保存';availability.title='输入图片需求可提交生成任务；部分原生工具和在线协作尚未接入';}
    refresh();
  }
  async function focusTask(requestId) {
    if(stopped || !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId))throw Error('生成任务地址无效，请刷新任务');
    const value=await request(endpoint+'&requestId='+encodeURIComponent(requestId));
    if(stopped)throw Error('画布已关闭，请重新打开任务');
    if(value.requestId!==requestId)throw Error('生成任务回执不匹配，请刷新任务');
    const task=accept(value);tasks.delete(requestId);tasks.set(requestId,task);
    render();panel.hidden=false;panel.open=true;refreshChecks();
    const row=list.querySelector('[data-request-id="'+requestId+'"]');
    if(!row)throw Error('任务未能展开，请刷新任务');
    row.tabIndex=-1;row.focus({preventScroll:true});row.scrollIntoView({block:'nearest'});
    // Never finishReady/auto-insert when opening a notification.
    return true;
  }
  // Install capture handlers before the captured scripts to share one submit
  // path for clicks, Enter and the exported original submit boundaries.
  window.addEventListener('click',event=>{if(event.target.closest?.('[data-testid="agent-send-button"]')){event.preventDefault();event.stopImmediatePropagation();submitCurrent();}},true);
  window.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&!composing&&event.target.closest?.('[data-testid="agent-message-input"]')){event.preventDefault();event.stopImmediatePropagation();submitCurrent();}},true);
  window.addEventListener('beforeinput',event=>{if(event.target.closest?.('[data-testid="agent-message-input"]'))userRevision++;},true);
  window.addEventListener('compositionstart',event=>{if(event.target.closest?.('[data-testid="agent-message-input"]')){composing=true;userRevision++;}},true);
  window.addEventListener('compositionend',()=>{composing=false;},true);
  window.addEventListener('pagehide',()=>{stopped=true;checkEpoch++;for(const state of checks.values()){clearTimeout(state.timer);state.value=null;state.busy=false;}clearTimeout(timer);autoInsert.clear();observer?.disconnect();unsubscribe?.();editorUnsubscribe?.();editorUnsubscribe=undefined;});
  window.addEventListener('pageshow',event=>{if(event.persisted){stopped=false;mount();observer?.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['disabled']});if(native)unsubscribe=native.source.ow.subscribe(()=>queueMicrotask(mount));refresh();}});
  window.NovartProductGeneration=Object.freeze({start,submit,submitCurrent,focusTask,refresh:()=>refresh(),unsupported:()=>{message('此原生工具尚未接入，输入与画布仍保留；请从输入框提交图片生成');return false;}});
})();
