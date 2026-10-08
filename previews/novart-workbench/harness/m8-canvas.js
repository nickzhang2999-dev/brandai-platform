/* Same-origin navigation for the frontend studio; native editor state stays native. */
(() => {
  'use strict';
  const query = new URLSearchParams(location.search);
  if (query.get('studio') !== '1' || query.get('ui') !== 'novart' || parent === window) return;
  const projectId = query.get('projectId');
  if (!projectId) return;
  let ready = false, observer = null;
  const send = (action, extra = {}) => parent.postMessage({type: 'nv-studio', action, projectId, ...extra}, location.origin);
  const usable = node => node && !node.closest('[hidden],[inert]') && !node.disabled;

  function install() {
    const back = document.querySelector('#novart-bar .nv-back');
    if (!back || !document.querySelector('#nv-workflow-toggle') || document.documentElement.dataset.nvMotionReady !== 'true') return;
    back.removeAttribute('target');
    back.href = '/studio#/projects';
    back.title = '返回项目库，保留当前画布会话';
    back.setAttribute('aria-label', '返回项目库');
    document.documentElement.dataset.nvStudioCanvasReady = 'true';
    ready = true;
    observer?.disconnect();
    observer = null;
    send('ready');
  }

  function navigate(event) {
    const target = event.target instanceof Element ? event.target.closest('a') : null;
    if (!target || !usable(target)) return;
    if (target.matches('#novart-bar .nv-back')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      send('navigate', {route: 'projects'});
      return;
    }
    if (!target.closest('#novart-switcher')) return;
    const url = new URL(target.href, location.href);
    const next = url.searchParams.get('projectId');
    if (url.origin !== location.origin || url.pathname !== '/canvas' || !next) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const switcher = document.getElementById('novart-switcher');
    const toggle = document.getElementById('nv-project-switch');
    if (switcher && !switcher.hidden) toggle?.click();
    send('open-project', {targetProjectId: next});
  }

  function command(event) {
    if (event.origin !== location.origin || event.source !== parent || !ready) return;
    const data = event.data;
    if (!data || data.type !== 'nv-studio' || data.projectId !== projectId) return;
    if (data.action === 'preferences') {
      if (data.motion === 'system' || data.motion === 'reduce') {
        document.documentElement.dataset.nvStudioMotion = data.motion;
      }
      return;
    }
    if (data.action !== 'open-panel') return;
    const actions = {
      requirements: ['novart-context', 'nv-context-toggle'],
      materials: ['novart-workflow', 'nv-workflow-toggle']
    };
    if (actions[data.panel]) {
      const [panelId, buttonId] = actions[data.panel];
      const panel = document.getElementById(panelId), button = document.getElementById(buttonId);
      if (!panel || !usable(button)) return send('panel-result', {panel: data.panel, status: 'unavailable'});
      if (panel.hidden) button.click();
      send('panel-result', {panel: data.panel, status: panel.hidden ? 'unavailable' : 'opened'});
    } else if (data.panel === 'upload') {
      const button = document.querySelector('[data-testid="nav-upload-menu-button"]');
      if (!usable(button)) return send('panel-result', {panel: 'upload', status: 'unavailable'});
      button.click();
      send('panel-result', {panel: 'upload', status: 'opened'});
    }
  }

  window.addEventListener('click', navigate, true);
  window.addEventListener('message', command);
  observer = new MutationObserver(install);
  observer.observe(document.documentElement, {subtree: true, childList: true, attributes: true,
    attributeFilter: ['data-nv-motion-ready']});
  install();
  window.addEventListener('pagehide', () => {
    observer?.disconnect();
    window.removeEventListener('click', navigate, true);
    window.removeEventListener('message', command);
  }, {once: true});
})();
