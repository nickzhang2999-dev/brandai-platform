/* M25 image editing shell. The original editor remains inside persistent, same-origin frames. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const clone = value => JSON.parse(JSON.stringify(value));
  const textLength = value => Array.from(value).length;
  const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const icon = name => { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', '#ns-icon-' + name); svg.setAttribute('aria-hidden', 'true'); svg.append(use); return svg; };
  const button = (text, cls, fn) => { const b = node('button', cls, text); b.type = 'button'; if (fn) b.addEventListener('click', fn); return b; };
  const storage = {get(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }, set(key, value) { try { localStorage.setItem(key, value); return true; } catch (_) { return false; } }, remove(key) { try { localStorage.removeItem(key); } catch (_) {} }};
  const defaults = {revision: 0, profile: {nickname: 'Nine', density: 'comfortable', motion: 'system'}, brand: {name: '', colors: ['#8B77B5', '#171717', '#F5F3FA'], font: 'system', notes: ''}, favorites: []};
  const draftKey = 'novart-m24-state-draft', briefKey = 'novart-m24-home-brief';
  let savedState = clone(defaults), profileDraft = clone(defaults.profile), brandDraft = clone(defaults.brand), favoriteDraft = [];
  let metaLoaded = false, metaBusy = false, metaConflict = false, profileDirty = false, brandDirty = false, favoritesDirty = false, stateLoading = false;
  let metaUncertain = false, draftStorageFailed = false, savingGroup = '';
  const groupErrors = {profile: '', brand: '', favorites: ''};
  let projects = [], projectsLoaded = false, projectsBusy = false, projectsError = '', projectsRequest = null;
  let createBusy = false, homeComposing = false, recoveryRecord = null, recoveryWarning = '', activeId = '', lastWorkspaceId = '', route = {page: 'home'}, previousRoute = '/home', settingsOrigin = '/home', brandOrigin = '/resources';
  let favoriteFilter = false, resourceTab = 'images', resourceProject = '', resourceGeneration = 0, resourcesBusy = false, resourcesError = '', previewSource = '', toastTimer = 0;
  const frames = new Map(), assetCache = new Map(), pageScroll = new Map();
  const resourceRows = new Map(), workspaceOrigins = new Map();
  let previewFocus = null, libraryReturnFocus = null, pendingResourceScroll = null;
  const resourceViewKey = () => '/resources/' + resourceTab + '/' + resourceProject;
  const pageViewKey = () => route.page === 'resources' ? resourceViewKey() : routePath();
  // Returning is a one-shot convenience. A newer gesture always wins over an
  // outstanding list response, including keyboard navigation and scrollbar use.
  function cancelResourceReturn() { pendingResourceScroll = null; libraryReturnFocus = null; }
  const resourcePage = document.querySelector('section[data-page="resources"]');
  ['pointerdown', 'wheel', 'touchstart', 'keydown'].forEach(type => {
    resourcePage.addEventListener(type, cancelResourceReturn, {capture: true, passive: true});
  });
  function cardFocus(element = document.activeElement) {
    const card = element?.closest('.ns-project-card,.ns-asset-card');
    if (!card) return null;
    return {container: card.parentElement.id, project: card.dataset.projectId, sha: card.dataset.assetSha256 || '', shape: card.dataset.shapeId || '', action: element.dataset.action, index: [...card.parentElement.children].indexOf(card)};
  }
  function restoreCardFocus(key, fallback = false) {
    if (!key) return;
    const container = $(key.container); if (!container || container.closest('[hidden]')) return;
    const cards = [...container.children];
    const card = cards.find(c => c.dataset.projectId === key.project && (c.dataset.assetSha256 || '') === key.sha && (c.dataset.shapeId || '') === key.shape);
    const target = card?.querySelector('[data-action="' + key.action + '"]') || (fallback && (cards[Math.min(key.index, cards.length - 1)]?.querySelector('[data-action="' + key.action + '"]') || $('ns-project-favorites')));
    target?.focus({preventScroll: true});
  }
  function restoreResourceScroll(scope) {
    if (route.page !== 'resources' || resourceTab !== 'images' || resourceProject !== scope) return;
    if (pendingResourceScroll?.key === resourceViewKey()) {
      document.querySelector('section[data-page="resources"]').scrollTop = pendingResourceScroll.top;
      pendingResourceScroll = null;
    }
    if (libraryReturnFocus) { restoreCardFocus(libraryReturnFocus); libraryReturnFocus = null; }
  }
  function updateWorkspaceReturn(entry) {
    const back = frameDocument(entry)?.doc.querySelector('#novart-bar .nv-back'); if (!back) return;
    const path = workspaceOrigins.get(entry.id)?.path || '/projects';
    const label = path === '/resources' ? '返回素材库' : path === '/home' ? '返回首页' : '返回项目库';
    back.href = '/studio#' + path; back.title = label + '，保留当前画布会话'; back.setAttribute('aria-label', label);
  }
  let resourceViewScope = null, previewRequest = 0;
  const recoveryKey = 'novart-m24-create-recovery';
  const uncertainCreateKey = 'novart-m24-create-uncertain';
  let createUncertain = false, uncertainListChecked = false;
  let focusReturnIntent = null, routeVersion = 0, recoveryCheck = null, recoveryDecisionBusy = false;
  const starters = [
    {number: '01 / POSTER', name: '一张清楚的海报', description: '把主体、标题和行动信息放到合适的位置。', prompt: '为一次活动设计一张海报。主题是【填写活动主题】，面向【填写目标人群】。请突出主视觉，建立清晰的标题和信息层级，预留时间、地点和报名方式的位置。'},
    {number: '02 / SOCIAL', name: '有系列感的封面', description: '一套能继续生长的视觉，而不是孤立的一张图。', prompt: '设计一组社交媒体封面，主题是【填写主题】。使用统一的版式、字体和配色，让每一期的标题容易替换；在统一中保留少量变化，适合手机浏览。'},
    {number: '03 / PRODUCT', name: '让产品成为主角', description: '突出真实产品，把背景和氛围控制得刚刚好。', prompt: '为【填写产品名称】设计一张产品展示图。保留真实产品的主体与比例，以【填写场景】为背景。让光线和配色服务于产品，预留简洁的卖点文字区域。'},
    {number: '04 / IDENTITY', name: '品牌的第一印象', description: '先梳理气质、受众和场景，再进入视觉。', prompt: '为【填写品牌名称】梳理视觉方向。品牌面向【填写受众】，希望传达【填写三种气质】。请规划适合的配色、字体和版式方向，并考虑封面、海报和社交媒体中的一致性。'},
    {number: '05 / PRESENTATION', name: '把内容讲明白', description: '给复杂信息留出呼吸，建立明确的阅读顺序。', prompt: '设计一页用于展示【填写内容】的视觉版式。主结论是【填写结论】。请使用明确的阅读顺序，减少无关装饰，给标题、核心数据和解释文字留出足够空间。'},
    {number: '06 / FREEFORM', name: '先抓住一种感觉', description: '用具体的场景、颜色和材质描述脑中的画面。', prompt: '我想探索一种视觉氛围：场景是【填写场景】，主要颜色是【填写颜色】，材质偏向【填写材质】，想传达【填写情绪】。请围绕这几个关键词组织主体与留白。'}
  ];

  async function api(url, payload) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url, {signal: controller.signal, cache: 'no-store', ...(payload === undefined ? {} : {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)})});
      let value; try { value = await response.json(); } catch (_) { throw new Error('本地服务返回了无法读取的内容。'); }
      if (!response.ok) { const error = new Error(value.error || value.msg || '本地服务暂不可读。'); error.status = response.status; error.result = value; throw error; }
      return value;
    } catch (error) {
      if (error.name === 'AbortError') { const timed = new Error(payload === undefined ? '读取超时，请稍后重试。' : '保存结果未确认，请先核对已保存内容。'); timed.uncertain = payload !== undefined; throw timed; }
      // A lost connection or unreadable response may arrive after a write landed.
      if (payload !== undefined && !Number.isInteger(error.status)) error.uncertain = true;
      if (error instanceof TypeError) error.message = payload === undefined ? '暂时无法连接本地服务，请确认预览窗口仍在运行后重试。' : '连接中断，保存结果尚未确认。';
      throw error;
    }
    finally { clearTimeout(timer); }
  }
  function notify(message) { clearTimeout(toastTimer); $('ns-toast').textContent = message; $('ns-toast').hidden = false; toastTimer = setTimeout(() => { $('ns-toast').hidden = true; }, 4800); }
  function feedback(id, message, state = 'idle') { const target = $(id); target.textContent = message; target.dataset.state = state; }
  function empty(target, message, action, actionLabel, actionId) { const box = node('div', 'ns-empty'); box.append(icon('canvas'), node('p', '', message)); if (action) { const b = button(actionLabel || '重试', 'ns-secondary', action); if (actionId) b.id = actionId; box.append(b); } target.replaceChildren(box); }
  function dateText(value) { const d = new Date(value); if (!Number.isFinite(d.getTime())) return '更新时间未提供'; return d.toLocaleDateString('zh-CN', {month: '2-digit', day: '2-digit'}) + ' ' + d.toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit', hour12: false}); }
  const updated = p => new Date(p.updatedAt).getTime() || 0;
  const project = id => projects.find(p => p.projectId === id);
  const routePath = () => route.page === 'workspace' ? '/workspace/' + encodeURIComponent(route.projectId) : '/' + route.page;
  const studioURL = (id, panel) => '/studio' + (panel ? '?panel=' + encodeURIComponent(panel) : '') + '#/workspace/' + encodeURIComponent(id);
  function parseRoute() { const text = location.hash.slice(1) || '/home'; if (/^\/(home|projects|resources|brand|settings)$/.test(text)) return {page: text.slice(1)}; const match = text.match(/^\/workspace\/([^/]+)$/); if (match) { try { const id = decodeURIComponent(match[1]); if (/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return {page: 'workspace', projectId: id}; } catch (_) {} } return {page: 'home'}; }
  const navigationKey = 'novart-m24-navigation', navigationStateKey = 'novartM24Navigation';
  let navigationSession = '', navigationIndex = 0, navigationMax = 0, lastActivatedPath = '';
  const currentPath = () => location.hash.slice(1) || '/home';
  function navigationButtons() { $('ns-back').disabled = navigationIndex <= 0; $('ns-forward').disabled = navigationIndex >= navigationMax; }
  function rememberNavigation() { try { sessionStorage.setItem(navigationKey, JSON.stringify({session: navigationSession, maximum: navigationMax})); } catch (_) {} navigationButtons(); }
  function markNavigation(replace = true) {
    const previous = history.state && typeof history.state === 'object' ? history.state : {};
    const state = {...previous, [navigationStateKey]: {session: navigationSession, index: navigationIndex, route: currentPath()}};
    if (replace) history.replaceState(state, '', location.href);
    rememberNavigation();
  }
  function initializeNavigation() {
    let record = null; try { record = JSON.parse(sessionStorage.getItem(navigationKey) || 'null'); } catch (_) {}
    const marker = history.state?.[navigationStateKey];
    if (record && marker && typeof record.session === 'string' && marker.session === record.session && marker.route === currentPath() && Number.isInteger(marker.index) && marker.index >= 0 && Number.isInteger(record.maximum) && record.maximum >= marker.index) {
      navigationSession = record.session; navigationIndex = marker.index; navigationMax = record.maximum;
    } else { navigationSession = crypto.randomUUID(); navigationIndex = 0; navigationMax = 0; markNavigation(); }
    navigationButtons();
  }
  function go(path, preserveFormOrigins = false) {
    if (currentPath() === path) { activateRoute(); lastActivatedPath = path; return; }
    navigationIndex += 1; navigationMax = navigationIndex;
    const previous = history.state && typeof history.state === 'object' ? history.state : {};
    history.pushState({...previous, [navigationStateKey]: {session: navigationSession, index: navigationIndex, route: path, formOrigins: preserveFormOrigins ? {settings: settingsOrigin, brand: brandOrigin} : null}}, '', location.pathname + location.search + '#' + path);
    rememberNavigation(); activateRoute(); lastActivatedPath = path;
  }
  function onNavigation() {
    const marker = history.state?.[navigationStateKey];
    if (marker && marker.session === navigationSession && marker.route === currentPath() && Number.isInteger(marker.index) && marker.index >= 0 && marker.index <= navigationMax) navigationIndex = marker.index;
    else { navigationSession = crypto.randomUUID(); navigationIndex = 0; navigationMax = 0; markNavigation(); }
    navigationButtons(); if (lastActivatedPath !== currentPath()) { activateRoute(); lastActivatedPath = currentPath(); }
  }
  document.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element ? event.target.closest('a') : null;
    if (!anchor || anchor.hasAttribute('download') || anchor.target && anchor.target !== '_self') return;
    const url = new URL(anchor.href, location.href), path = url.hash.slice(1);
    if (url.origin !== location.origin || url.pathname !== location.pathname || url.search !== location.search || !/^\/(home|projects|resources|brand|settings)$/.test(path) && !/^\/workspace\/[a-zA-Z0-9_-]{1,128}$/.test(path)) return;
    event.preventDefault();
    if (anchor.id === 'ns-current-workspace' && routePath() !== path) returnToOrigin(path);
    else if (anchor.id === 'ns-current-workspace') focusReturnIntent = null;
    else go(path);
  });
  function rememberPageScroll() { const section = document.querySelector('section[data-page="' + route.page + '"]'); if (section) pageScroll.set(pageViewKey(), section.scrollTop); }
  function frameDocument(entry) {
    try {
      const win = entry.frame.contentWindow, doc = entry.frame.contentDocument;
      if (!doc || win.location.origin !== location.origin || new URL(win.location.href).searchParams.get('projectId') !== entry.id) return null;
      return {win, doc};
    } catch (_) { return null; }
  }
  function inputSnapshot(entry, field) {
    const context = frameDocument(entry); if (!context) return null;
    const {win, doc} = context;
    if (field instanceof win.Element) field = field.closest('[data-testid="agent-message-input"]') || field;
    if (field instanceof win.Element && field.matches('[data-testid="agent-message-input"][contenteditable="true"]')) {
      if (!field.isConnected || field.ownerDocument !== doc) return null;
      const selection = win.getSelection();
      const inside = selection?.rangeCount && field.contains(selection.anchorNode) && field.contains(selection.focusNode);
      return {kind:'chat',field,doc,anchor:inside ? selection.anchorNode : null,anchorOffset:inside ? selection.anchorOffset : 0,
        focus:inside ? selection.focusNode : null,focusOffset:inside ? selection.focusOffset : 0,scrollTop:field.scrollTop};
    }
    if (!(field instanceof win.HTMLTextAreaElement) && !(field instanceof win.HTMLInputElement)) return null;
    if (!field.isConnected || field.ownerDocument !== doc || field.disabled || field.readOnly || typeof field.selectionStart !== 'number' || typeof field.selectionEnd !== 'number') return null;
    return {kind:'field',field,doc,start:field.selectionStart,end:field.selectionEnd,direction:field.selectionDirection || 'none'};
  }
  function trackWorkspaceInput(entry) {
    const context = frameDocument(entry); if (!context || entry.focusDocument === context.doc) return;
    entry.focusCleanup?.(); const {win, doc} = context; entry.focusDocument = doc;
    const track = event => {
      if (activeId !== entry.id || entry.slot.inert) return;
      if (event.type === 'pointerdown' && event.isTrusted && focusReturnIntent?.entry === entry) focusReturnIntent = null;
      if (event.type === 'pointerdown' && !inputSnapshot(entry, event.target)) { entry.liveInput = null; return; }
      const record = inputSnapshot(entry, doc.activeElement);
      if (record) entry.liveInput = record;
      else if (event.type === 'focusin') entry.liveInput = null;
    };
    const cleanup = () => {
      ['focusin', 'focusout', 'pointerdown', 'select', 'input', 'selectionchange'].forEach(type => doc.removeEventListener(type, track, true));
      win.removeEventListener('pagehide', cleanup); entry.focusDocument = null; entry.liveInput = null;
    };
    ['focusin', 'focusout', 'pointerdown', 'select', 'input', 'selectionchange'].forEach(type => doc.addEventListener(type, track, true));
    win.addEventListener('pagehide', cleanup, {once: true}); entry.focusCleanup = cleanup;
    track({type: 'initial'});
  }
  function rememberWorkspaceInput(entry) {
    if (!entry || !entry.ready || entry.slot.inert) return;
    const context = frameDocument(entry); if (!context) return;
    const current = inputSnapshot(entry, context.doc.activeElement);
    entry.returnInput = current || entry.liveInput || null;
  }
  function restoreWorkspaceInput(entry) {
    const intent = focusReturnIntent;
    if (!intent || intent.entry !== entry || !entry.ready) return;
    if (entry.pendingPanel || pendingPanels.has(entry.id)) { focusReturnIntent = null; return; }
    requestAnimationFrame(() => {
      if (focusReturnIntent !== intent) return; focusReturnIntent = null;
      if (frames.get(entry.id) !== entry || activeId !== entry.id || route.page !== 'workspace' || route.projectId !== entry.id || entry.slot.inert || entry.slot.dataset.active !== 'true' || entry.pendingPanel || pendingPanels.has(entry.id)) return;
      const context = frameDocument(entry), record = intent.record;
      if (!context || record.doc !== context.doc || !inputSnapshot(entry, record.field) || record.field.closest('[hidden],[inert]')) return;
      const rect = record.field.getBoundingClientRect(), style = context.win.getComputedStyle(record.field), frameStyle = getComputedStyle(entry.frame);
      if (rect.width < 1 || rect.height < 1 || style.display === 'none' || style.visibility !== 'visible' || frameStyle.display === 'none' || frameStyle.visibility !== 'visible') return;
      record.field.focus({preventScroll:true});
      if (record.kind === 'chat') {
        const selection = context.win.getSelection();
        if (record.anchor?.isConnected && record.focus?.isConnected && record.field.contains(record.anchor) && record.field.contains(record.focus)
          && record.anchorOffset <= (record.anchor.nodeType === 3 ? record.anchor.length : record.anchor.childNodes.length)
          && record.focusOffset <= (record.focus.nodeType === 3 ? record.focus.length : record.focus.childNodes.length)) {
          selection.setBaseAndExtent(record.anchor,record.anchorOffset,record.focus,record.focusOffset);
        }
        record.field.scrollTop = record.scrollTop;
      } else record.field.setSelectionRange(record.start,record.end,record.direction);
    });
  }
  function returnToOrigin(path) {
    focusReturnIntent = null;
    const match = path.match(/^\/workspace\/([^/]+)$/);
    if (match) {
      const entry = frames.get(decodeURIComponent(match[1]));
      if (entry?.returnInput) focusReturnIntent = {entry, record: entry.returnInput};
    }
    go(path, true);
  }
  function prefsToFrame(entry) { if (entry.ready) entry.frame.contentWindow.postMessage({type: 'nv-studio', action: 'preferences', projectId: entry.id, motion: profileDraft.motion}, location.origin); }
  function applyProfile() {
    document.body.dataset.density = profileDraft.density;
    document.body.dataset.motion = profileDraft.motion;
    const name = profileDraft.nickname.trim() || 'Nine';
    $('ns-settings-avatar').textContent = Array.from(name)[0].toUpperCase(); $('ns-profile-label').textContent = name; $('ns-avatar').textContent = Array.from(name)[0].toUpperCase(); $('ns-greeting').textContent = '你好，' + name;
    frames.forEach(prefsToFrame);
  }
  function cacheFull(id, panel) {
    const url = studioURL(id, panel);
    const status = $('ns-workspace-status'); status.replaceChildren(node('div', '', '这个窗口已保留 3 张画布。为保留每份未保存的编辑，请在新标签继续这个项目。'));
    const link = node('a', 'ns-primary', '在新标签打开此项目'); link.href = url; link.target = '_blank'; link.rel = 'noopener'; link.dataset.testid = 'studio-cache-open-tab'; status.append(link, button('返回项目库', 'ns-secondary', () => go('/projects')));
  }
  function openProject(id, panel) {
    if (!id) return;
    focusReturnIntent = null;
    if (!frames.has(id) && frames.size >= 3) {
      if (panel) pendingPanels.set(id, panel);
      go('/workspace/' + encodeURIComponent(id));
      notify('已保留 3 张画布会话。点击页面中的新标签入口，继续第 4 个项目。');
      return;
    }
    if (panel) { const cached = frames.get(id); if (cached) cached.pendingPanel = panel; else pendingPanels.set(id, panel); }
    go('/workspace/' + encodeURIComponent(id));
  }
  let libraryScope = 'active', archiveBusy = false, archiveTarget = null;
  const projectEvent = typeof BroadcastChannel === 'function' ? new BroadcastChannel('novart-project-library') : null;
  function addProjectActions(card, p) {
    const details = node('details', 'pl-more'), summary = node('summary', '', '···');
    summary.setAttribute('aria-label', '更多操作：' + (p.projectName || '未命名项目'));
    details.addEventListener('toggle', () => { if (details.open) document.querySelectorAll('.pl-more[open]').forEach(other => { if (other !== details) other.open = false; }); });
    const menu = node('div', 'pl-more-menu'), action = button(p.archivedAt ? '恢复项目' : '归档项目', '', () => { details.open = false; p.archivedAt ? changeArchive(p, false) : confirmArchive(p); });
    action.dataset.action = p.archivedAt ? 'restore-project' : 'archive-project'; action.disabled = archiveBusy;
    menu.append(action); details.append(summary, menu); card.append(details);
  }
  function showArchivedProject(id) {
    const p = project(id); if (!p) return;
    frames.forEach(entry => { entry.slot.dataset.active = 'false'; entry.slot.style.visibility = 'hidden'; entry.slot.inert = true; entry.frame.setAttribute('aria-hidden', 'true'); });
    activeId = ''; $('ns-current-workspace').hidden = lastWorkspaceId === id;
    const panel = node('div', 'pl-archive-view'); panel.dataset.testid = 'archived-project-view';
    panel.append(node('span', 'pl-archive-label', '已归档'), node('h2', '', p.projectName || '未命名项目'), node('p', '', '画布、需求和素材仍在。恢复项目后，就能从这里继续创作。'));
    const actions = node('div', 'pl-archive-actions'), restore = button('恢复并继续创作', 'ns-primary', () => changeArchive(p, false, true)); restore.disabled = archiveBusy; restore.dataset.testid = 'restore-and-open';
    actions.append(restore, button('查看项目素材', 'ns-secondary', () => { resourceProject = id; resourceTab = 'images'; go('/resources'); }));
    panel.append(actions, button('返回项目库', 'ns-text-button pl-back', () => { libraryScope = 'archived'; go('/projects'); }));
    $('ns-workspace-status').replaceChildren(panel);
  }
  const stableRecord = value => JSON.stringify(value, function(key, item) { return item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(k => [k, item[k]])) : item; });
  async function prepareArchive(p) {
    const native = await api('/api/canva/project/queryProject', {projectId:p.projectId});
    if (native.code !== 0 || native.data?.projectId !== p.projectId) throw new Error('项目暂不可读，请刷新后重试。');
    const entry = frames.get(p.projectId);
    if (entry) {
      const ctx = frameDocument(entry), win = ctx?.win, doc = ctx?.doc;
      if (!entry.ready || !win || !doc) throw new Error('画布还在加载，请稍后再归档。');
      const draft = win.NovartM24Draft?.snapshot();
      if (!draft?.loaded || draft.busy || draft.restoring || !['saved','empty'].includes(draft.state)) throw new Error('对话草稿还没有保存好，请返回工作台确认后再归档。');
      const savedContext = await api('/compare/api/context?projectId=' + encodeURIComponent(p.projectId));
      if (doc.getElementById('nv-brief')?.value !== savedContext.brief || doc.getElementById('nv-notes')?.value !== savedContext.notes) throw new Error('需求中还有未保存的修改，请先保存需求再归档。');
      if (win.localStorage.getItem('novart-m6-workflow:' + p.projectId)) throw new Error('素材设置还有未保存的修改，请先保存设置再归档。');
      // Use the original editor's public read-only snapshot. No editor mutation.
      let imageApp;
      win.webpackChunk_lovartai_lovart_shell.push([['novart-archive-check-' + Date.now()], {}, require => { imageApp = require(37750).pW; }]);
      const snapshot = imageApp?.getEditor()?.getSnapshot()?.document;
      if (!snapshot) throw new Error('暂时无法确认画布保存状态，请稍后再试。');
      if (native.data.canvas) {
        const raw = Uint8Array.from(atob(native.data.canvas.replace('SHAKKERDATA://','')), c => c.charCodeAt(0));
        const decoded = JSON.parse(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'))).text());
        if (stableRecord(snapshot) !== stableRecord(decoded.tldrawSnapshot?.document)) throw new Error('画布仍有编辑等待自动保存，请稍后再归档。');
      } else if (Object.values(snapshot.store || {}).some(record => record.typeName === 'shape')) throw new Error('画布仍在首次保存，请稍后再归档。');
    }
    return native.data.version;
  }
  function confirmArchive(p) {
    if (archiveBusy) return;
    archiveTarget = p; $('pl-confirm-name').textContent = p.projectName || '未命名项目'; $('pl-confirm-status').textContent = '';
    $('pl-confirm').showModal(); $('pl-confirm-back').focus();
  }
  async function changeArchive(p, archived, openAfter = false) {
    if (archiveBusy) return;
    archiveBusy = true; $('pl-confirm-submit').disabled = true; $('pl-confirm-back').disabled = true; $('pl-confirm-close').disabled = true;
    $('pl-confirm-status').textContent = archived ? '正在确认内容已保存…' : ''; renderProjects();
    try {
      const version = archived ? await prepareArchive(p) : p.version;
      const result = await api('/studio/project-archive', {projectId:p.projectId, archived, revision:p.archiveRevision || 0, projectVersion:version});
      const current = project(p.projectId); if (current) Object.assign(current, result);
      if ($('pl-confirm').open) $('pl-confirm').close();
      projectEvent?.postMessage({projectId:p.projectId});
      await loadProjects(true);
      notify(archived ? '项目已归档，内容完整保留。' : '项目已恢复，可以继续创作。');
      if (archived) { const undo = button('撤回', 'pl-undo', () => changeArchive(project(p.projectId), false)); undo.dataset.testid = 'undo-archive'; $('ns-toast').append(undo); clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('ns-toast').hidden = true; }, 8000); }
      if (route.page === 'workspace' && route.projectId === p.projectId) await ensureWorkspace(p.projectId);
      if (openAfter) openProject(p.projectId);
    } catch (error) {
      if (error.status === 409 || error.uncertain) await loadProjects(true);
      const message = error.uncertain ? '操作结果尚未确认，请刷新项目列表核对后再试。' : error.message;
      $('pl-confirm-status').textContent = message; if (!$('pl-confirm').open) notify(message);
    } finally {
      archiveBusy = false; $('pl-confirm-submit').disabled = false; $('pl-confirm-back').disabled = false; $('pl-confirm-close').disabled = false; renderProjects();
      if (route.page === 'workspace' && project(route.projectId)?.archivedAt) showArchivedProject(route.projectId);
    }
  }
  $('pl-confirm-submit').addEventListener('click', () => { if (archiveTarget) changeArchive(archiveTarget, true); });
  ['pl-confirm-back','pl-confirm-close'].forEach(id => $(id).addEventListener('click', () => { if (!archiveBusy) $('pl-confirm').close(); }));
  $('pl-confirm').addEventListener('cancel', event => { if (archiveBusy) event.preventDefault(); });
  ['active','archived'].forEach(scope => {
    const tab = $('pl-' + scope);
    tab.addEventListener('click', () => { libraryScope = scope; renderProjects(); tab.focus(); });
    tab.addEventListener('keydown', event => { if (['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) { event.preventDefault(); $('pl-' + (event.key === 'Home' ? 'active' : event.key === 'End' ? 'archived' : scope === 'active' ? 'archived' : 'active')).click(); } });
  });
  document.addEventListener('click', event => { document.querySelectorAll('.pl-more[open]').forEach(menu => { if (!menu.contains(event.target)) menu.open = false; }); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') document.querySelectorAll('.pl-more[open]').forEach(menu => { menu.open = false; menu.querySelector('summary').focus(); }); });
  async function refreshProjectLifecycle() {
    if (archiveBusy) return;
    await loadProjects(true);
    if (route.page === 'workspace' && project(route.projectId)?.archivedAt) showArchivedProject(route.projectId);
  }
  projectEvent?.addEventListener('message', refreshProjectLifecycle);
  window.addEventListener('focus', refreshProjectLifecycle);
  const pendingPanels = new Map();
  function panelCommand(entry) {
    if (entry.pendingPanel && focusReturnIntent?.entry === entry) focusReturnIntent = null;
    if (!entry.ready || !entry.pendingPanel || activeId !== entry.id) return;
    if (entry.pendingPanel !== 'upload') {
      entry.frame.contentWindow.postMessage({type: 'nv-studio', action: 'open-panel', projectId: entry.id, panel: entry.pendingPanel}, location.origin); entry.pendingPanel = ''; return;
    }
    if (entry.uploadTask) return;
    const current = () => frames.get(entry.id) === entry && entry.ready && activeId === entry.id && route.page === 'workspace' && route.projectId === entry.id && entry.pendingPanel === 'upload' && !entry.slot.inert && entry.slot.dataset.active === 'true';
    if (!current()) return;
    entry.uploadTask = new Promise(resolve => {
      let win, doc, observer, slotObserver, timer = 0, settled = false, triggered = false;
      const cancel = () => finish('cancelled');
      function finish(result) {
        if (settled) return; settled = true; clearTimeout(timer); observer?.disconnect(); slotObserver?.disconnect();
        try { win?.removeEventListener('pagehide', cancel); } catch (_) {} window.removeEventListener('pagehide', cancel);
        if (result === 'opened' && current()) entry.pendingPanel = '';
        else if (result === 'unavailable' && current()) notify('原画布的上传菜单暂未展开，请再次点击上传重试。');
        resolve(result);
      }
      function inspect() {
        if (settled) return;
        if (!current()) return finish('cancelled');
        try {
          if (win.location.origin !== location.origin || new URL(win.location.href).searchParams.get('projectId') !== entry.id || entry.frame.contentDocument !== doc) return finish('cancelled');
          const visible = element => { if (!element || element.closest('[hidden],[inert]')) return false; const r = element.getBoundingClientRect(), style = win.getComputedStyle(element); return r.width > 1 && r.height > 1 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0; };
          const menu = doc.querySelector('[data-testid="upload-menu-content"]');
          if (visible(menu)) return finish('opened');
          const control = doc.querySelector('[data-testid="nav-upload-menu-button"]'), trigger = doc.querySelector('[data-testid="upload-menu-trigger"]');
          if (triggered || !visible(control) || !visible(trigger) || control.disabled) return;
          const rect = control.getBoundingClientRect(); triggered = true;
          trigger.dispatchEvent(new win.PointerEvent('pointerover', {bubbles: true, cancelable: true, view: win, pointerType: 'mouse', isPrimary: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, relatedTarget: null}));
          clearTimeout(timer); timer = setTimeout(() => { inspect(); if (!settled) finish('unavailable'); }, 1000);
        } catch (_) { finish('unavailable'); }
      }
      try {
        win = entry.frame.contentWindow; doc = entry.frame.contentDocument;
        if (!doc || win.location.origin !== location.origin || new URL(win.location.href).searchParams.get('projectId') !== entry.id) return finish('cancelled');
        observer = new win.MutationObserver(inspect); observer.observe(doc.documentElement, {subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'inert', 'data-state']});
        slotObserver = new MutationObserver(inspect); slotObserver.observe(entry.slot, {attributes: true, attributeFilter: ['inert', 'data-active', 'style']});
        win.addEventListener('pagehide', cancel, {once: true}); window.addEventListener('pagehide', cancel, {once: true});
        timer = setTimeout(() => { inspect(); if (!settled) finish('unavailable'); }, 10000);
        inspect();
      } catch (_) { finish('unavailable'); }
    });
    entry.uploadTask.finally(() => { entry.uploadTask = null; });
  }
  function updateWorkspaceNav(id) { if (!id) return; lastWorkspaceId = id; const link = $('ns-current-workspace'); link.hidden = false; link.href = '#/workspace/' + encodeURIComponent(id); $('ns-workspace-label').textContent = project(id)?.projectName || '当前工作台'; link.title = '返回 ' + (project(id)?.projectName || '当前工作台') + '，保留编辑会话'; }
  function workspaceStartupFailed(entry, reason = 'timeout') {
    if (frames.get(entry.id) !== entry || (entry.ready && !['native-error', 'license-required'].includes(reason))) return;
    // A late generic timeout must not downgrade a confirmed license refusal.
    if (entry.startupError === 'license-required') reason = 'license-required';
    if (entry.ready) entry.failedAfterReady = true;
    entry.ready = false; entry.frame.dataset.ready = 'false';
    entry.startupError = ['native-error', 'license-required'].includes(reason) ? reason : 'timeout';
    clearTimeout(entry.timer);
    if (reason === 'license-required') homeStart.canvasUnavailable(entry);
    if (activeId !== entry.id || route.page !== 'workspace') return;
    window.dispatchEvent(new Event('novart-startup-check'));
    if (entry.startupError === 'license-required') {
      const detail = '当前画布引擎未获得此域名授权。已保存的项目和原始图片仍保留，授权配置完成后再刷新页面。'
        + (entry.failedAfterReady ? '最近的改动可能尚未保存。' : '');
      $('ns-workspace-status').replaceChildren(node('div', '', detail),
        button('返回项目库', 'ns-secondary', () => go('/projects')));
      return;
    }
    const detail = entry.failedAfterReady
      ? '画布运行出错。已保存的内容仍保留，最近的改动可能尚未保存。'
      : entry.startupError === 'native-error'
      ? '原生画布启动失败，图片和工具尚未恢复。已保存的内容仍保留。'
      : '原生画布尚未启动，图片和工具还没有加载完成。已保存的内容仍保留。';
    $('ns-workspace-status').replaceChildren(node('div', '', detail),
      button('重新打开画布', 'ns-secondary', () => {
        if (frames.get(entry.id) !== entry || entry.ready || activeId !== entry.id || route.page !== 'workspace') return;
        clearTimeout(entry.timer); entry.focusCleanup?.(); entry.slot.remove(); frames.delete(entry.id);
        ensureWorkspace(entry.id);
      }), button('返回项目库', 'ns-secondary', () => go('/projects')));
  }
  async function ensureWorkspace(id) {
    if (route.page !== 'workspace' || route.projectId !== id) return;
    activeId = id;
    if (!projectsLoaded) {
      $('ns-workspace-status').textContent = projectsError || '正在确认本地项目…';
      await loadProjects();
      if (route.page !== 'workspace' || route.projectId !== id) return;
      if (!projectsLoaded) { const status = $('ns-workspace-status'); status.replaceChildren(node('div', '', '项目暂不可读：' + projectsError), button('重新读取项目', 'ns-secondary', () => ensureWorkspace(id)), button('返回项目库', 'ns-secondary', () => go('/projects'))); return; }
    }
    if (!project(id)) { const status = $('ns-workspace-status'); status.replaceChildren(node('div', '', '找不到这个本地项目，请返回项目库重新选择。'), button('返回项目库', 'ns-secondary', () => go('/projects'))); activeId = ''; return; }
    if (project(id).archivedAt) { showArchivedProject(id); return; }
    let entry = frames.get(id);
    // An archived landing page never contained an editor or unsaved changes.
    // After a cross-window restore it needs a fresh editor navigation.
    if (entry && !entry.ready && frameDocument(entry)?.doc.querySelector('[data-project-archived]')) {
      clearTimeout(entry.timer); entry.focusCleanup?.(); entry.slot.remove(); frames.delete(id); entry = null;
    }
    if (!entry) {
      if (frames.size >= 3) { activeId = ''; cacheFull(id, pendingPanels.get(id)); return; }
      const slot = node('div', 'ns-frame-slot'), frame = node('iframe'); frame.dataset.testid = 'studio-canvas-frame'; frame.dataset.projectId = id; slot.dataset.projectId = id; slot.dataset.active = 'false'; slot.inert = true; frame.title = (project(id).projectName || '未命名项目') + ' — 原画布编辑器'; frame.allow = 'clipboard-read; clipboard-write'; frame.src = '/canvas?projectId=' + encodeURIComponent(id) + '&v=1&ui=novart&studio=1&inputGuard=m10&canvasTools=m12&motion=m13&feedback=m14&visual=m16&statusUi=m20&layoutUi=m21&draftUi=m24&imageHistory=m25&floatingUi=m26&focusUi=m27&draftRead=rc2&referenceData=rc3'; slot.append(frame); $('ns-frames').append(slot);
      entry = {id, frame, slot, ready: false, pendingPanel: pendingPanels.get(id) || '', timer: 0}; frames.set(id, entry); pendingPanels.delete(id);
      const params = new URLSearchParams(location.search); if (!entry.pendingPanel && ['requirements', 'materials', 'upload'].includes(params.get('panel'))) { entry.pendingPanel = params.get('panel'); history.replaceState(history.state, '', '/studio' + location.hash); }
      entry.timer = setTimeout(() => workspaceStartupFailed(entry), 22000);
    }
    frames.forEach(item => { const active = item.id === id; item.slot.dataset.active = String(active); item.slot.style.visibility = active ? 'visible' : 'hidden'; item.slot.inert = !active; item.frame.setAttribute('aria-hidden', String(!active)); });
    updateWorkspaceNav(id);
    $('ns-workspace-status').textContent = entry.ready ? '' : '正在打开原画布…';
    if (entry.startupError) workspaceStartupFailed(entry, entry.startupError);
    panelCommand(entry);
    restoreWorkspaceInput(entry);
    completeBlankRecovery(entry);
    homeStart.resume(entry);
  }
  function activateRoute() {
    homeStart.routeChanged();
    rememberPageScroll(); if (activeId) assetCache.delete(activeId); const next = parseRoute(), old = routePath();
    if (next.page !== route.page || next.projectId !== route.projectId) routeVersion += 1;
    if (route.page === 'workspace' && (next.page !== 'workspace' || next.projectId !== route.projectId)) rememberWorkspaceInput(frames.get(route.projectId));
    if (focusReturnIntent && (next.page !== 'workspace' || next.projectId !== focusReturnIntent.entry.id)) focusReturnIntent = null;
    const marker = history.state?.[navigationStateKey], origins = marker?.formOrigins;
    const validOrigin = path => typeof path === 'string' && (/^\/(home|projects|resources|brand|settings)$/.test(path) || /^\/workspace\/[a-zA-Z0-9_-]{1,128}$/.test(path));
    if (marker?.session === navigationSession && marker.route === currentPath() && validOrigin(origins?.settings) && validOrigin(origins?.brand) && origins.settings !== '/settings' && origins.brand !== '/brand' && !(origins.settings === '/brand' && origins.brand === '/settings')) {
      // A history entry owns its return destinations. Back/forward and explicit
      // return must restore them instead of treating a return as a new visit.
      settingsOrigin = origins.settings; brandOrigin = origins.brand;
    } else {
      if (next.page === 'settings' && route.page !== 'settings' && !(route.page === 'brand' && brandOrigin === '/settings')) settingsOrigin = old;
      if (next.page === 'brand' && route.page !== 'brand' && !(route.page === 'settings' && settingsOrigin === '/brand')) brandOrigin = old;
    }
    if (marker?.session === navigationSession && marker.route === currentPath()) {
      history.replaceState({...history.state, [navigationStateKey]: {...marker, formOrigins: {settings: settingsOrigin, brand: brandOrigin}}}, '', location.href);
    }
    if (next.page === 'workspace' && ['home', 'projects', 'resources'].includes(route.page)) {
      workspaceOrigins.set(next.projectId, {path: old, focus: cardFocus() || (route.page === 'resources' ? previewFocus : null)});
    }
    if (route.page === 'resources' && next.page !== 'resources') cancelResourceReturn();
    if (next.page !== route.page || next.projectId !== route.projectId) previousRoute = old;
    route = next; document.body.dataset.page = route.page;
    document.querySelectorAll('section[data-page]').forEach(section => { section.hidden = section.dataset.page !== route.page; });
    document.querySelectorAll('[data-route]').forEach(link => { if (link.dataset.route === route.page) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
    const labels = {home: '首页', projects: '项目库', resources: '素材库', brand: '品牌规范', settings: '个人偏好', workspace: '工作台'}; $('ns-page-label').textContent = labels[route.page]; document.title = (route.page === 'workspace' ? project(route.projectId)?.projectName || '工作台' : labels[route.page]) + ' · Novart';
    $('ns-settings-return').querySelector('span').textContent = settingsOrigin.startsWith('/workspace/') ? '返回来源工作台' : '返回来源页面';
    $('ns-brand-return').textContent = brandOrigin.startsWith('/workspace/') ? '‹ 返回来源工作台' : brandOrigin === '/resources' ? '‹ 返回素材库' : '‹ 返回来源页面';
    frames.forEach(entry => { entry.slot.dataset.active = 'false'; entry.slot.style.visibility = 'hidden'; entry.slot.inert = true; entry.frame.setAttribute('aria-hidden', 'true'); });
    activeId = '';
    if (route.page === 'workspace') { ensureWorkspace(route.projectId); const entry = frames.get(route.projectId); if (entry?.ready) updateWorkspaceReturn(entry); }
    if (route.page === 'home' || route.page === 'projects') { renderProjects(); loadProjects(); }
    if (route.page === 'home' && recoveryRecord && !recoveryRecord.blank) checkRecoverySaved(recoveryRecord);
    if (route.page === 'resources') { updateResourceOptions(); pendingResourceScroll = {key: resourceViewKey(), top: pageScroll.get(resourceViewKey()) || 0}; if (resourceTab === 'images') loadResources(); }
    // Keep rapid navigation from applying an old page's scroll callback to a new route.
    const section = document.querySelector('section[data-page="' + route.page + '"]'), scrollPath = pageViewKey(), scrollVersion = routeVersion;
    requestAnimationFrame(() => { if (section && !section.hidden && routeVersion === scrollVersion && pageViewKey() === scrollPath && !(route.page === 'resources' && resourcesBusy)) section.scrollTop = pageScroll.get(scrollPath) || 0; });
  }
  window.addEventListener('popstate', onNavigation);
  window.addEventListener('hashchange', onNavigation);
  window.addEventListener('message', event => {
    if (event.origin !== location.origin) return; const data = event.data; if (!data || data.type !== 'nv-studio' || typeof data.projectId !== 'string') return;
    const entry = frames.get(data.projectId); if (!entry || event.source !== entry.frame.contentWindow) return;
    if (data.action === 'startup-error') workspaceStartupFailed(entry, data.code === 'NATIVE_CANVAS_LICENSE_REQUIRED' ? 'license-required' : 'native-error');
    else if (data.action === 'ready') { if (entry.startupError === 'license-required') return; entry.ready = true; delete entry.startupError; delete entry.failedAfterReady; entry.frame.dataset.ready = 'true'; clearTimeout(entry.timer); trackWorkspaceInput(entry); prefsToFrame(entry); if (activeId === entry.id && route.page === 'workspace') $('ns-workspace-status').textContent = ''; panelCommand(entry); restoreWorkspaceInput(entry); updateWorkspaceReturn(entry); completeBlankRecovery(entry); homeStart.resume(entry); }
    else if (entry.ready && activeId === entry.id && data.action === 'navigate' && ['home', 'projects', 'resources', 'brand', 'settings'].includes(data.route)) {
      const origin = data.route === 'projects' ? workspaceOrigins.get(entry.id) : null;
      libraryReturnFocus = origin?.focus || null; go(origin?.path || '/' + data.route);
      if (route.page !== 'resources' && libraryReturnFocus) { restoreCardFocus(libraryReturnFocus); libraryReturnFocus = null; }
    }
    else if (entry.ready && activeId === entry.id && data.action === 'open-project' && typeof data.targetProjectId === 'string' && project(data.targetProjectId)) openProject(data.targetProjectId);
    else if (entry.ready && activeId === entry.id && data.action === 'panel-result' && data.status === 'unavailable') notify('原画布中的这个工具还没有准备好，请稍后在画布里打开。');
  });

  function validState(value) {
    return value && Number.isInteger(value.revision) && value.revision >= 0 && typeof value.profile?.nickname === 'string' && textLength(value.profile.nickname) <= 40 && ['comfortable', 'compact'].includes(value.profile.density) && ['system', 'reduce'].includes(value.profile.motion) && typeof value.brand?.name === 'string' && textLength(value.brand.name) <= 60 && Array.isArray(value.brand.colors) && value.brand.colors.length === 3 && value.brand.colors.every(c => /^#[0-9a-fA-F]{6}$/.test(c)) && ['system', 'sans', 'serif', 'mono'].includes(value.brand.font) && typeof value.brand.notes === 'string' && textLength(value.brand.notes) <= 2000 && Array.isArray(value.favorites) && value.favorites.length <= 100 && value.favorites.every(id => typeof id === 'string');
  }
  function validDraft(value) { return value && typeof value.profile?.nickname === 'string' && textLength(value.profile.nickname) <= 80 && typeof value.brand?.name === 'string' && textLength(value.brand.name) <= 120 && typeof value.brand.notes === 'string' && textLength(value.brand.notes) <= 4000 && Array.isArray(value.brand.colors) && value.brand.colors.length === 3 && value.brand.colors.every(color => typeof color === 'string' && color.length <= 7) && validState({...value, profile: {...value.profile, nickname: ''}, brand: {...value.brand, name: '', notes: '', colors: defaults.brand.colors}}); }
  const textRules = {
    'ns-home-brief': {limit: 6000, label: '创作需求', status: 'ns-create-status'},
    'ns-settings-nickname': {limit: 40, label: '昵称', status: 'ns-settings-status'},
    'ns-brand-name': {limit: 60, label: '品牌名称', status: 'ns-brand-status'},
    'ns-brand-notes': {limit: 2000, label: '使用说明', status: 'ns-brand-status'}
  };
  function validateText(id) {
    const field = $(id), rule = textRules[id], length = textLength(field.value), error = length > rule.limit ? rule.label + '最多 ' + rule.limit + ' 个字符（当前 ' + length + ' 个），请调整后再保存。' : '';
    const counter = $(id + '-count'); if (counter) { counter.textContent = length + ' / ' + rule.limit; counter.dataset.invalid = String(Boolean(error)); }
    field.setCustomValidity(error); field.setAttribute('aria-invalid', String(Boolean(error))); if (error) $(rule.status).textContent = error; return !error;
  }
  function validateTextGroup(group) {
    const textValid = (group === 'profile' ? ['ns-settings-nickname'] : group === 'brand' ? ['ns-brand-name', 'ns-brand-notes'] : []).map(validateText).every(Boolean);
    const colorsValid = group !== 'brand' || validateBrandColors(); return textValid && colorsValid;
  }
  function validateBrandColors() {
    const labels = ['点缀色', '文字色', '背景色'], invalid = [];
    labels.forEach((label, i) => {
      const field = $('ns-brand-color-' + i), valid = /^#[0-9a-fA-F]{6}$/.test(field.value);
      field.setAttribute('aria-invalid', String(!valid)); field.setCustomValidity(valid ? '' : label + '请填写 # 加 6 位色值。');
      if (!valid) invalid.push(label);
    });
    const hint = $('ns-brand-color-error'); hint.hidden = !invalid.length;
    hint.textContent = invalid.length ? invalid.join('、') + '请填写 # 加 6 位色值。预览暂沿用上次有效颜色。' : '';
    return !invalid.length;
  }
  function writeDraft() {
    const value = {revision: savedState.revision, profile: profileDraft, brand: brandDraft, favorites: favoriteDraft, dirty: {profile: profileDirty, brand: brandDirty, favorites: favoritesDirty}};
    if (!profileDirty && !brandDirty && !favoritesDirty) { storage.remove(draftKey); draftStorageFailed = false; return true; }
    draftStorageFailed = !storage.set(draftKey, JSON.stringify(value));
    if (draftStorageFailed) showMeta('浏览器无法暂存草稿。当前输入还在，请保留本页并保存后再关闭。');
    return !draftStorageFailed;
  }
  function showMeta(message) { $('ns-meta-message').textContent = message; $('ns-meta-alert').hidden = false; $('ns-favorites-retry').hidden = !favoritesDirty; }
  function clearMetaNotice() { if (!metaConflict && !metaUncertain && !draftStorageFailed) $('ns-meta-alert').hidden = true; }
  function metaControls() {
    const blocked = !metaLoaded || metaBusy || stateLoading || metaConflict || metaUncertain;
    for (const [id, group, label] of [['ns-settings-save', 'profile', '保存偏好'], ['ns-brand-save', 'brand', '保存规范'], ['ns-favorites-retry', 'favorites', '保存收藏']]) {
      $(id).disabled = blocked;
      $(id).textContent = savingGroup === group ? '正在保存…' : groupErrors[group] ? '重试保存' : label;
      $(id).setAttribute('aria-busy', String(savingGroup === group));
    }
    $('ns-meta-retry').disabled = stateLoading || metaBusy;
    $('ns-meta-retry').textContent = stateLoading ? '正在核对…' : '重新读取，保留草稿';
    ['ns-settings-latest', 'ns-brand-latest'].forEach(id => { $(id).hidden = !metaConflict && !metaUncertain; $(id).disabled = stateLoading || metaBusy; });
    ['ns-settings-form', 'ns-brand-form'].forEach(id => $(id).setAttribute('aria-busy', String(stateLoading || metaBusy)));
  }
  function fillMetaForms() {
    $('ns-settings-nickname').value = profileDraft.nickname; $('ns-settings-density').value = profileDraft.density; $('ns-settings-motion').value = profileDraft.motion;
    $('ns-brand-name').value = brandDraft.name; brandDraft.colors.forEach((color, index) => { $('ns-brand-color-' + index).value = color; }); $('ns-brand-font').value = brandDraft.font; $('ns-brand-notes').value = brandDraft.notes;
    applyProfile(); brandPreview(); Object.keys(textRules).forEach(validateText); validateBrandColors();
  }
  async function loadState(preserve = false) {
    if (stateLoading || metaBusy) return;
    const firstRead = !metaLoaded;
    stateLoading = true; metaControls();
    feedback('ns-settings-status', '正在读取已保存的偏好，当前输入保留…', 'loading');
    feedback('ns-brand-status', '正在读取已保存的规范，当前输入保留…', 'loading');
    try {
      const value = await api('/studio/state'); if (!validState(value)) throw new Error('本机设置格式无法读取，当前输入仍保留。');
      // Inputs stay editable while reading. Never replace an in-memory dirty group
      // with an older browser draft (or with the server when storage is unavailable).
      let restoredConflict = false;
      if (firstRead) {
        let draft = null; try { draft = JSON.parse(storage.get(draftKey) || 'null'); } catch (_) {}
        if (validDraft(draft) && draft.dirty) {
          if (!profileDirty && draft.dirty.profile) { profileDraft = clone(draft.profile); profileDirty = true; restoredConflict ||= draft.revision !== value.revision; }
          if (!brandDirty && draft.dirty.brand) { brandDraft = clone(draft.brand); brandDirty = true; restoredConflict ||= draft.revision !== value.revision; }
          if (!favoritesDirty && draft.dirty.favorites) { favoriteDraft = [...draft.favorites]; favoritesDirty = true; restoredConflict ||= draft.revision !== value.revision; }
        }
      }
      savedState = clone(value); metaLoaded = true; metaUncertain = false; metaConflict = restoredConflict;
      if (!profileDirty) profileDraft = clone(value.profile); if (!brandDirty) brandDraft = clone(value.brand); if (!favoritesDirty) favoriteDraft = [...value.favorites];
      Object.keys(groupErrors).forEach(group => { groupErrors[group] = ''; });
      const message = preserve ? '已读取最新设置，请检查草稿后再保存。' : '本机设置已读取';
      feedback('ns-settings-status', profileDirty ? '有未保存的偏好，当前输入已保留' : message, profileDirty ? 'dirty' : 'saved');
      feedback('ns-brand-status', brandDirty ? '有未保存的规范，当前输入已保留' : message, brandDirty ? 'dirty' : 'saved');
      writeDraft();
      if (metaConflict) showMeta('已恢复旧草稿，本机设置已有更新。重新读取后检查，再保存。');
      clearMetaNotice(); fillMetaForms(); renderProjects(); if (preserve) notify(message);
    } catch (error) {
      showMeta(error.message + ' 当前输入仍保留，可重新读取。');
      feedback('ns-settings-status', error.message, 'error'); feedback('ns-brand-status', error.message, 'error');
    } finally { stateLoading = false; metaControls(); }
  }
  async function saveGroup(group) {
    if (!metaLoaded || metaBusy || stateLoading || metaConflict || metaUncertain) return;
    if (!validateTextGroup(group)) return;
    const payload = clone(savedState); if (group === 'profile') payload.profile = clone(profileDraft); if (group === 'brand') payload.brand = clone(brandDraft); if (group === 'favorites') payload.favorites = [...favoriteDraft];
    if (group === 'brand' && !payload.brand.colors.every(color => /^#[0-9a-fA-F]{6}$/.test(color))) { feedback('ns-brand-status', '品牌色需要使用 # 加 6 位十六进制数字，例如 #8B77B5。', 'error'); return; }
    clearTimeout(toastTimer); $('ns-toast').hidden = true; $('ns-toast').textContent = '';
    metaBusy = true; savingGroup = group; groupErrors[group] = ''; metaControls(); renderProjects();
    const statusId = group === 'profile' ? 'ns-settings-status' : group === 'brand' ? 'ns-brand-status' : null;
    if (statusId) feedback(statusId, '正在保存提交的内容…', 'saving');
    try {
      const value = await api('/studio/state', payload);
      if (!validState(value)) { const error = new Error('保存回包无法确认，请先核对已保存内容。'); error.uncertain = true; throw error; }
      savedState = clone(value); metaConflict = false; metaUncertain = false;
      if (group === 'profile' && JSON.stringify(profileDraft) === JSON.stringify(payload.profile)) { profileDraft = clone(value.profile); profileDirty = false; }
      if (group === 'brand' && JSON.stringify(brandDraft) === JSON.stringify(payload.brand)) { brandDraft = clone(value.brand); brandDirty = false; }
      if (group === 'favorites') { favoriteDraft = [...value.favorites]; favoritesDirty = false; }
      const stillDirty = group === 'profile' ? profileDirty : group === 'brand' ? brandDirty : favoritesDirty;
      const message = stillDirty ? '已保存提交的内容；新的修改尚未保存' : group === 'profile' ? '偏好已保存在本机' : group === 'brand' ? '品牌规范已保存在本机' : '收藏已保存在本机';
      writeDraft(); clearMetaNotice(); if (statusId) feedback(statusId, message, stillDirty ? 'dirty' : 'saved');
      applyProfile(); notify(message);
    } catch (error) {
      metaConflict = error.status === 409; metaUncertain = Boolean(error.uncertain); groupErrors[group] = error.message;
      const message = error.message + (metaConflict || metaUncertain ? ' 当前输入保留，请先重新读取，再检查并保存。' : ' 当前输入保留，可重试保存。');
      if (statusId) feedback(statusId, message, 'error'); showMeta(message); writeDraft();
    } finally { metaBusy = false; savingGroup = ''; metaControls(); renderProjects(); }
  }
  function changeProfile() {
    profileDraft = {nickname: $('ns-settings-nickname').value, density: $('ns-settings-density').value, motion: $('ns-settings-motion').value}; profileDirty = true;
    feedback('ns-settings-status', savingGroup === 'profile' ? '正在保存提交的内容；新的输入尚未保存' : '有未保存的偏好', savingGroup === 'profile' ? 'saving' : 'dirty');
    writeDraft(); validateTextGroup('profile'); applyProfile();
  }
  function changeBrand() {
    brandDraft = {name: $('ns-brand-name').value, colors: [0, 1, 2].map(i => $('ns-brand-color-' + i).value), font: $('ns-brand-font').value, notes: $('ns-brand-notes').value}; brandDirty = true;
    feedback('ns-brand-status', savingGroup === 'brand' ? '正在保存提交的内容；新的输入尚未保存' : '有未保存的规范', savingGroup === 'brand' ? 'saving' : 'dirty');
    writeDraft(); validateTextGroup('brand'); brandPreview();
  }
  function brandPreview() {
    const preview = $('ns-brand-preview');
    brandDraft.colors.forEach((color, i) => { if (/^#[0-9a-fA-F]{6}$/.test(color)) { preview.style.setProperty('--brand-' + i, color); $('ns-brand-swatch-' + i).style.backgroundColor = color; $('ns-brand-picker-' + i).value = color; } });
    const luminance = hex => {
      const channels = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
      return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
    };
    const background = preview.style.getPropertyValue('--brand-2') || defaults.brand.colors[2], candidate = preview.style.getPropertyValue('--brand-1') || defaults.brand.colors[1];
    const backgroundLuminance = luminance(background), contrast = color => { const textLuminance = luminance(color); return (Math.max(backgroundLuminance, textLuminance) + .05) / (Math.min(backgroundLuminance, textLuminance) + .05); };
    let textColor = contrast(candidate) >= 4.5 ? candidate : contrast('#171717') >= contrast('#FFFFFF') ? '#171717' : '#FFFFFF';
    if (contrast(textColor) < 4.5) textColor = contrast('#000000') >= contrast('#FFFFFF') ? '#000000' : '#FFFFFF';
    preview.style.setProperty('--brand-text', textColor);
    $('ns-brand-preview-name').textContent = brandDraft.name || '你的品牌'; $('ns-brand-preview-notes').textContent = brandDraft.notes || '一些颜色，一点留白，和你自己的表达。';
    const fonts = {system: '', sans: 'Arial, "Microsoft YaHei", sans-serif', serif: 'Georgia, "Songti SC", "SimSun", serif', mono: 'Consolas, "Courier New", monospace'}; preview.style.fontFamily = fonts[brandDraft.font] || '';
  }
  [0, 1, 2].forEach(i => $('ns-brand-picker-' + i).addEventListener('input', event => {
    $('ns-brand-color-' + i).value = event.target.value.toUpperCase(); changeBrand();
  }));
  ['ns-settings-nickname', 'ns-settings-density', 'ns-settings-motion'].forEach(id => $(id).addEventListener('input', changeProfile));
  ['ns-brand-name', 'ns-brand-color-0', 'ns-brand-color-1', 'ns-brand-color-2', 'ns-brand-font', 'ns-brand-notes'].forEach(id => $(id).addEventListener('input', changeBrand));
  $('ns-settings-form').addEventListener('submit', event => { event.preventDefault(); saveGroup('profile'); }); $('ns-brand-form').addEventListener('submit', event => { event.preventDefault(); saveGroup('brand'); });
  ['ns-meta-retry', 'ns-settings-latest', 'ns-brand-latest'].forEach(id => $(id).addEventListener('click', () => loadState(true))); $('ns-favorites-retry').addEventListener('click', () => saveGroup('favorites'));
  $('ns-settings-return').addEventListener('click', () => returnToOrigin(settingsOrigin)); $('ns-brand-return').addEventListener('click', () => returnToOrigin(brandOrigin));
  window.addEventListener('storage', event => { if (event.key === draftKey && event.newValue) { showMeta('另一个页面修改了本机草稿；这里的输入仍保留。请重新读取已保存设置后检查。'); } });

  async function loadProjects(force = false) {
    if (projectsRequest) {
      if (!force) return projectsRequest;
      await projectsRequest;
      return loadProjects(false);
    }
    projectsBusy = true; projectsError = ''; renderProjects();
    projectsRequest = (async () => {
      try { const value = await api('/studio/project-library'); if (!Array.isArray(value.projects)) throw new Error('项目列表格式无法读取。'); projects = value.projects.filter(p => typeof p.projectId === 'string'); projectsLoaded = true; updateResourceOptions(); if (lastWorkspaceId) updateWorkspaceNav(lastWorkspaceId); }
      catch (error) { projectsError = error.message; }
      finally { projectsBusy = false; projectsRequest = null; renderProjects(); }
    })(); return projectsRequest;
  }
  function projectFeedback() {
    $('ns-project-refresh').disabled = projectsBusy;
    $('ns-project-refresh').textContent = projectsBusy ? '正在刷新…' : '刷新';
    ['ns-recent-projects', 'ns-project-library'].forEach((id, i) => {
      $(id).setAttribute('aria-busy', String(projectsBusy));
      const noteId = i ? 'ns-project-feedback' : 'ns-recent-feedback';
      let note = $(noteId);
      if (!note) { note = node('div', 'ns-feedback'); note.id = noteId; $(id).before(note); }
      note.hidden = !projectsLoaded || !projectsBusy && !projectsError;
      if (note.hidden) { note.replaceChildren(); return; }
      note.dataset.state = projectsError ? 'error' : 'loading';
      const message = node('span', '', projectsError ? '刷新失败，显示上次读取结果。' + projectsError : '正在刷新项目，当前列表仍可使用…'); message.setAttribute('role', 'status');
      note.replaceChildren(message);
      if (projectsError) { const retry = button('重试读取', 'ns-text-button', () => loadProjects(true)); retry.id = i ? 'ns-project-retry' : 'ns-home-retry'; note.append(retry); }
    });
  }
  function toggleFavorite(id) { if (!metaLoaded || metaBusy || stateLoading || metaConflict || metaUncertain) return; if (favoriteDraft.includes(id)) favoriteDraft = favoriteDraft.filter(value => value !== id); else { if (favoriteDraft.length >= 100) { notify('最多收藏 100 个本机项目。'); return; } favoriteDraft.push(id); } favoritesDirty = true; writeDraft(); renderProjects(); saveGroup('favorites'); }
  function projectCard(p) {
    const card = node('article', 'ns-project-card'); card.dataset.projectId = p.projectId;
    const open = button('', 'ns-project-open', () => openProject(p.projectId)); open.dataset.action = 'open-project'; open.setAttribute('aria-label', '打开项目：' + (p.projectName || '未命名项目'));
    const preview = node('div', 'ns-project-preview'), placeholder = node('span', 'ns-preview-placeholder'); placeholder.append(icon('canvas'), node('span', '', p.hasCanvas ? '已保存画布' : '一张空白画布')); preview.append(placeholder);
    const info = node('div', 'ns-project-info'); info.title = p.projectName || '未命名项目'; info.append(node('strong', '', p.projectName || '未命名项目'), node('small', '', (p.hasCanvas ? '已保存画布' : '空白项目') + ' · ' + dateText(p.updatedAt))); open.append(preview, info);
    const favorite = button('', 'ns-favorite', () => toggleFavorite(p.projectId)); favorite.dataset.action = 'favorite'; favorite.setAttribute('aria-label', (favoriteDraft.includes(p.projectId) ? '取消收藏：' : '收藏项目：') + (p.projectName || '未命名项目')); favorite.setAttribute('aria-pressed', String(favoriteDraft.includes(p.projectId))); favorite.setAttribute('aria-disabled', String(!metaLoaded || metaBusy || stateLoading || metaConflict || metaUncertain)); favorite.append(icon('star')); card.append(open, favorite);
    addProjectActions(card, p);
    if (p.archivedAt) { card.dataset.archived = 'true'; info.querySelector('small').textContent = '已归档 · ' + dateText(p.archivedAt); }
    if (p.hasCanvas) previewProject(p.projectId, preview, placeholder); return card;
  }
  function renderProjects() {
    const focusedCard = cardFocus();
    try { renderProjectLists(); }
    finally { if (focusedCard?.container !== 'ns-assets') restoreCardFocus(focusedCard, true); }
  }
  function clearProjectFilters() { $('ns-project-search').value = ''; favoriteFilter = false; $('ns-project-favorites').setAttribute('aria-pressed', 'false'); renderProjects(); $('ns-project-search').focus({preventScroll: true}); }
  $('ns-project-clear').addEventListener('click', clearProjectFilters);
  function renderProjectLists() {
    projectFeedback();
    ['active','archived'].forEach(scope => { const tab = $('pl-' + scope); tab.setAttribute('aria-selected', String(scope === libraryScope)); tab.tabIndex = scope === libraryScope ? 0 : -1; });
    const recent = $('ns-recent-projects'), library = $('ns-project-library'), targets = [recent, library];
    if (!projectsLoaded) { targets.forEach(target => empty(target, projectsError ? '读取项目失败：' + projectsError : '正在读取本机项目…', projectsError ? () => loadProjects(true) : null, '重新读取项目', target === library ? 'ns-project-retry' : 'ns-home-retry')); $('ns-project-count').textContent = projectsError ? '项目暂不可读' : '正在读取项目…'; return; }
    if (!projects.length) { targets.forEach(target => empty(target, '还没有项目。从一句需求或一张空白画布开始。', () => { go('/home'); requestAnimationFrame(() => $('ns-home-brief').focus()); }, '创建第一个项目')); $('ns-project-count').textContent = '0 个项目'; return; }
    const activeProjects = projects.filter(p => !p.archivedAt);
    if (!activeProjects.length) empty(recent, '使用中的项目会出现在这里。你可以开始创作，或到项目库找回已归档项目。');
    else recent.replaceChildren(...[...activeProjects].sort((a, b) => updated(b) - updated(a)).slice(0, 4).map(projectCard));
    const query = $('ns-project-search').value.trim().toLocaleLowerCase(), sort = $('ns-project-sort').value;
    $('ns-project-clear').hidden = !query && !favoriteFilter;
    let list = projects.filter(p => Boolean(p.archivedAt) === (libraryScope === 'archived') && (!query || (p.projectName || '未命名项目').toLocaleLowerCase().includes(query)) && (!favoriteFilter || favoriteDraft.includes(p.projectId)));
    list.sort(sort === 'name' ? (a, b) => (a.projectName || '').localeCompare(b.projectName || '', 'zh-CN') : sort === 'oldest' ? (a, b) => updated(a) - updated(b) : (a, b) => updated(b) - updated(a));
    if (!list.length && !query && !favoriteFilter) empty(library, libraryScope === 'archived' ? '暂时没有归档项目。收起的工作会保留在这里。' : '暂时没有使用中的项目。新建一个，或从已归档中恢复。');
    else if (!list.length) empty(library, favoriteFilter ? '这里还没有符合条件的收藏。点击项目卡片上的星星，留住常用画布。' : '没有找到这个项目。试试其他关键词。', clearProjectFilters, '查看全部项目'); else library.replaceChildren(...list.map(projectCard));
    $('ns-project-count').textContent = list.length + ' 个项目' + (projectsError ? ' · 刷新失败，显示上次读取结果' : '');
  }
  const assetPending = new Map();
  async function getAssets(id, force = false) { if (!force && assetCache.has(id)) return assetCache.get(id); if (assetPending.has(id)) return assetPending.get(id); const task = api('/workflow/assets?projectId=' + encodeURIComponent(id)).then(value => { if (!Array.isArray(value.assets)) throw new Error('素材列表格式无法读取。'); assetCache.set(id, value); return value; }).finally(() => assetPending.delete(id)); assetPending.set(id, task); return task; }
  function assetURL(id, digest) { return '/workflow/image/' + encodeURIComponent(digest) + '?projectId=' + encodeURIComponent(id); }
  function previewProject(id, preview, placeholder) {
    getAssets(id).then(value => { if (!preview.isConnected) return; const asset = value.assets.find(item => item.valid !== false && /^[a-f0-9]{64}$/.test(item.assetSha256)); if (!asset) return; const img = node('img'); img.alt = '项目中的真实画布图片'; img.loading = 'lazy'; img.src = assetURL(id, asset.assetSha256); img.addEventListener('load', () => { placeholder.hidden = true; }); img.addEventListener('error', () => { img.remove(); placeholder.hidden = false; }); preview.prepend(img); }).catch(() => { if (preview.isConnected) placeholder.querySelector('span').textContent = '已保存画布 · 预览暂不可读'; });
  }
  $('ns-project-search').addEventListener('input', renderProjects); $('ns-project-sort').addEventListener('change', renderProjects); $('ns-project-favorites').addEventListener('click', () => { favoriteFilter = !favoriteFilter; $('ns-project-favorites').setAttribute('aria-pressed', String(favoriteFilter)); renderProjects(); }); $('ns-project-refresh').addEventListener('click', () => { assetCache.clear(); loadProjects(true); }); $('ns-project-new').addEventListener('click', () => { go('/home'); requestAnimationFrame(() => $('ns-home-brief').focus()); });

  function validRecovery(value) {
    return value && typeof value.projectId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value.projectId) && typeof value.submittedBrief === 'string' && textLength(value.submittedBrief) <= 6000 && typeof value.blank === 'boolean' && (value.blank ? value.submittedBrief === '' : Boolean(value.submittedBrief.trim()));
  }
  function recoveryDraft(record) {
    const key = 'novart-compare-draft:' + record.projectId;
    // A later edit in the existing requirement panel has priority over its initial brief.
    if (storage.get(key) !== null) return true;
    return storage.set(key, JSON.stringify({brief: record.submittedBrief, notes: '', revision: 0}));
  }
  function renderRecovery() {
    const box = $('ns-create-recovery'); box.replaceChildren(); box.hidden = !recoveryRecord && !recoveryWarning;
    if (recoveryRecord) {
      const record = recoveryRecord;
      box.append(node('span', '', record.blank ? '上次创建的空白项目已经存在。' : '上次创建的项目已经存在。'));
      const link = node('a', '', record.blank ? '继续已创建空白项目' : '继续已创建项目');
      link.id = 'ns-create-recover'; link.dataset.testid = 'studio-create-recover-link'; link.dataset.projectId = record.projectId; link.href = '#/workspace/' + encodeURIComponent(record.projectId);
      link.addEventListener('click', event => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); recoverProject(record);
      });
      box.append(link);
    }
    if (recoveryWarning) box.append(node('span', '', ' ' + recoveryWarning));
  }
  function rememberRecovery(value, saveDraft = true) {
    recoveryRecord = Object.freeze({projectId: value.projectId, submittedBrief: value.submittedBrief, blank: value.blank}); recoveryWarning = '';
    try { sessionStorage.setItem(recoveryKey, JSON.stringify(recoveryRecord)); }
    catch (_) { recoveryWarning = '无法暂存恢复入口，请保留当前标签页。'; }
    if (saveDraft && !recoveryDraft(recoveryRecord)) recoveryWarning += (recoveryWarning ? ' ' : '') + '原需求无法暂存，请保留本页并重试恢复。';
    renderRecovery();
  }
  function clearRecovery(record) {
    if (recoveryRecord !== record) return;
    if (recoveryWarning && $('ns-toast').textContent === recoveryWarning) {
      clearTimeout(toastTimer); $('ns-toast').hidden = true; $('ns-toast').textContent = '';
    }
    recoveryRecord = null; recoveryWarning = '';
    try { sessionStorage.removeItem(recoveryKey); }
    catch (_) { recoveryWarning = '恢复入口无法从浏览器清除；本页已结束恢复，可继续创建。'; notify(recoveryWarning); }
    renderRecovery();
  }
  async function checkRecoverySaved(record) {
    if (recoveryRecord !== record) return 'stale';
    if (record.blank || !project(record.projectId)) return 'pending';
    const version = routeVersion;
    if (recoveryCheck?.record === record && recoveryCheck.version === version) return recoveryCheck.task;
    const check = {record, version};
    check.task = (async () => {
      try {
        const value = await api('/compare/api/context?projectId=' + encodeURIComponent(record.projectId));
        if (recoveryRecord !== record || routeVersion !== version) return 'stale';
        if (value.projectId !== record.projectId || !Number.isInteger(value.revision) || value.revision < 0) throw new Error('恢复项目读取结果不匹配。');
        if (!project(record.projectId)) return 'pending';
        if (Number.isInteger(value.revision) && value.revision > 0) { clearRecovery(record); return 'saved'; }
        return 'pending';
      } catch (_) {
        if (recoveryRecord !== record || routeVersion !== version) return 'stale';
        if (!recoveryWarning) recoveryWarning = '无法确认上次项目是否已保存，恢复入口仍保留。';
        renderRecovery(); return 'pending';
      } finally { if (recoveryCheck === check) recoveryCheck = null; }
    })();
    recoveryCheck = check; return check.task;
  }
  function completeBlankRecovery(entry) {
    const record = recoveryRecord;
    if (record?.blank && record.projectId === entry.id && entry.ready && activeId === entry.id && route.page === 'workspace' && route.projectId === entry.id && frames.get(entry.id) === entry && !entry.slot.inert && entry.slot.dataset.active === 'true') clearRecovery(record);
  }
  async function recoverProject(record, checked = false, expectedBrief = null) {
    if (homeComposing || recoveryRecord !== record) return;
    const version = routeVersion;
    const current = () => routeVersion === version && !homeComposing && (expectedBrief === null || $('ns-home-brief').value === expectedBrief);
    if (!project(record.projectId)) {
      await loadProjects(true);
      if (recoveryRecord !== record || !current()) return;
      if (!project(record.projectId)) {
        recoveryWarning = '暂时无法确认已创建项目：' + (projectsError || '项目列表中尚未找到这个项目。') + ' 恢复入口仍保留，请重试。';
        renderRecovery(); notify(recoveryWarning); return;
      }
      checked = false;
    }
    if (!record.blank && !checked) {
      const status = await checkRecoverySaved(record);
      if (status === 'stale' || !current()) return;
      if (status === 'saved') { if (!recoveryRecord) openProject(record.projectId, 'requirements'); return; }
    }
    if (recoveryRecord !== record || !current()) return;
    if (!record.blank && !recoveryDraft(record)) { recoveryWarning = '原需求无法暂存，请保留本页并重试恢复。'; renderRecovery(); notify(recoveryWarning); return; }
    openProject(record.projectId, record.blank ? '' : 'requirements');
  }
  function restoreRecovery() {
    try {
      const raw = sessionStorage.getItem(recoveryKey);
      if (raw) {
        let value = null; try { value = JSON.parse(raw); } catch (_) {}
        if (validRecovery(value)) recoveryRecord = Object.freeze({projectId: value.projectId, submittedBrief: value.submittedBrief, blank: value.blank});
        else sessionStorage.removeItem(recoveryKey);
      }
    } catch (_) { recoveryWarning = '无法读取或暂存恢复入口，请保留当前标签页。'; }
    renderRecovery();
  }
  $('ns-home-brief').value = storage.get(briefKey) ?? '';
  $('ns-home-brief').addEventListener('compositionstart', () => { homeComposing = true; });
  $('ns-home-brief').addEventListener('compositionend', () => { homeComposing = false; });
  $('ns-home-brief').addEventListener('blur', () => { homeComposing = false; });
  $('ns-home-brief').addEventListener('input', () => { if (!storage.set(briefKey, $('ns-home-brief').value)) $('ns-create-status').textContent = '无法暂存需求，请保留当前页面。'; else if (validateText('ns-home-brief')) $('ns-create-status').textContent = createBusy ? '当前项目正在创建，新的需求草稿已保留。' : ''; });
  function renderUncertainCreate() {
    let box = $('ns-create-uncertain');
    if (!box) { box = node('div', 'ns-feedback ns-create-uncertain'); box.id = 'ns-create-uncertain'; $('ns-create-status').after(box); }
    box.hidden = !createUncertain;
    if (!createUncertain) { box.replaceChildren(); return; }
    const text = node('span', '', uncertainListChecked ? '已重新读取项目库。若项目已经出现，直接打开即可。' : '项目可能已创建，当前需求仍保留。先读取项目库确认结果。'); text.setAttribute('role', 'status');
    const check = button('先检查项目库', 'ns-secondary', async () => {
      check.disabled = true;
      await loadProjects(true);
      if (projectsError) { check.disabled = false; text.textContent = '项目库还未读到，暂不重复创建。' + projectsError; return; }
      uncertainListChecked = true; renderUncertainCreate(); go('/projects');
    });
    box.replaceChildren(text, check);
    if (uncertainListChecked) box.append(button('已检查，允许重新创建', 'ns-text-button', () => {
      try { sessionStorage.removeItem(uncertainCreateKey); } catch (_) { text.textContent = '无法清除恢复标记，请保留当前页面；已有项目可从项目库打开。'; return; }
      createUncertain = false; uncertainListChecked = false; renderUncertainCreate();
      $('ns-create').disabled = createBusy; $('ns-create-blank').disabled = createBusy;
      feedback('ns-create-status', '已允许重新创建，需求仍在上方。', 'idle');
    }));
  }
  try { createUncertain = sessionStorage.getItem(uncertainCreateKey) === '1'; } catch (_) {}
  renderUncertainCreate();
  if (createUncertain) { $('ns-create').disabled = true; $('ns-create-blank').disabled = true; }
  async function createProject(blank = false, panel = '') {
    if (!homeStart.snapshot().loaded || homeStart.busy()) return;
    if (!blank && homeStart.hasDraft()) { await homeStart.create(); return; }
    if (createBusy || homeComposing || recoveryDecisionBusy || createUncertain) return;
    const candidate = recoveryRecord, decisionVersion = routeVersion;
    if (candidate && !candidate.blank && !blank && candidate.submittedBrief === $('ns-home-brief').value) {
      recoveryDecisionBusy = true; $('ns-create').disabled = true; $('ns-create-blank').disabled = true;
      try { if (await checkRecoverySaved(candidate) === 'stale' || routeVersion !== decisionVersion || homeComposing) return; }
      finally { recoveryDecisionBusy = false; $('ns-create').disabled = false; $('ns-create-blank').disabled = false; }
    }
    const brief = blank ? '' : $('ns-home-brief').value;
    if (recoveryRecord && recoveryRecord.blank === blank && recoveryRecord.submittedBrief === brief) { recoverProject(recoveryRecord, true, blank ? null : brief); return; }
    if (!blank && !validateText('ns-home-brief')) { $('ns-home-brief').focus(); return; } if (!blank && !brief.trim()) { $('ns-create-status').textContent = '先写一句需求，或打开空白画布。'; $('ns-home-brief').focus(); return; }
    const creationVersion = routeVersion;
    createBusy = true; $('ns-create').disabled = true; $('ns-create-blank').disabled = true; $('ns-create-status').textContent = '正在创建本机项目…';
    try {
      const name = brief.trim() ? Array.from(brief.trim().split('\n')[0]).slice(0, 26).join('') : '未命名项目';
      const value = await api('/compare/api/create', {projectName: name, brief}); if (typeof value.projectId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.projectId)) { const error = new Error('创建结果缺少有效项目标识，请先检查项目库。'); error.uncertain = true; throw error; }
      await loadProjects(true);
      if (!project(value.projectId)) await loadProjects(true);
      if (!project(value.projectId)) { const error = new Error('项目已创建，但项目列表尚未确认，请重试恢复或检查项目。'); error.result = {projectId: value.projectId}; error.listUnconfirmed = true; throw error; }
      if (!blank && !homeComposing && $('ns-home-brief').value === brief) { $('ns-home-brief').value = ''; storage.remove(briefKey); } $('ns-create-status').textContent = '项目已创建';
      if (routeVersion === creationVersion) openProject(value.projectId, panel || (brief ? 'requirements' : ''));
      else notify('项目已创建，已放入项目库，可稍后继续编辑。');
    } catch (error) {
      $('ns-create-status').textContent = error.message + ' 需求草稿仍保留。';
      if (validRecovery({projectId: error.result?.projectId, submittedBrief: brief, blank})) { rememberRecovery({projectId: error.result.projectId, submittedBrief: brief, blank}, !error.listUnconfirmed); if (!error.listUnconfirmed) loadProjects(true); }
      else if (error.uncertain) {
        createUncertain = true; uncertainListChecked = false;
        try { sessionStorage.setItem(uncertainCreateKey, '1'); } catch (_) {}
        feedback('ns-create-status', '创建结果未确认。请先检查项目库，避免重复创建。', 'error');
        renderUncertainCreate();
      }
    } finally { createBusy = false; $('ns-create').disabled = createUncertain; $('ns-create-blank').disabled = createUncertain; }
  }
  $('ns-composer').addEventListener('submit', event => { event.preventDefault(); createProject(); }); $('ns-home-brief').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); createProject(); } }); $('ns-create-blank').addEventListener('click', () => createProject(true));
  function setPrompt(prompt) {
    if (homeStart.busy() || homeStart.snapshot().submittedRequestId) { notify('这份需求已提交，请先继续已创建的项目。'); return; }
    const current = $('ns-home-brief').value, combined = current.trim() ? current + '\n\n' + prompt : prompt;
    go('/home'); requestAnimationFrame(() => { $('ns-home-brief').focus(); $('ns-home-brief').selectionStart = $('ns-home-brief').selectionEnd = $('ns-home-brief').value.length; });
    if (textLength(combined) > 6000) { const message = '加入这个需求起点会超过 6000 个字符，当前草稿保持完整。请先缩短内容，再加入模板。'; $('ns-create-status').textContent = message; notify(message); return; }
    $('ns-home-brief').value = combined; const stored = storage.set(briefKey, combined);
    if (!stored) $('ns-create-status').textContent = '无法暂存需求，请保留当前页面。'; else if (validateText('ns-home-brief')) $('ns-create-status').textContent = createBusy ? '当前项目正在创建，新的需求草稿已保留。' : '';
    notify(current.trim() ? '需求起点已追加到现有草稿，可继续编辑。' : '需求起点已带回首页，可继续编辑。');
  }
  document.querySelectorAll('[data-prompt]').forEach(chip => chip.addEventListener('click', () => setPrompt(chip.dataset.prompt)));
  starters.forEach(starter => { const card = node('article', 'ns-starter-card'); card.append(node('h3', '', starter.name), node('p', '', starter.description), button('使用这个需求起点 ↗', '', () => setPrompt(starter.prompt))); $('ns-starters').append(card); });

  function updateUploadLabel() { const target = resourceTab === 'images' && resourceProject ? project(resourceProject) : null; const label = target ? '上传到 ' + (target.projectName || '未命名项目') : '上传到项目'; const control = $('ns-resource-upload'); control.replaceChildren(icon('upload'), node('span', 'ns-upload-label', label)); control.title = label; control.setAttribute('aria-label', label); }
  function updateResourceOptions() { const select = $('ns-resource-project'); const value = resourceProject; select.replaceChildren(new Option('全部项目', '')); projects.forEach(p => select.append(new Option(p.projectName || '未命名项目', p.projectId))); if (projects.some(p => p.projectId === value)) select.value = value; else { select.value = ''; resourceProject = ''; } updateUploadLabel(); }
  function selectResourceTab(tab) { cancelResourceReturn(); rememberPageScroll(); resourceTab = tab; pendingResourceScroll = {key: resourceViewKey(), top: pageScroll.get(resourceViewKey()) || 0}; const images = tab === 'images'; $('ns-tab-images').setAttribute('aria-selected', String(images)); $('ns-tab-starters').setAttribute('aria-selected', String(!images)); $('ns-tab-images').tabIndex = images ? 0 : -1; $('ns-tab-starters').tabIndex = images ? -1 : 0; $('ns-resource-images').hidden = !images; $('ns-resource-starters').hidden = images; $('ns-resource-scope').hidden = !images; updateUploadLabel(); if (images) loadResources(); else document.querySelector('section[data-page="resources"]').scrollTop = pageScroll.get(resourceViewKey()) || 0; }
  $('ns-tab-images').addEventListener('click', () => selectResourceTab('images')); $('ns-tab-starters').addEventListener('click', () => selectResourceTab('starters'));
  [$('ns-tab-images'), $('ns-tab-starters')].forEach(tab => tab.addEventListener('keydown', event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); selectResourceTab(event.key === 'Home' ? 'images' : event.key === 'End' ? 'starters' : resourceTab === 'images' ? 'starters' : 'images'); $(resourceTab === 'images' ? 'ns-tab-images' : 'ns-tab-starters').focus(); } }));
  $('ns-resource-project').addEventListener('change', () => { cancelResourceReturn(); rememberPageScroll(); resourceProject = $('ns-resource-project').value; pendingResourceScroll = {key: resourceViewKey(), top: pageScroll.get(resourceViewKey()) || 0}; updateUploadLabel(); loadResources(true); });
  function assetCard(p, asset) {
    const card = node('article', 'ns-asset-card'); card.dataset.projectId = p.projectId; card.dataset.assetSha256 = asset.assetSha256; card.dataset.shapeId = asset.shapeId || '';
    const preview = button('', 'ns-asset-image', () => showPreview(p, asset)); preview.dataset.action = 'preview'; preview.setAttribute('aria-label', '预览 ' + (asset.name || '画布图片'));
    const img = node('img'); img.alt = asset.name || '画布图片'; img.loading = 'lazy'; img.src = assetURL(p.projectId, asset.assetSha256); img.addEventListener('error', () => { preview.replaceChildren(node('span', 'ns-panel-note', '图片暂不可读')); }); preview.append(img);
    const info = node('div', 'ns-asset-info'); info.title = asset.name || '画布图片'; info.append(node('strong', '', asset.name || '画布图片'), node('small', '', typeof asset.width === 'number' && typeof asset.height === 'number' ? Math.round(asset.width) + ' × ' + Math.round(asset.height) + ' · 画布尺寸' : '本地画布图片'));
    const source = button('来自 ' + (p.projectName || '未命名项目') + ' ↗', 'ns-source-link', () => openProject(p.projectId, 'materials')); source.dataset.action = 'source'; source.title = '返回来源项目：' + (p.projectName || '未命名项目'); info.append(source); card.append(preview, info); return card;
  }
  async function loadResources(force = true) {
    const generation = ++resourceGeneration, scope = resourceProject;
    resourcesBusy = true; resourcesError = '';
    $('ns-assets').setAttribute('aria-busy', 'true');
    feedback('ns-resource-status', '正在读取画布图片…', 'loading');
    if (resourceViewScope !== scope) { resourceViewScope = scope; empty($('ns-assets'), '正在读取这个范围的图片…'); }
    if (!projectsLoaded || projectsError) await loadProjects(true); if (generation !== resourceGeneration) return;
    if (!projectsLoaded) {
      resourcesBusy = false; resourcesError = projectsError; $('ns-assets').setAttribute('aria-busy', 'false');
      empty($('ns-assets'), '素材来源项目暂不可读：' + projectsError, () => loadResources(true), '重新读取素材', 'ns-resource-retry'); feedback('ns-resource-status', '读取失败，原素材仍保留。', 'error'); restoreResourceScroll(scope); return;
    }
    const selected = projects.filter(p => !scope || p.projectId === scope), cards = [], errors = [], issues = []; let cursor = 0;
    async function worker() {
      while (cursor < selected.length) {
        const p = selected[cursor++];
        try {
          const value = await getAssets(p.projectId, force); if (generation !== resourceGeneration) return;
          const rows = value.assets.filter(asset => asset.valid !== false && /^[a-f0-9]{64}$/.test(asset.assetSha256)).map(asset => ({p, asset}));
          resourceRows.set(p.projectId, rows); cards.push(...rows); if (value.issues?.length) issues.push(p.projectName || '未命名项目');
        } catch (error) {
          if (generation !== resourceGeneration) return;
          errors.push((p.projectName || '未命名项目') + '：' + error.message);
          // Preserve only previously successful rows for this exact project.
          cards.push(...(resourceRows.get(p.projectId) || []).map(row => ({...row, p, stale: true})));
        }
      }
    }
    await Promise.all(Array.from({length: Math.min(4, selected.length)}, worker)); if (generation !== resourceGeneration) return;
    resourcesBusy = false; resourcesError = errors.join(' '); $('ns-assets').setAttribute('aria-busy', 'false');
    cards.sort((a, b) => updated(b.p) - updated(a.p));
    const resourceSection = document.querySelector('section[data-page="resources"]'), scrollBeforeRender = resourceSection.scrollTop, focusedAsset = cardFocus();
    if (cards.length) $('ns-assets').replaceChildren(...cards.map(row => {
      const card = assetCard(row.p, row.asset);
      if (row.stale) { card.dataset.stale = 'true'; card.querySelector('.ns-asset-info').append(node('span', 'ns-stale-label', '上次读取 · 待刷新')); }
      return card;
    }));
    else empty($('ns-assets'), errors.length ? '图片列表读取失败，原素材未被删除。请重试。' : selected.length ? '这些项目还没有可读取的本地画布图片。上传并保存后，会出现在这里。' : '还没有项目。先创建一张画布，再把素材放进去。', errors.length ? () => loadResources(true) : openUploadDialog, errors.length ? '重新读取素材' : '上传到项目', errors.length ? 'ns-resource-retry' : undefined);
    resourceSection.scrollTop = scrollBeforeRender;
    if (!$('ns-preview-dialog').open && focusedAsset?.container === 'ns-assets') restoreCardFocus(focusedAsset);
    restoreResourceScroll(scope);
    const staleCount = cards.filter(row => row.stale).length;
    const detail = cards.length + ' 张画布图片' + (staleCount ? ' · ' + staleCount + ' 张为上次读取结果' : '') + (issues.length ? ' · ' + issues.length + ' 个项目有不可读素材' : '') + (errors.length ? ' · ' + errors.length + ' 个项目读取失败' : '') + (projectsError ? ' · 项目列表尚未更新' : '');
    feedback('ns-resource-status', detail, errors.length || projectsError ? 'error' : 'idle');
    if (errors.length && cards.length || projectsError && !errors.length) {
      const retry = button('重新读取素材', 'ns-text-button', () => loadResources(true)); retry.id = 'ns-resource-retry'; $('ns-resource-status').append(retry);
    }
  }
  function loadPreview(url) {
    const request = ++previewRequest, previous = $('ns-preview-image'), image = node('img'), status = $('ns-preview-status');
    image.id = 'ns-preview-image'; image.alt = previous.alt; image.hidden = true; previous.replaceWith(image); $('ns-preview-retry').hidden = true;
    $('ns-preview-meta').textContent = '';
    status.dataset.state = 'loading'; status.textContent = '正在读取原图…'; $('ns-preview-dialog').setAttribute('aria-busy', 'true');
    image.onload = () => { if (request !== previewRequest) return; image.hidden = false; $('ns-preview-meta').textContent = image.naturalWidth + ' × ' + image.naturalHeight + ' px · 原图'; status.textContent = ''; status.dataset.state = 'idle'; $('ns-preview-dialog').setAttribute('aria-busy', 'false'); };
    image.onerror = () => { if (request !== previewRequest) return; image.hidden = true; status.dataset.state = 'error'; status.textContent = '原图暂时无法读取，可以重试或返回来源项目。'; $('ns-preview-retry').hidden = false; $('ns-preview-dialog').setAttribute('aria-busy', 'false'); };
    image.src = url;
  }
  function showPreview(p, asset) {
    previewFocus = {container: 'ns-assets', project: p.projectId, sha: asset.assetSha256, shape: asset.shapeId || '', action: 'preview'};
    previewSource = p.projectId; $('ns-preview-title').textContent = asset.name || '画布图片'; $('ns-preview-origin').textContent = '来源项目：' + (p.projectName || '未命名项目'); $('ns-preview-image').alt = asset.name || '画布图片预览';
    $('ns-preview-dialog').dataset.source = assetURL(p.projectId, asset.assetSha256); $('ns-preview-dialog').showModal(); loadPreview($('ns-preview-dialog').dataset.source);
  }
  $('ns-preview-retry').addEventListener('click', () => loadPreview($('ns-preview-dialog').dataset.source));
  $('ns-preview-dialog').addEventListener('close', () => { previewRequest += 1; $('ns-preview-image').onload = null; $('ns-preview-image').onerror = null; if (route.page === 'resources') restoreCardFocus(previewFocus); });
  $('ns-preview-close').addEventListener('click', () => $('ns-preview-dialog').close()); $('ns-preview-source').addEventListener('click', () => { $('ns-preview-dialog').close(); openProject(previewSource, 'materials'); });
  function openUploadDialog() { const target = resourceTab === 'images' ? resourceProject : ''; if (target && project(target) && !project(target).archivedAt) { openProject(target, 'upload'); return; } const select = $('ns-upload-target'); select.replaceChildren(...projects.filter(p => !p.archivedAt).map(p => new Option(p.projectName || '未命名项目', p.projectId))); if (project(lastWorkspaceId) && !project(lastWorkspaceId).archivedAt) select.value = lastWorkspaceId; $('ns-upload-confirm').disabled = !projects.some(p => !p.archivedAt); $('ns-upload-dialog').showModal(); }
  $('ns-resource-upload').addEventListener('click', openUploadDialog); $('ns-upload-close').addEventListener('click', () => $('ns-upload-dialog').close()); $('ns-upload-form').addEventListener('submit', event => { event.preventDefault(); const id = $('ns-upload-target').value; if (!project(id)) return; $('ns-upload-dialog').close(); openProject(id, 'upload'); }); $('ns-upload-new').addEventListener('click', () => { $('ns-upload-dialog').close(); createProject(true, 'upload'); });
  document.querySelector('.ns-skip').addEventListener('click', event => { event.preventDefault(); $('ns-main').focus({preventScroll: true}); });
  $('ns-back').addEventListener('click', () => { if (navigationIndex > 0) history.back(); }); $('ns-forward').addEventListener('click', () => { if (navigationIndex < navigationMax) history.forward(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && route.page === 'resources' && resourceTab === 'images') loadResources(true); });
  document.documentElement.dataset.nvStudioReady = 'true';
  const homeStart = window.createHomeStart({api,node,button,notify,frameDocument,
    legacyBlocked:() => createBusy || createUncertain || recoveryDecisionBusy,
    composing:() => homeComposing, reloadProjects:() => loadProjects(true),project,openProject,
    current:entry => frames.get(entry.id) === entry && route.page === 'workspace' && route.projectId === entry.id && activeId === entry.id && !entry.slot.inert,
    goProjects:() => go('/projects'),invalidateAssets:id => assetCache.delete(id),
    refreshImportedFrame:entry => {
      if (frames.get(entry.id) !== entry || activeId !== entry.id || route.page !== 'workspace') return;
      clearTimeout(entry.timer); entry.focusCleanup?.(); entry.slot.remove(); frames.delete(entry.id); ensureWorkspace(entry.id);
    },
    showRequirements:entry => { entry.pendingPanel = 'requirements'; panelCommand(entry); }
  });
  const debug = Object.freeze({snapshot() { return {homeStart:homeStart.snapshot(), route: routePath(), activeProjectId: activeId, lastProjectId: lastWorkspaceId, stateLoaded: metaLoaded, stateRevision: savedState.revision, profileDirty, brandDirty, favoritesDirty, metadataConflict: metaConflict, projectCount: projects.length, archivedCount: projects.filter(p => p.archivedAt).length, libraryScope, archiveBusy, resourcesBusy, resourcesError, frames: [...frames.values()].map(entry => { const r = entry.frame.getBoundingClientRect(); return {projectId: entry.id, ready: entry.ready, active: entry.slot.dataset.active === 'true', inert: entry.slot.inert, visibility: getComputedStyle(entry.slot).visibility, geometry: {x: r.x, y: r.y, width: r.width, height: r.height}}; })}; }});
  Object.defineProperty(window, 'NovartStudio', {value: debug, writable: false, configurable: false});
  window.addEventListener('pagehide', () => { focusReturnIntent = null; frames.forEach(entry => entry.focusCleanup?.()); }, {once: true});
  restoreRecovery(); initializeNavigation(); metaControls(); fillMetaForms(); activateRoute(); lastActivatedPath = currentPath(); loadState();
})();
