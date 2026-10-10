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

function reader({failed = false, mounted = false, registered = false, available = true, failure = '', license = false} = {}) {
  const calls = {registry: 0, module: 0, editor: 0};
  const shapes = [{id: 'shape:diagnostic'}];
  const app = {getEditor() { calls.editor++; return {getCurrentPageShapes() { return shapes; }}; }};
  const requireModule = id => { assert.equal(id, 37750); calls.module++; return {pW: app}; };
  requireModule.m = registered ? {37750() {}} : {};
  const win = {webpackChunk_lovartai_lovart_shell: {push(chunk) { calls.registry++; chunk[2](requireModule); }}};
  const doc = {documentElement: {dataset: {novartNativeFailure: failure}}, querySelector(selector) {
    if (selector === '.tl-error-boundary') return failed ? {} : null;
    if (selector === '[data-testid="tl-license-expired"]') return license ? {} : null;
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
{
  const fixture = reader({license:true,mounted:true,registered:true});
  assert.throws(fixture.read, error => error.nativeLicense === true && error.message.includes('原始需求和图片仍保留'));
  assert.deepEqual(fixture.calls, {registry:0,module:0,editor:0}, 'License refusal stops access to an editor that is being removed');
}

const paintStart = source.indexOf('  function licenseState() {');
const paintEnd = source.indexOf('  function hide()', paintStart);
assert.ok(paintStart >= 0 && paintEnd > paintStart);
{
  const states = new Map(), runs = new Map(), buttons = [], displays = [];
  const box = {hidden:true,dataset:{},replaceChildren(...children) { displays.push(children); },append() {}};
  const context = {states,runs,current:() => true,
    $: id => id === 'hs-handoff' ? box : {classList:{add() {}}},
    node: (_tag,_class,text) => ({text,append() {}}),
    button: label => { buttons.push(label); return {}; },host:{goProjects() {}}};
  const functions = vm.runInNewContext('(function(){' + source.slice(paintStart,paintEnd) + ';return {paint,canvasUnavailable};})()',context);
  const entry = {id:'synthetic',frame:{},startupError:'license-required'};
  runs.set(entry.id,{});
  functions.canvasUnavailable(entry);
  assert.deepEqual(buttons,['返回项目库']);
  assert.equal(states.get(entry.id).licenseRequired,true);
  assert.ok(displays[0][2].text.includes('图片交接已停止'));
  buttons.length=0;
  functions.paint(entry,{kind:'loading',title:'old transfer status'});
  assert.deepEqual(buttons,['返回项目库']);
  assert.equal(states.get(entry.id).title,'画布引擎需要授权', 'Late transfer status cannot obscure the refusal');
}

async function checkTransferStops() {
  const runStart = source.indexOf('  async function run(entry) {');
  const runEnd = source.indexOf('  async function resume(',runStart);
  assert.ok(runStart >= 0 && runEnd > runStart);
  for (const failureAt of [1,3]) {
    const calls = {native:0,transfer:0,api:[],fetch:0}, painted=[];
    const error = new Error('Current domain requires a license'); error.nativeLicense = true;
    const job = {creationStatus:'ready',status:'pending',assets:[{sha256:'fixture',uploadName:'fixture.png'}],completedAssets:[],confirmedAssets:[]};
    const context = {current:() => true,
      api: async pathname => {calls.api.push(pathname); return job;},
      readNative() { if (++calls.native === failureAt) throw error; return []; },
      waitNative:async() => [],paint:(_entry,state) => painted.push(state),
      fetch:async() => {calls.fetch++;return {ok:true,blob:async() => ({})};},imageURL:() => '/synthetic',
      transfer:async() => {calls.transfer++;},delay:async() => {},
      licenseState:() => ({kind:'error',licenseRequired:true}),
      window:{addEventListener(_event,callback) {callback();}}};
    const run = vm.runInNewContext('('+source.slice(runStart,runEnd).trim()+')',context);
    await run({id:'synthetic'});
    assert.equal(painted.at(-1).licenseRequired,true);
    assert.equal(calls.transfer,failureAt === 1 ? 0 : 1);
    assert.equal(calls.api.length,1,'No more receipt reads or confirmations run after license refusal');
  }
}
checkTransferStops().then(() => console.log('Homepage handoff readiness: 11 checks passed (no browser or network).'))
  .catch(error => {console.error(error);process.exitCode=1;});
