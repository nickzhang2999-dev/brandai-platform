'use strict';
// Execute the actual startup prefix through its first-party adapter boundary.
// Synthetic lifecycle events verify dependency routing, not browser/business/
// provider acceptance. Real blocked-worker app acceptance runs separately.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../deploy/novart/studio/novart-product-bootstrap.js'), 'utf8');
const begin = source.indexOf('  async function start() {');
const end = source.indexOf('    for (const source of adapters)', begin);
assert(begin >= 0 && end > begin, 'Product startup test boundary changed');
const startup = source.slice(begin, end) + '    return adapters;\n  }';
const flush = () => new Promise(resolve => setImmediate(resolve));
let passed = 0;

function fixture(pathname, mode = 'uncontrolled', workspaceId = 'fixture-workspace') {
  const access = [], events = new Map(), timers = new Map(), historyCalls = [];
  let timerId = 0, resolveReady, brands = 0;
  const pendingReady = new Promise(resolve => { resolveReady = resolve; });
  const service = {
    controller: mode === 'controlled' ? {scriptURL: 'https://product.invalid/novart-product-worker.js'}
      : mode === 'stale' ? {scriptURL: 'https://product.invalid/share-worker.js'} : null,
    register(url, options) {
      access.push('register'); assert.equal(url, '/novart-product-worker.js'); assert.equal(options.scope, '/');
      return mode === 'blocked' ? Promise.reject(new Error('Service worker registration blocked')) : Promise.resolve({});
    },
    get ready() { access.push('ready'); return mode === 'pending' ? pendingReady : Promise.resolve({}); },
    addEventListener(type, callback, options) { events.set(type, {callback, once: options?.once}); },
  };
  const navigator = new Proxy(mode === 'missing' ? {} : {serviceWorker: service}, {
    has(target, property) { access.push('has:' + String(property)); return Reflect.has(target, property); },
    get(target, property) { access.push('get:' + String(property)); return Reflect.get(target, property); },
  });
  const href = 'https://product.invalid' + pathname + '?workspaceId=fixture-workspace#/home';
  const start = vm.runInNewContext('(' + startup + ')', {
    context: {workspaceId}, navigator, location: {pathname, href},
    history: {state: null, replaceState(...args) { historyCalls.push(args); }},
    createBrand: async () => { brands++; }, Error,
    setTimeout(callback, delay) { assert.equal(delay, 12000); const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  function controlled() {
    service.controller = {scriptURL: 'https://product.invalid/novart-product-worker.js'};
    const event = events.get('controllerchange');
    if (event?.once) events.delete('controllerchange');
    event?.callback();
  }
  return {start, access, events, timers, historyCalls, service, controlled, resolveReady,
    brands: () => brands, href};
}

(async () => {
  for (const pathname of ['/studio', '/studio/']) {
    for (const mode of ['missing', 'blocked', 'pending', 'uncontrolled', 'stale']) {
      const f = fixture(pathname, mode);
      let done = false, result, error;
      f.start().then(value => { result = value; done = true; }, value => { error = value; done = true; });
      await flush();
      assert.equal(done, true, pathname + ' must reach adapters without waiting for ' + mode + ' worker');
      assert.equal(error, undefined, pathname + ' first-party startup must ignore worker availability');
      assert.deepEqual(Array.from(result), ['/novart-product-task-inbox.js']);
      assert.equal(f.access.length, 0, pathname + ' must not even inspect/register the service worker');
      assert.equal(f.timers.size, 0); assert.equal(f.events.size, 0);
      assert.equal(f.historyCalls.length, 1); assert.equal(f.historyCalls[0][2], f.href);
      passed++;
    }
  }
  for (const pathname of ['/studio', '/canvas']) {
    const f = fixture(pathname, 'missing', null);
    await f.start(); assert.equal(f.brands(), 1); assert.equal(f.access.length, 0);
    assert.equal(f.historyCalls.length, 0, 'Missing workspace keeps its existing brand creation gate'); passed++;
  }
  let f = fixture('/canvas', 'missing');
  await assert.rejects(f.start(), /新版 Chrome 或 Edge/); passed++;
  f = fixture('/canvas', 'blocked');
  await assert.rejects(f.start(), /registration blocked/); passed++;
  f = fixture('/canvas', 'controlled');
  assert.deepEqual(Array.from(await f.start()), ['/novart-product-materials.js', '/novart-product-generation.js', '/novart-product-task-inbox.js']);
  assert(f.access.includes('register') && f.access.includes('ready')); assert.equal(f.timers.size, 0); passed++;
  f = fixture('/canvas', 'pending');
  let done = false; const waiting = f.start().then(value => { done = true; return value; });
  await flush(); assert.equal(done, false, 'Legacy canvas still waits for worker readiness');
  // Control changes before ready resumes must still be noticed via the current
  // controller; the old compatibility path must not require another event.
  f.controlled(); f.resolveReady({}); await waiting; assert.equal(f.timers.size, 0); passed++;
  f = fixture('/canvas');
  const cold = f.start(); await flush(); assert.equal(f.timers.size, 1);
  f.controlled(); await cold; assert.equal(f.timers.size, 0); assert.equal(f.events.size, 0); passed++;
  f = fixture('/canvas');
  const timedOut = f.start(); const rejected = assert.rejects(timedOut, /资源初始化超时/);
  await flush(); assert.equal(f.timers.size, 1);
  const [id, timer] = [...f.timers][0]; f.timers.delete(id); timer(); await rejected; passed++;
  console.log(JSON.stringify({passed, scope: 'source-driven-first-party-startup-and-legacy-gate', businessAcceptance: false}));
})().catch(error => { console.error(error); process.exitCode = 1; });
