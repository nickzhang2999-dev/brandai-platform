/* Durable image uploads for the product build. The captured editor still owns
   image shapes, selection, undo and document saving. No browser blob is saved. */
(() => {
  'use strict';
  const context = window.__NOVART_PRODUCT__;
  const projectId = new URLSearchParams(location.search).get('projectId');
  if (!context || !projectId || location.pathname !== '/canvas') return;
  const tasks = new Map(), inserting = new Set();
  const terminal = new Set(['SUCCEEDED', 'FAILED']);
  let panel, list, notice, refreshButton, timer, stopped = false, refreshing = false;
  let refreshFailures = 0, pollingPaused = false;
  const MAX_TRANSIENT_RETRIES = 4;
  let native, sequence = 0;
  const endpoint = '/studio/material-upload?projectId=' + encodeURIComponent(projectId);
  const text = (tag, value, className) => {
    const node = document.createElement(tag); node.textContent = value;
    if (className) node.className = className;
    return node;
  };
  const message = value => { if (notice) { notice.textContent = value; panel.hidden = false; } };
  function getNative() {
    if (native?.editor?.store) return native;
    if (!document.querySelector('.tl-container, .tl-canvas')) throw Error('画布尚未就绪，请稍后重试');
    window.webpackChunk_lovartai_lovart_shell?.push([['novart-material-' + (++sequence)], {}, require => {
      if (![37750, 29543, 63470].every(id => typeof require.m?.[id] === 'function')) return;
      native = {editor: require(37750).pW.getEditor(), image: require(29543).getDefaultImageShape, userShape: require(63470).g5};
    }]);
    if (!native?.editor?.store || typeof native.image !== 'function' || typeof native.userShape !== 'function') throw Error('画布尚未就绪，请稍后重试');
    return native;
  }
  function canEdit() {
    const {editor} = getNative();
    if (context.readOnly || editor.getInstanceState().isReadonly) throw Error('当前项目仅可查看，无法上传或加入图片');
    return editor;
  }
  function safeMaterial(value) {
    if (!value || typeof value.assetId !== 'string' || !/^[a-f0-9]{64}$/.test(value.assetSha256 || '')
      || !['image/png', 'image/jpeg', 'image/webp'].includes(value.mimeType)
      || !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height) || value.width <= 0 || value.height <= 0
      || typeof value.url !== 'string') throw Error('图片回执不完整，请刷新任务');
    const url = new URL(value.url, location.origin);
    const expected = '/api/workspaces/' + encodeURIComponent(context.workspaceId) + '/assets/' + encodeURIComponent(value.assetId) + '/raw';
    if (url.origin !== location.origin || url.pathname !== expected || url.search || url.hash) throw Error('图片地址不属于当前品牌');
    return {...value, url: url.pathname};
  }
  function accept(value) {
    if (!value || value.projectId !== projectId || typeof value.taskId !== 'string'
      || !['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED'].includes(value.status)
      || !Number.isFinite(value.progress) || !Number.isFinite(Date.parse(value.expiresAt))) throw Error('上传任务回执不完整，请刷新任务');
    const task = {...value};
    if (task.status === 'SUCCEEDED') task.material = safeMaterial(task.material);
    tasks.set(task.taskId, task); return task;
  }
  async function request(url, init) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url, {...init, signal: controller.signal});
      let value;
      try { value = await response.json(); }
      catch {
        const error = Error('任务响应暂时无法读取，请刷新任务');
        error.retryable = response.status >= 500; throw error;
      }
      if (!response.ok) {
        const error = Error(value.error || value.msg || '任务暂时无法读取，请重试');
        error.retryable = response.status >= 500; throw error;
      }
      return value;
    } catch (error) {
      if (error.name === 'AbortError') {
        const timeout = Error('网络响应超时。已受理的任务会继续处理，可刷新任务查看');
        timeout.retryable = true; throw timeout;
      }
      if (error instanceof TypeError) error.retryable = true;
      throw error;
    } finally { clearTimeout(timeout); }
  }
  function existingShape(material) {
    const {editor} = getNative();
    return editor.getCurrentPageShapes().find(shape => {
      if (shape.type !== 'c-image' || typeof shape.props?.url !== 'string') return false;
      try { return new URL(shape.props.url, location.origin).href === new URL(material.url, location.origin).href; } catch { return false; }
    });
  }
  async function insert(task, point) {
    const editor = canEdit(), material = safeMaterial(task.material);
    const pageId = editor.getCurrentPageId();
    const existing = existingShape(material);
    if (existing) { editor.select(existing.id); return existing.id; }
    if (inserting.has(task.taskId)) return null;
    inserting.add(task.taskId); render();
    try {
      // Confirm authenticated bytes decode before adding a shape. This is a
      // normal same-origin image request, never an external vendor URL.
      await new Promise((resolve, reject) => {
        const image = new Image(), timeout = setTimeout(() => { image.src = ''; reject(Error('图片读取超时，可再次加入画布')); }, 20000);
        image.onload = () => { clearTimeout(timeout); image.naturalWidth > 0 ? resolve() : reject(Error('图片暂不可读')); };
        image.onerror = () => { clearTimeout(timeout); reject(Error('图片暂不可读，请检查存储后重试')); };
        image.src = material.url;
      });
      if (stopped) return null;
      canEdit();
      if (editor.getCurrentPageId() !== pageId) throw Error('画布页面已切换，图片仍在素材库，可在当前页面重新加入');
      const duplicate = existingShape(material);
      if (duplicate) return duplicate.id;
      const bounds = editor.getViewportPageBounds();
      const center = point && Number.isFinite(point.x) && Number.isFinite(point.y) ? point : {x:bounds.x + bounds.w / 2, y:bounds.y + bounds.h / 2};
      const scale = Math.min(1, 1024 / Math.max(material.width, material.height));
      const w = material.width * scale, h = material.height * scale;
      const baseId = 'shape:novart-upload-' + task.taskId;
      const id = editor.getShape(baseId) ? baseId + '-' + crypto.randomUUID() : baseId;
      const name = (material.fileName || '图片').replace(/\.[^.]+$/, '');
      const shape = native.image(id, {x:center.x - w / 2, y:center.y - h / 2, w, h}, material.url, name);
      shape.meta = {...shape.meta, novartAssetId:material.assetId, novartAssetSha256:material.assetSha256};
      editor.markHistoryStoppingPoint('insert-uploaded-image');
      editor.createShapes([native.userShape(shape, 'user')]);
      editor.select(id);
      message('图片已加入画布，保存状态见顶部');
      return id;
    } finally { inserting.delete(task.taskId); render(); }
  }
  function render() {
    if (!panel) return;
    list.replaceChildren();
    panel.hidden = !tasks.size && !notice.textContent;
    for (const task of [...tasks.values()].reverse().slice(0, 12)) {
      const row = text('div', '', 'np-upload-row'); row.dataset.taskId = task.taskId; row.dataset.status = task.status;
      row.append(text('span', task.material?.fileName || '图片上传', 'np-upload-name'));
      const overdue = !terminal.has(task.status) && Date.now() > Date.parse(task.expiresAt);
      const label = task.status === 'SUCCEEDED' ? '已存入素材库' : task.status === 'FAILED' ? (task.error || '上传失败，请重新选图')
        : overdue ? '任务超时，请刷新状态或重新选图'
        : pollingPaused ? '状态读取已暂停，请刷新任务确认结果'
        : (task.status === 'PENDING' ? '排队中' : '保存图片中') + ' · ' + Math.round(task.progress) + '%';
      row.append(text('span', label, 'np-upload-status'));
      if (task.status === 'SUCCEEDED' && !context.readOnly) {
        const button = text('button', '加入画布'); button.type = 'button'; button.dataset.action = 'insert';
        let present = false; try { present = Boolean(existingShape(task.material)); } catch { /* The editor may still mount. */ }
        button.textContent = inserting.has(task.taskId) ? '正在读取…' : present ? '定位图片' : '加入画布';
        button.disabled = inserting.has(task.taskId);
        button.onclick = () => insert(task).catch(error => message(error.message)); row.append(button);
      }
      if (task.status === 'FAILED' && !context.readOnly) {
        const retry = text('button', '重新选图重试'); retry.type = 'button'; retry.dataset.action = 'retry'; retry.onclick = pick;
        row.append(retry);
      }
      list.append(row);
    }
  }
  function schedule(delay = 2500, allowUnknown = false) {
    clearTimeout(timer);
    if (stopped || pollingPaused) return;
    const deadlines = [...tasks.values()].filter(task => !terminal.has(task.status) && Date.now() <= Date.parse(task.expiresAt)).map(task => Date.parse(task.expiresAt));
    // Wake once at the known server deadline so the UI never stays on an
    // eternal "processing" label. The client cannot extend a server TTL.
    if (deadlines.length) timer = setTimeout(() => refresh({automatic:true}), Math.min(delay, Math.max(1, Math.min(...deadlines) - Date.now() + 1)));
    else if (allowUnknown && !tasks.size) timer = setTimeout(() => refresh({automatic:true}), delay);
  }
  async function refresh({automatic = false} = {}) {
    if (stopped || refreshing) return;
    clearTimeout(timer);
    if (!automatic) { refreshFailures = 0; pollingPaused = false; }
    refreshing = true; if (refreshButton) refreshButton.disabled = true;
    try {
      const result = await request(endpoint);
      if (!Array.isArray(result.tasks)) throw Error('上传任务列表不完整，请稍后重试');
      for (const value of result.tasks) accept(value);
      if (refreshFailures || pollingPaused) message('任务状态已恢复');
      refreshFailures = 0; pollingPaused = false;
      render(); schedule();
    } catch (error) {
      refreshFailures += 1;
      if (error.retryable && refreshFailures <= MAX_TRANSIENT_RETRIES && !stopped) {
        message('网络暂时不稳定，正在重新读取任务状态（' + refreshFailures + '/' + MAX_TRANSIENT_RETRIES + '）');
        schedule(Math.min(20000, 2500 * 2 ** (refreshFailures - 1)), true);
      } else {
        pollingPaused = true;
        message(error.message + '。自动读取已暂停，可点击“刷新任务”；已受理的任务仍由服务器处理。');
      }
      render();
    }
    finally { refreshing = false; if (refreshButton) refreshButton.disabled = false; }
  }
  async function uploadAndInsert(files, point) {
    try {
      const pageId = canEdit().getCurrentPageId();
      if (files.length !== 1) throw Error('当前一次上传一张图片，请分别选择');
      const file = files[0];
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || !file.size || file.size > 10 * 1024 * 1024) throw Error('请选择 10 MB 以内的 PNG、JPEG 或 WebP 图片');
      message('正在提交图片…');
      const form = new FormData(); form.set('projectId', projectId); form.set('mutationId', crypto.randomUUID()); form.set('file', file, file.name || 'image.png');
      let accepted;
      try { accepted = await request(endpoint, {method:'POST', body:form}); }
      catch (error) {
        if (!error.retryable || stopped) throw error;
        message('正在确认上传回执…');
        // One bounded retry of exactly the same operation. A lost 202 must
        // never enqueue a second image using a freshly generated mutation ID.
        accepted = await request(endpoint, {method:'POST', body:form});
      }
      let task = accept(accepted);
      refreshFailures = 0; pollingPaused = false;
      message('图片已受理，关闭页面后仍会继续处理'); render(); schedule();
      let taskFailures = 0;
      while (!terminal.has(task.status) && !stopped) {
        if (Date.now() > Date.parse(task.expiresAt)) { message('处理时间较长，请刷新任务查看最终状态'); return []; }
        await new Promise(resolve => setTimeout(resolve, Math.min(12000, 1500 * 2 ** taskFailures)));
        if (stopped) return [];
        task = tasks.get(task.taskId) || task;
        if (terminal.has(task.status)) break;
        if (Date.now() > Date.parse(task.expiresAt)) { render(); return []; }
        try {
          task = accept(await request(endpoint + '&taskId=' + encodeURIComponent(task.taskId)));
          taskFailures = 0; render();
        } catch (error) {
          taskFailures += 1;
          if (!error.retryable || taskFailures > MAX_TRANSIENT_RETRIES) {
            // Keep the durable receipt and the list/manual recovery path.
            // Never re-submit the file with a new mutation on a polling error.
            message(error.message + '。任务已受理，可刷新任务后加入画布。');
            schedule(); return [];
          }
          message('网络暂时不稳定，正在确认图片处理结果（' + taskFailures + '/' + MAX_TRANSIENT_RETRIES + '）');
        }
      }
      if (task.status === 'FAILED') throw Error(task.error || '上传失败，请重新选图重试');
      if (stopped) return [];
      if (getNative().editor.getCurrentPageId() !== pageId) { message('图片已存入素材库，可在当前页面点击加入画布'); return []; }
      const id = await insert(task, point); return id ? [id] : [];
    } catch (error) { message(error.message); return []; }
  }
  function pick() {
    const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp';
    input.onchange = () => { if (input.files?.length) uploadAndInsert([...input.files]); }; input.click();
  }
  async function focusTask(taskId) {
    if (stopped || !/^[a-zA-Z0-9_-]{1,128}$/.test(taskId)) throw Error('上传任务地址无效，请刷新任务');
    const value = await request(endpoint + '&taskId=' + encodeURIComponent(taskId));
    if (stopped) throw Error('画布已关闭，请重新打开任务');
    if (value.taskId !== taskId) throw Error('上传任务回执不匹配，请刷新任务');
    const task = accept(value); tasks.delete(taskId); tasks.set(taskId, task);
    render(); panel.hidden = false; panel.open = true;
    const row = list.querySelector('[data-task-id="' + taskId + '"]');
    if (!row) throw Error('任务未能展开，请刷新任务');
    row.tabIndex = -1; row.focus({preventScroll:true}); row.scrollIntoView({block:'nearest'});
    // Opening a notification never calls insert or submits the upload again.
    return true;
  }
  function start() {
    if (panel) return;
    const style = document.createElement('style');
    style.textContent = '.np-uploads{position:fixed;z-index:700;top:72px;left:18px;width:min(300px,calc(100vw - 36px));max-height:min(50vh,440px);overflow:auto;border:1px solid var(--color-lo-border-neutral-l1,#e8e5ee);border-radius:18px;background:var(--color-lo-bg-neutral-l0,#fff);box-shadow:0 6px 24px #2820390d;color:var(--color-lo-text-neutral-l1,#39333f);font:12px/1.5 system-ui}.np-uploads[hidden]{display:none}.np-uploads summary{padding:12px 14px;cursor:pointer;font-weight:600}.np-upload-body{padding:0 14px 12px}.np-upload-row{display:grid;gap:5px;padding:10px 0;border-top:1px solid #eceaf1}.np-upload-name{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.np-upload-status,.np-upload-note{color:#756d7f;overflow-wrap:anywhere}.np-uploads button{justify-self:start;border:1px solid #e4dfeb;border-radius:10px;background:#f7f5fc;color:inherit;padding:5px 10px;cursor:pointer}.np-uploads button:disabled{opacity:.5;cursor:default}.np-upload-note{margin:0 0 8px}.np-upload-tools{display:flex;gap:8px}';
    document.head.append(style);
    panel = document.createElement('details'); panel.className = 'np-uploads'; panel.dataset.testid = 'product-upload-tasks'; panel.open = true; panel.hidden = true;
    panel.append(text('summary', '图片上传'));
    const body = text('div', '', 'np-upload-body'); notice = text('p', '', 'np-upload-note'); notice.setAttribute('role', 'status');
    list = document.createElement('div'); list.dataset.testid = 'product-upload-list';
    const tools = text('div', '', 'np-upload-tools'); refreshButton = text('button', '刷新任务'); refreshButton.type = 'button'; refreshButton.onclick = () => refresh(); tools.append(refreshButton);
    body.append(notice, tools, list); panel.append(body); document.body.append(panel);
    panel.addEventListener('pointerdown', event => event.stopPropagation());
    refresh();
  }
  window.addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); });
  window.addEventListener('pageshow', event => { if (event.persisted) { stopped = false; refresh(); } });
  window.NovartProductMaterials = Object.freeze({start, uploadAndInsert, refresh, focusTask});
})();
