/* Run the actual framed-editor bridge without browser/network/project data. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../previews/novart-workbench/harness/m8-canvas.js'), 'utf8');
const selectors = {
  back: '#novart-bar .nv-back', workflow: '#nv-workflow-toggle',
  canvas: '[data-testid="canvas"]', toolbar: '[data-testid="bottom-toolbar"]',
  upload: '[data-testid="upload-menu-trigger"]', error: '.tl-error-boundary'
};

function fixture({shell = true, native = false, failed = false, motion = true, failure = ''} = {}) {
  const nodes = new Map(), messages = [], listeners = new Map();
  const back = {removeAttribute() {}, setAttribute() {}};
  if (shell) { nodes.set(selectors.back, back); nodes.set(selectors.workflow, {}); }
  if (native) for (const key of ['canvas', 'toolbar', 'upload']) nodes.set(selectors[key], {});
  if (failed) nodes.set(selectors.error, {textContent: 'private error content must not be sent'});
  const document = {documentElement: {dataset: {nvMotionReady: String(motion), novartNativeFailure: failure}},
    querySelector: selector => nodes.get(selector) || null};
  let observer;
  const window = {
    addEventListener: (type, callback) => listeners.set(type, callback),
    removeEventListener: (type, callback) => { if (listeners.get(type) === callback) listeners.delete(type); }
  };
  const context = {document, window, URLSearchParams, Element: class {},
    location: {search: '?studio=1&ui=novart&projectId=readiness-test', origin: 'https://review.invalid'},
    parent: {postMessage(data, origin) { messages.push({data: JSON.parse(JSON.stringify(data)), origin}); }},
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.connected = false; observer = this; }
      observe(_target, options) { this.connected = true; this.options = options; }
      disconnect() { this.connected = false; }
    }
  };
  vm.runInNewContext(source, context);
  return {nodes, messages, document, listeners,
    mutate() { if (observer.connected) observer.callback(); },
    connected: () => observer.connected, observedAttributes: () => observer.options.attributeFilter};
}

let checks = 0;
{
  const f = fixture();
  assert.deepEqual(f.messages, []);
  assert.notEqual(f.document.documentElement.dataset.nvStudioCanvasReady, 'true');
  f.nodes.set(selectors.canvas, {}); f.mutate();
  assert.deepEqual(f.messages, [], 'Canvas without toolbar is not ready');
  f.nodes.set(selectors.toolbar, {}); f.mutate();
  assert.deepEqual(f.messages, [], 'Toolbar without its actual upload control is not ready');
  checks += 3;
  f.nodes.set(selectors.upload, {}); f.mutate();
  assert.deepEqual(f.messages, [{data: {type: 'nv-studio', action: 'ready', projectId: 'readiness-test'}, origin: 'https://review.invalid'}]);
  assert.equal(f.document.documentElement.dataset.nvStudioCanvasReady, 'true');
  f.mutate();
  assert.equal(f.messages.length, 1, 'Subsequent mutations must not duplicate ready');
  checks += 1;
}
{
  const f = fixture({native: true, motion: false});
  assert.deepEqual(f.messages, []);
  f.document.documentElement.dataset.nvMotionReady = 'true'; f.mutate();
  assert.equal(f.messages[0]?.data.action, 'ready');
  checks += 1;
}
{
  const f = fixture({failed: true, shell: false});
  assert.deepEqual(f.messages, [{data: {type: 'nv-studio', action: 'startup-error', projectId: 'readiness-test', code: 'NATIVE_CANVAS_FAILED'}, origin: 'https://review.invalid'}]);
  assert.equal(f.document.documentElement.dataset.nvStudioCanvasReady, 'false');
  assert.equal(f.connected(), false);
  f.nodes.delete(selectors.error);
  for (const key of ['back', 'workflow', 'canvas', 'toolbar', 'upload']) f.nodes.set(selectors[key], {});
  f.mutate();
  assert.equal(f.messages.length, 1, 'A failed frame must be reopened, never report a later ready');
  assert.equal(JSON.stringify(f.messages).includes('private'), false);
  checks += 1;
}
{
  const f = fixture({native: true, failed: true});
  assert.deepEqual(f.messages.map(m => m.data.action), ['startup-error'], 'Error wins over simultaneously present editor nodes');
  checks += 1;
}
{
  const f = fixture({native: true});
  f.nodes.set(selectors.error, {}); f.mutate(); f.mutate();
  assert.deepEqual(f.messages.map(m => m.data.action), ['ready', 'startup-error']);
  assert.equal(f.document.documentElement.dataset.nvStudioCanvasReady, 'false');
  assert.equal(f.connected(), false);
  checks += 1;
}
{
  const f = fixture();
  f.listeners.get('pagehide')();
  assert.equal(f.connected(), false);
  for (const key of ['canvas', 'toolbar', 'upload']) f.nodes.set(selectors[key], {});
  f.mutate();
  assert.deepEqual(f.messages, [], 'A page being unloaded must not report readiness');
  assert.equal(f.listeners.has('message'), false);
  checks += 1;
}
for (const failure of ['bootstrap', 'canvas-crash']) {
  const f = fixture({native: true, failure});
  assert.deepEqual(f.messages.map(m => m.data.action), ['startup-error'], 'Handled native failures must override present editor nodes');
  assert.equal(f.document.documentElement.dataset.nvStudioCanvasReady, 'false');
  assert.ok(f.observedAttributes().includes('data-novart-native-failure'), 'The bridge must observe the actual marker written by the diagnostic sender');
  checks += 1;
}
{
  const f = fixture({native: true});
  f.document.documentElement.dataset.novartNativeFailure = 'canvas-crash';
  f.nodes.delete(selectors.canvas); f.nodes.delete(selectors.toolbar); f.mutate();
  assert.deepEqual(f.messages.map(m => m.data.action), ['ready', 'startup-error'], 'Handled runtime crashes revoke readiness even without a tldraw error boundary');
  assert.equal(f.connected(), false);
  checks += 1;
}
{
  const f = fixture({native: true, failure: 'unrecognized'});
  assert.equal(f.messages[0]?.data.action, 'ready', 'Only fixed native failure markers affect readiness');
  checks += 1;
}
// Parent-side readiness must not hide a failed frame or discard a different
// cached editing session when the user retries this frame.
const studioSource = fs.readFileSync(path.join(__dirname, '../previews/novart-workbench/harness/home-start-studio.js'), 'utf8');
const parentStart = studioSource.indexOf('  function workspaceStartupFailed(');
const parentEnd = studioSource.indexOf('  async function ensureWorkspace(', parentStart);
assert.ok(parentStart >= 0 && parentEnd > parentStart);
function parentFixture({ready = false, active = true} = {}) {
  let removed = 0;
  const entry = {id: 'target', ready, timer: 1, frame: {dataset: {}}, slot: {remove() { removed++; }}};
  const other = {id: 'other', ready: true};
  const frames = new Map([[entry.id, entry], [other.id, other]]), messages = [], reopened = [];
  const context = {frames, activeId: active ? entry.id : other.id, route: {page: 'workspace'}, clearTimeout() {},
    window: {dispatchEvent() {}}, Event: class {},
    $: () => ({replaceChildren(...children) { messages.push(children); }}),
    node: (_tag, _class, text) => ({text}), button: (label, _class, click) => ({label, click}),
    go() {}, ensureWorkspace(id) { reopened.push(id); }};
  const fail = vm.runInNewContext('(' + studioSource.slice(parentStart, parentEnd).trim() + ')', context);
  return {entry, other, frames, messages, reopened, fail: reason => fail(entry, reason), removed: () => removed};
}
{
  const f = parentFixture(); f.fail();
  assert.equal(f.entry.startupError, 'timeout'); assert.equal(f.messages.length, 1);
  const retry = f.messages[0].find(x => x.label === '重新打开画布'); assert.ok(retry);
  retry.click();
  assert.deepEqual(f.reopened, ['target']); assert.equal(f.removed(), 1);
  assert.equal(f.frames.get('other'), f.other, 'Retry must preserve another cached editor');
  checks += 1;
}
{
  const f = parentFixture({ready: true}); f.fail();
  assert.equal(f.entry.ready, true); assert.equal(f.messages.length, 0, 'A late loading timeout cannot revoke ready');
  f.fail('native-error');
  assert.equal(f.entry.ready, false); assert.equal(f.entry.frame.dataset.ready, 'false');
  assert.equal(f.entry.failedAfterReady, true); assert.equal(f.messages.length, 1);
  checks += 2;
}
{
  const f = parentFixture({active: false}); f.fail('native-error');
  assert.equal(f.entry.startupError, 'native-error'); assert.equal(f.messages.length, 0, 'Inactive failure cannot cover the active editor');
  checks += 1;
}
{
  const f = parentFixture(); f.fail();
  const retry = f.messages[0].find(x => x.label === '重新打开画布');
  f.entry.ready = true; retry.click();
  assert.equal(f.removed(), 0, 'A stale retry button must not discard a now-ready editor');
  checks += 1;
}
console.log(`Native canvas readiness: ${checks} checks passed (no browser or network).`);
