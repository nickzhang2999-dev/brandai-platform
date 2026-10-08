/* Protect IME Escape in the existing requirement inputs; leave its default intact. */
(() => {
  'use strict';
  const query = new URLSearchParams(location.search);
  const single = (key, value) => query.getAll(key).length === 1 && query.get(key) === value;
  const canvasPath = path => path === '/canvas' || path === '/canvas/';
  const projectId = query.get('projectId');
  if (parent === window || !canvasPath(location.pathname) || !single('inputGuard', 'm10') || !single('studio', '1') || !single('ui', 'novart') || query.getAll('projectId').length !== 1 || !/^[a-zA-Z0-9_-]{1,128}$/.test(projectId || '')) return;
  try {
    const frame = window.frameElement, url = new URL(frame?.src || '', location.href);
    if (parent.location.origin !== location.origin || !frame || frame.ownerDocument.defaultView !== parent || url.origin !== location.origin || !canvasPath(url.pathname) || url.search !== location.search) return;
  } catch (_) { return; }

  let composingTarget = null;
  const editable = target => {
    if (!(target instanceof Element)) return null;
    const panel = target.closest('#novart-context');
    if (!panel || panel.hidden || panel.inert || target.closest('[hidden],[inert]')) return null;
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return target.disabled || target.readOnly ? null : target;
    return target.isContentEditable ? target : null;
  };
  const start = event => { const target = editable(event.target); if (target) composingTarget = target; };
  const end = event => { if (event.target === composingTarget) composingTarget = null; };
  const keyboard = event => {
    if (event.key !== 'Escape') return;
    const target = editable(event.target);
    if (target && (event.isComposing || event.keyCode === 229 || composingTarget === target)) event.stopImmediatePropagation();
  };
  window.addEventListener('compositionstart', start, true);
  window.addEventListener('compositionend', end, true);
  window.addEventListener('focusout', end, true);
  window.addEventListener('keydown', keyboard, true);
  document.documentElement.dataset.nvInputGuardReady = 'true';
  window.addEventListener('pagehide', () => {
    composingTarget = null;
    window.removeEventListener('compositionstart', start, true);
    window.removeEventListener('compositionend', end, true);
    window.removeEventListener('focusout', end, true);
    window.removeEventListener('keydown', keyboard, true);
  }, {once: true});
})();
