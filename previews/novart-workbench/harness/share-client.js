/* The captured OSS client constructs HTTP URLs. Resolve those to the demo
   server before browser mixed-content checks, without changing native records. */
(() => {
  window.__NOVART_SHARED_DEMO__ = true;
  const localUpload = value => {
    try {
      const url = new URL(String(value), location.href);
      if (url.hostname === 'models-online-persist-us.oss-accelerate.aliyuncs.com')
        return '/share-resource?url=' + encodeURIComponent(url.href);
    } catch (_) {}
    return value;
  };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    return open.call(this, method, localUpload(url), ...rest);
  };
})();

/* Bounded, content-free startup evidence for the private review service.
   Never send document data, image URLs, error messages, cookies or full stacks. */
(() => {
  if (!['/studio', '/canvas'].includes(location.pathname)) return;
  const role = location.pathname === '/canvas' ? 'canvas' : 'shell';
  const names = new Set(['Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'ChunkLoadError']);
  const stages = new Set(['opened', 'timeout', 'ready', 'error']);
  let sent = 0;
  const seen = new Set();
  function sample(stage) {
    let doc = document, win = window, framePath = 'none', frame = null;
    if (role === 'shell') {
      frame = document.querySelector('.ns-frame-slot[data-active="true"] iframe');
      if (frame) {
        try {
          framePath = frame.contentWindow.location.pathname;
          if (frame.contentWindow.location.href === 'about:blank') framePath = 'about:blank';
          if (!['/canvas', '/studio', '/share-start', 'about:blank'].includes(framePath)) framePath = 'unavailable';
          if (frame.contentDocument) { doc = frame.contentDocument; win = frame.contentWindow; }
        } catch (_) { framePath = 'unavailable'; }
      }
    }
    const canvas = doc.querySelector('[data-testid="canvas"]');
    const rect = (frame || canvas || doc.documentElement).getBoundingClientRect();
    const dimension = value => Number.isFinite(value) ? Math.min(10000, Math.max(0, Math.round(value))) : 0;
    return {kind: 'state', role, stage, embedded: parent !== window, framePath,
      controlled: Boolean(win.navigator.serviceWorker?.controller), canvas: Boolean(canvas),
      toolbar: Boolean(doc.querySelector('[data-testid="bottom-toolbar"]')),
      boundary: Boolean(doc.querySelector('.tl-error-boundary')),
      width: dimension(rect.width), height: dimension(rect.height)};
  }
  function capture(stage, detail = {}) {
    if (!stages.has(stage) || sent >= 8) return;
    const payload = {...sample(stage), ...detail};
    if (stage === 'timeout' && payload.canvas && payload.toolbar && !payload.boundary) payload.stage = 'ready';
    const body = JSON.stringify(payload);
    if (seen.has(body)) return;
    seen.add(body); sent++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    fetch('/review/startup-diagnostics', {method: 'POST', credentials: 'same-origin',
      headers: {'Content-Type': 'application/json'}, body, signal: controller.signal})
      .catch(() => {}).finally(() => clearTimeout(timer));
  }
  function failure(error, filename, line, column) {
    const frames = [...String(error?.stack || '').matchAll(/([A-Za-z0-9_.-]+\.js):([0-9]+):([0-9]+)/g)]
      .map(match => match[0]).filter(value => value.length <= 120).slice(0, 4);
    if (!frames.length && filename && Number.isInteger(line) && Number.isInteger(column)) {
      try {
        const file = new URL(filename, location.href).pathname.split('/').pop();
        const source = file + ':' + line + ':' + column;
        if (/^[A-Za-z0-9_.-]+\.js$/.test(file) && source.length <= 120) frames.push(source);
      } catch (_) {}
    }
    capture('error', {kind: 'error', errorName: names.has(error?.name) ? error.name : 'Other', frames});
  }
  window.addEventListener('error', event => {
    const tag = event.target?.tagName;
    if (tag === 'SCRIPT' || tag === 'LINK') {
      try {
        const file = new URL(event.target.src || event.target.href, location.href).pathname.split('/').pop();
        if (/^[A-Za-z0-9_.-]+\.(js|css)$/.test(file) && file.length <= 120)
          capture('error', {kind: 'error', errorName: 'Other', resource: file});
      } catch (_) {}
      return;
    }
    failure(event.error, event.filename, event.lineno, event.colno);
  }, true);
  window.addEventListener('unhandledrejection', event => failure(event.reason));
  window.addEventListener('novart-startup-check', () => capture('timeout'));
  window.addEventListener('message', event => {
    if (role !== 'shell' || event.origin !== location.origin || event.data?.type !== 'nv-studio') return;
    const frame = document.querySelector('.ns-frame-slot[data-active="true"] iframe');
    if (!frame || event.source !== frame.contentWindow) return;
    if (event.data.action === 'startup-error') capture('error');
    if (event.data.action === 'ready') capture('ready');
  });
  let timer;
  function opened() {
    capture('opened');
    timer = setTimeout(() => capture('timeout'), 22000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', opened, {once: true});
  else opened();
  window.addEventListener('pagehide', () => clearTimeout(timer), {once: true});
})();
