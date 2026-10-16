'use strict';
// Execute owned startup and exact legacy registration retirement. Synthetic
// browser lifecycle fixtures do not constitute product/business acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../deploy/novart/studio/novart-product-bootstrap.js'), 'utf8');
const begin = source.indexOf('  async function start() {');
const end = source.indexOf('    for (const source of adapters)', begin);
const retireBegin = source.indexOf('  async function retireLegacyWorker() {');
const retireEnd = source.indexOf('  void retireLegacyWorker();', retireBegin);
assert(begin >= 0 && end > begin && retireBegin > end && retireEnd > retireBegin, 'Owned startup boundaries changed');
const startup = source.slice(begin, end) + '    return adapters;\n  }';
const retirement = source.slice(retireBegin, retireEnd);
const flush = () => new Promise(resolve => setImmediate(resolve));
const origin = 'https://product.invalid';
let passed = 0;
function fixture({pathname = '/studio', workspaceId = 'fixture-workspace', mode = 'missing', registrations = []} = {}) {
  const access = [], historyCalls = [];
  let brands = 0;
  const navigator = mode === 'missing' ? {} : {serviceWorker: {
    getRegistrations() {
      access.push('getRegistrations');
      if (mode === 'blocked') return Promise.reject(Error('Browser storage unavailable'));
      if (mode === 'pending') return new Promise(() => {});
      return Promise.resolve(registrations);
    },
    register() { throw Error('New service workers must never be registered'); },
    get ready() { throw Error('Startup must never wait for worker readiness'); },
    get controller() { throw Error('Startup must never wait for controller takeover'); },
    addEventListener() { throw Error('No controllerchange listeners are needed'); },
  }};
  const href = origin + pathname + '?workspaceId=fixture-workspace#/home';
  const sandbox = {context: {workspaceId}, navigator, location: {pathname, href, origin}, URL,
    history: {state: null, replaceState(...args) { historyCalls.push(args); }},
    createBrand: async () => { brands++; },
  };
  const functions = vm.runInNewContext('(() => {' + startup + retirement + ';return {start, retireLegacyWorker};})()', sandbox);
  return {...functions, access, historyCalls, href, brands: () => brands};
}
function registration({scope = origin + '/', active = origin + '/novart-product-worker.js', waiting, installing, rejects = false} = {}) {
  let calls = 0;
  return {scope, active: active ? {scriptURL: active} : null,
    waiting: waiting ? {scriptURL: waiting} : null, installing: installing ? {scriptURL: installing} : null,
    unregister() { calls++; return rejects ? Promise.reject(Error('Browser denied retirement')) : Promise.resolve(true); },
    calls: () => calls,
  };
}
(async () => {
  for (const pathname of ['/studio', '/studio/']) {
    for (const mode of ['missing', 'blocked', 'pending', 'registered']) {
      const f = fixture({pathname, mode});
      const retiring = f.retireLegacyWorker();
      let done = false, result;
      f.start().then(value => { result = value; done = true; });
      await flush();
      assert.equal(done, true, pathname + ' startup does not depend on old registration enumeration');
      assert.deepEqual(Array.from(result), ['/novart-product-task-inbox.js']);
      assert.equal(f.historyCalls.length, 1); assert.equal(f.historyCalls[0][2], f.href);
      if (mode !== 'pending') await retiring;
      passed++;
    }
  }
  const missing = fixture({workspaceId: null});
  await missing.start(); assert.equal(missing.brands(), 1); assert.equal(missing.historyCalls.length, 0); passed++;
  const owned = registration();
  const sameWaiting = registration({waiting: origin + '/novart-product-worker.js?v=old'});
  const installingOnly = registration({active: null, installing: origin + '/novart-product-worker.js'});
  const unrelated = [registration({scope: origin + '/another-app/'}), registration({scope: 'https://other.invalid/'}),
    registration({active: origin + '/share-worker.js'}), registration({active: 'https://other.invalid/novart-product-worker.js'}),
    registration({waiting: origin + '/another-worker.js'}), registration({installing: origin + '/another-worker.js'}), registration({active: null})];
  await fixture({mode: 'registered', registrations: [owned, sameWaiting, installingOnly, ...unrelated]}).retireLegacyWorker();
  for (const item of [owned, sameWaiting, installingOnly]) { assert.equal(item.calls(), 1); passed++; }
  for (const item of unrelated) { assert.equal(item.calls(), 0, 'Other apps and mixed registration updates are preserved'); passed++; }
  const rejected = registration({rejects: true});
  await fixture({mode: 'registered', registrations: [rejected]}).retireLegacyWorker();
  assert.equal(rejected.calls(), 1); passed++;
  assert(source.includes('void retireLegacyWorker();'), 'Migration must remain detached from startup');
  assert(!/await\s+retireLegacyWorker\(/.test(source));
  assert(!/serviceWorker\s*\.\s*register\s*\(/.test(source));
  console.log(JSON.stringify({passed, scope: 'owned-startup-and-exact-legacy-registration-retirement', businessAcceptance: false}));
})().catch(error => { console.error(error); process.exitCode = 1; });
