/* Pure function regression for the handoff/native-editor readiness boundary.
   Runs captured source without a browser, network, DOM runtime or stored projects. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'previews/novart-workbench/harness/home-start-attachments.js'), 'utf8');
const start = source.indexOf('  function readNative(entry) {');
const end = source.indexOf('  const delay =', start);
assert.ok(start >= 0 && end > start, 'Native-readiness function source anchors must exist');
const functionSource = source.slice(start, end);

function reader({failed = false, mounted = false, registered = false, available = true, failure = ''} = {}) {
  const calls = {registry: 0, module: 0, editor: 0};
  const shapes = [{id: 'shape:diagnostic'}];
  const app = {getEditor() { calls.editor++; return {getCurrentPageShapes() { return shapes; }}; }};
  const requireModule = id => { assert.equal(id, 37750); calls.module++; return {pW: app}; };
  requireModule.m = registered ? {37750() {}} : {};
  const win = {webpackChunk_lovartai_lovart_shell: {push(chunk) { calls.registry++; chunk[2](requireModule); }}};
  const doc = {documentElement: {dataset: {novartNativeFailure: failure}}, querySelector(selector) {
    if (selector === '.tl-error-boundary') return failed ? {} : null;
    return mounted ? {} : null;
  }};
  const context = {host: {frameDocument: () => available ? {win, doc} : null},
    crypto: {randomUUID: () => 'diagnostic-id'}, Error};
  const read = vm.runInNewContext('(' + functionSource.trim() + ')', context);
  return {read: () => read({}), calls, shapes};
}

{
  const fixture = reader({failed: true, mounted: true, registered: true});
  assert.throws(fixture.read, error => error.nativeStartup === true && error.message.includes('图片尚未导入'));
  assert.deepEqual(fixture.calls, {registry: 0, module: 0, editor: 0});
}
{
  const fixture = reader({mounted: false, registered: true});
  assert.equal(fixture.read(), null);
  assert.deepEqual(fixture.calls, {registry: 0, module: 0, editor: 0});
}
{
  const fixture = reader({mounted: true, registered: false});
  assert.equal(fixture.read(), null);
  assert.deepEqual(fixture.calls, {registry: 1, module: 0, editor: 0});
}
{
  const fixture = reader({mounted: true, registered: true});
  assert.equal(fixture.read(), fixture.shapes);
  assert.deepEqual(fixture.calls, {registry: 1, module: 1, editor: 1});
}
{
  const fixture = reader({available: false});
  assert.equal(fixture.read(), null);
  assert.deepEqual(fixture.calls, {registry: 0, module: 0, editor: 0});
}
for (const failure of ['bootstrap', 'canvas-crash']) {
  const fixture = reader({failure, mounted: true, registered: true});
  assert.throws(fixture.read, error => error.nativeStartup === true);
  assert.deepEqual(fixture.calls, {registry: 0, module: 0, editor: 0}, 'A caught native failure must stop upload handoff before accessing a stale editor');
}
console.log('Homepage handoff readiness: 7 checks passed (no browser or network).');
