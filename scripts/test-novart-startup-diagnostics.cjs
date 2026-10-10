// Run the real sender with private error text to enforce the telemetry boundary.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '../previews/novart-workbench');
const source = fs.readFileSync(path.join(root, 'harness/share-client.js'), 'utf8');

function fixture({pathname = '/canvas', consoleThrows = null} = {}) {
  const listeners = new Map(), reports = [], timers = new Map(), consoleCalls = [], dispatched = [];
  let timerId = 0;
  const nodes = new Map();
  const document = {readyState: 'complete', documentElement: {dataset: {},
    getBoundingClientRect: () => ({width: 1200, height: 720})},
    querySelector: selector => nodes.get(selector) || null};
  const navigator = {serviceWorker: {controller: {}}};
  const consoleResult = {};
  const consoleDouble = {error(...args) {
    consoleCalls.push({receiver: this, args});
    if (consoleThrows) throw consoleThrows;
    return consoleResult;
  }};
  const window = {navigator, console: consoleDouble,
    addEventListener(name, callback) { listeners.set(name, callback); },
    dispatchEvent(event) { dispatched.push(event); listeners.get(event.type)?.(event); return true; }};
  const location = {pathname, href: `https://review.invalid${pathname}?projectId=PRIVATE_PROJECT`, origin: 'https://review.invalid'};
  const context = vm.createContext({window, parent: {}, document, navigator, location, URL, AbortController, Event,
    console: consoleDouble, XMLHttpRequest: class { open() {} },
    setTimeout(callback, ms) { const id = ++timerId; timers.set(id, {callback, ms}); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch(url, options) { assert.equal(url, '/review/startup-diagnostics'); reports.push(JSON.parse(options.body)); return Promise.resolve({status: 202}); }});
  vm.runInContext(source, context);
  return {listeners, reports, timers, consoleCalls, dispatched, nodes, document, window, location,
    context, consoleDouble, consoleResult};
}

const privateError = {name: 'TypeError', message: 'PRIVATE_TEXT PRIVATE_TOKEN',
  stack: 'TypeError: PRIVATE_TEXT PRIVATE_TOKEN\n at https://review.invalid/static/app.123.js:1:55?token=PRIVATE_TOKEN\n at https://review.invalid/native.456.js:2:77'};
const assertPrivate = reports => {
  assert.equal(JSON.stringify(reports).includes('PRIVATE_'), false, 'No private message, query or project identifier may be sent');
  assert.equal(JSON.stringify(reports).includes('https://'), false, 'No complete source URL may be sent');
};

{
  const {reports, listeners, location, timers} = fixture();
  assert.equal(reports.length, 1); assert.equal(reports[0].role, 'canvas');
  assert.equal(reports[0].embedded, true); assert.equal(reports[0].controlled, true);
  listeners.get('error')({error: privateError, filename: location.href, lineno: 1, colno: 9});
  assert.equal(reports[1].errorName, 'TypeError');
  assert.deepEqual(reports[1].frames, ['app.123.js:1:55', 'native.456.js:2:77']);
  listeners.get('error')({target: {tagName: 'SCRIPT', src: 'https://review.invalid/static/failed.js?token=PRIVATE_TOKEN'}});
  assert.equal(reports[2].resource, 'failed.js');
  assertPrivate(reports);
  const before = reports.length; listeners.get('error')({error: privateError});
  assert.equal(reports.length, before, 'Repeated failures must be deduplicated');
  for (let i = 0; i < 20; i++) listeners.get('error')({error: {name: 'Error', stack: `at module.js:1:${i}`}});
  assert.equal(reports.length, 8, 'A page may report at most eight events');
  listeners.get('pagehide')();
  assert.ok([...timers.values()].every(t => t.ms !== 22000), 'Unload clears the startup timer');
}

// Execute the actual captured call expressions, so drift in the native error
// protocol cannot silently invalidate this interception.
const nativeCalls = [
  {file: 'originals/static/js/canvas.325741a0.js',
    pattern: /console\.error\("\[Lovart Shell\] Failed to initialize:",e\)/, marker: 'bootstrap', variable: 'e'},
  {file: 'originals/static/js/async/lovart-canvas.358a3a91.js',
    pattern: /console\.error\("\[canvas-crash\]",t\)/, marker: 'canvas-crash', variable: 't'},
];
for (const {file, pattern, marker, variable} of nativeCalls) {
  const call = fs.readFileSync(path.join(root, file), 'utf8').match(pattern)?.[0];
  assert.ok(call, `The native ${marker} error call must exist`);
  const f = fixture(); f.context[variable] = privateError;
  assert.equal(vm.runInContext(call, f.context), f.consoleResult, 'Original console return is preserved');
  assert.equal(f.consoleCalls.length, 1);
  assert.equal(f.consoleCalls[0].receiver, f.consoleDouble, 'Original console receiver is preserved');
  assert.equal(f.consoleCalls[0].args[1], privateError, 'Original error object is preserved for the console');
  assert.equal(f.document.documentElement.dataset.novartNativeFailure, marker);
  assert.equal(f.dispatched.length, 1);
  assert.equal(f.dispatched[0].type, 'novart-native-failure');
  assert.equal('detail' in f.dispatched[0], false, 'Bridge event contains no error data');
  assert.equal(f.reports[1].boundary, true, 'Handled native crashes are visible to startup diagnostics');
  assert.equal(f.reports[1].errorName, 'TypeError');
  assert.deepEqual(f.reports[1].frames, ['app.123.js:1:55', 'native.456.js:2:77']);
  vm.runInContext(call, f.context);
  assert.equal(f.reports.length, 2, 'Repeated handled failures remain deduplicated');
  assertPrivate(f.reports);
}

{
  const f = fixture();
  for (const prefix of ['[canvas-crash] unrelated', '[Lovart Shell] Failed to initialize', 'ordinary error'])
    assert.equal(f.consoleDouble.error(prefix, privateError), f.consoleResult);
  assert.equal(f.consoleCalls.length, 3);
  assert.equal(f.reports.length, 1, 'Unrelated console output is not captured');
  assert.equal(f.document.documentElement.dataset.novartNativeFailure, undefined);
  const shell = fixture({pathname: '/studio'});
  shell.consoleDouble.error('[canvas-crash]', privateError);
  assert.equal(shell.reports.length, 1, 'Only the native canvas console is instrumented');
  assert.equal(shell.document.documentElement.dataset.novartNativeFailure, undefined);
}

{
  const originalThrow = new Error('PRIVATE_CONSOLE_FAILURE');
  const f = fixture({consoleThrows: originalThrow});
  assert.throws(() => f.consoleDouble.error('[canvas-crash]', privateError), error => error === originalThrow);
  assert.equal(f.consoleCalls.length, 1);
  assert.equal(f.reports.length, 1, 'Instrumentation does not replace an original console exception');
  assert.equal(f.document.documentElement.dataset.novartNativeFailure, undefined);
}

for (const property of ['stack', 'name']) {
  const f = fixture();
  const hostileError = {...privateError};
  Object.defineProperty(hostileError, property, {get() { throw new Error('PRIVATE_GETTER_FAILURE'); }});
  assert.equal(f.consoleDouble.error('[canvas-crash]', hostileError), f.consoleResult,
    'An error getter cannot make the console call fail');
  assert.equal(f.document.documentElement.dataset.novartNativeFailure, 'canvas-crash');
  assert.equal(f.dispatched.length, 1, 'Bridge still learns of a crash when diagnostic extraction fails');
  assertPrivate(f.reports);
}

{
  const f = fixture();
  assert.equal(f.reports[0].licenseRejected, false);
  f.nodes.set('[data-testid="tl-license-expired"]', {
    style: {display: 'none'}, textContent: 'PRIVATE_LICENSE_DATA_NOT_FOR_TELEMETRY'
  });
  f.listeners.get('novart-startup-check')();
  const event = f.reports.at(-1);
  assert.equal(event.licenseRejected, true, 'Hidden SDK license sentinel has a distinct structural flag');
  assert.equal(event.boundary, true, 'Silent SDK withdrawal cannot be reported as a healthy canvas');
  assert.equal(event.canvas, false);
  assert.equal(event.toolbar, false);
  assertPrivate(f.reports);
}

{
  const f = fixture();
  f.document.documentElement.getBoundingClientRect = () => { throw new Error('PRIVATE_SAMPLE_FAILURE'); };
  assert.equal(f.consoleDouble.error('[canvas-crash]', privateError), f.consoleResult);
  assert.equal(f.dispatched.length, 1, 'DOM diagnostic failures do not prevent the crash signal');
  assertPrivate(f.reports);
}

console.log('Startup diagnostic sender: privacy, bounds, cleanup and actual native handled-error interception passed.');
