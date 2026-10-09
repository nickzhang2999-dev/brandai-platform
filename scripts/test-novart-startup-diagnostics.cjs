// Run the real sender with private error text to enforce the telemetry boundary.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../previews/novart-workbench/harness/share-client.js'), 'utf8');
const listeners = new Map(), reports = [], timers = new Map(); let timerId = 0;
const nodes = new Map();
const document = {readyState: 'complete', documentElement: {getBoundingClientRect: () => ({width: 1200, height: 720})},
  querySelector: selector => nodes.get(selector) || null};
const navigator = {serviceWorker: {controller: {}}};
const window = {navigator, addEventListener(name, callback) { listeners.set(name, callback); }};
const location = {pathname: '/canvas', href: 'https://review.invalid/canvas?projectId=PRIVATE_PROJECT', origin: 'https://review.invalid'};
const context = {window, parent: {}, document, navigator, location, URL, AbortController,
  XMLHttpRequest: class { open() {} },
  setTimeout(callback, ms) { const id = ++timerId; timers.set(id, {callback, ms}); return id; },
  clearTimeout(id) { timers.delete(id); },
  fetch(url, options) { assert.equal(url, '/review/startup-diagnostics'); reports.push(JSON.parse(options.body)); return Promise.resolve({status: 202}); }};
vm.runInNewContext(source, context);
assert.equal(reports.length, 1); assert.equal(reports[0].role, 'canvas');
assert.equal(reports[0].embedded, true); assert.equal(reports[0].controlled, true);
const privateError = {name: 'TypeError', message: 'PRIVATE_TEXT PRIVATE_TOKEN',
  stack: 'TypeError: PRIVATE_TEXT PRIVATE_TOKEN\n at https://review.invalid/static/app.123.js:1:55?token=PRIVATE_TOKEN\n at https://review.invalid/native.456.js:2:77'};
listeners.get('error')({error: privateError, filename: location.href, lineno: 1, colno: 9});
assert.equal(reports[1].errorName, 'TypeError');
assert.deepEqual(reports[1].frames, ['app.123.js:1:55', 'native.456.js:2:77']);
listeners.get('error')({target: {tagName: 'SCRIPT', src: 'https://review.invalid/static/failed.js?token=PRIVATE_TOKEN'}});
assert.equal(reports[2].resource, 'failed.js');
assert.equal(JSON.stringify(reports).includes('PRIVATE_'), false, 'No private message, query or project identifier may be sent');
assert.equal(JSON.stringify(reports).includes('https://'), false, 'No complete source URL may be sent');
const before = reports.length; listeners.get('error')({error: privateError});
assert.equal(reports.length, before, 'Repeated failures must be deduplicated');
for (let i = 0; i < 20; i++) listeners.get('error')({error: {name: 'Error', stack: `at module.js:1:${i}`}});
assert.equal(reports.length, 8, 'A page may report at most eight events');
listeners.get('pagehide')();
assert.ok([...timers.values()].every(t => t.ms !== 22000), 'Unload clears the startup timer');
console.log('Startup diagnostic sender: privacy, deduplication, event cap and cleanup passed.');
