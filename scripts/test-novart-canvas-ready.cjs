/* Actual parent shell readiness, retry and message-origin guard; synthetic frame fixtures. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
let checks = 0;
// Parent-side readiness must not hide a failed frame or discard a different
// cached editing session when the user retries this frame.
const studioSource = fs.readFileSync(path.join(__dirname, '../apps/web/studio-shell/home-start-studio.js'), 'utf8');
const parentStart = studioSource.indexOf('  function workspaceStartupFailed(');
const parentEnd = studioSource.indexOf('  async function ensureWorkspace(', parentStart);
assert.ok(parentStart >= 0 && parentEnd > parentStart);
function parentFixture({ready = false, active = true} = {}) {
  let removed = 0;
  const entry = {id: 'target', ready, timer: 1, frame: {dataset: {}, contentWindow: {}}, slot: {remove() { removed++; }}};
  const other = {id: 'other', ready: true};
  const frames = new Map([[entry.id, entry], [other.id, other]]), messages = [], reopened = [], listeners = new Map(), unavailable = [];
  const context = {frames, activeId: active ? entry.id : other.id, route: {page: 'workspace'}, clearTimeout() {},
    location: {origin: 'https://review.invalid'},
    window: {dispatchEvent() {}, addEventListener(type, callback) { listeners.set(type, callback); }}, Event: class {},
    homeStart: {canvasUnavailable(entry) { unavailable.push(entry.id); }},
    $: () => ({replaceChildren(...children) { messages.push(children); }}),
    node: (_tag, _class, text) => ({text}), button: (label, _class, click) => ({label, click}),
    go() {}, ensureWorkspace(id) { reopened.push(id); }};
  const fail = vm.runInNewContext('(' + studioSource.slice(parentStart, parentEnd).trim() + ')', context);
  context.workspaceStartupFailed = fail;
  const messageStart = studioSource.indexOf("  window.addEventListener('message', event => {");
  const messageEnd = studioSource.indexOf('\n  function validState(', messageStart);
  assert.ok(messageStart >= 0 && messageEnd > messageStart);
  vm.runInNewContext(studioSource.slice(messageStart, messageEnd), context);
  return {entry, other, frames, messages, reopened, unavailable, listeners, fail: reason => fail(entry, reason), removed: () => removed};
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
{
  const f = parentFixture({ready: true});
  const data = {type:'nv-studio',action:'startup-error',projectId:'target',code:'OWNED_CANVAS_FAILED'};
  const message = f.listeners.get('message');
  message({origin:'https://other.invalid',source:f.entry.frame.contentWindow,data});
  message({origin:'https://review.invalid',source:{},data});
  assert.equal(f.entry.ready, true); assert.equal(f.messages.length, 0, 'Foreign origins and unrelated frame sources cannot fail the editor');
  message({origin:'https://review.invalid',source:f.entry.frame.contentWindow,data});
  assert.equal(f.entry.startupError, 'native-error');
  assert.equal(f.entry.ready, false);
  assert.equal(f.messages.length, 1, 'An authenticated frame failure produces a visible recovery action');
  checks += 2;
}
console.log(`Owned canvas parent readiness: ${checks} checks passed (no browser or network).`);
